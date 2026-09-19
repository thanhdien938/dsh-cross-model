import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { parse, stringify } from 'yaml';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NETWORK_PATH_PATTERN = /^(\\\\|\/\/|smb:|nfs:)/i;

export interface GitFacts {
  isGitRepo: boolean;
  root: string | null;
  branch: string | null;
  detachedHead: boolean;
  dirtyCount: number | null;
  hasRemote: boolean | null;
  repoName: string | null;
}

export type GitRunner = (args: string[], cwd: string) => { ok: boolean; stdout: string };

function defaultGitRunner(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

// Read-only Git observation only — no Git write action is ever issued from
// the Desktop (W2-I). Every call is a plain, non-mutating `git` subcommand.
export function gatherGitFacts(repoPath: string, run: GitRunner = defaultGitRunner): GitFacts {
  const inside = run(['rev-parse', '--is-inside-work-tree'], repoPath);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { isGitRepo: false, root: null, branch: null, detachedHead: false, dirtyCount: null, hasRemote: null, repoName: null };
  }
  const root = run(['rev-parse', '--show-toplevel'], repoPath);
  const branchResult = run(['branch', '--show-current'], repoPath);
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  const status = run(['status', '--porcelain'], repoPath);
  const dirtyCount = status.ok ? status.stdout.split('\n').filter((line) => line.trim().length > 0).length : null;
  const remote = run(['remote'], repoPath);
  const hasRemote = remote.ok ? remote.stdout.trim().length > 0 : null;
  const rootPath = root.ok ? root.stdout.trim() : null;
  return {
    isGitRepo: true,
    root: rootPath,
    branch: branch || null,
    detachedHead: branch === '',
    dirtyCount,
    hasRemote,
    repoName: rootPath ? path.basename(rootPath) : null,
  };
}

export function proposeProjectId(folderPath: string, taken: Set<string> = new Set()): string {
  const base = path
    .basename(folderPath)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  const candidateBase = PROJECT_ID_PATTERN.test(base) ? base : `project-${crypto.randomBytes(3).toString('hex')}`;
  if (!taken.has(candidateBase)) return candidateBase;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${candidateBase}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${candidateBase}-${crypto.randomBytes(3).toString('hex')}`;
}

export function isNetworkPath(value: string): boolean {
  return NETWORK_PATH_PATTERN.test(value);
}

interface ProjectYamlEntry {
  id: string;
  display_name?: string;
  repo_path: string;
  default_pm_profile_id: string;
  autonomy?: unknown;
}

export type ConfigValidator = (configPath: string) => Promise<{ ok: boolean; code?: string; message?: string }>;

export function createNodeConfigValidator(nodeBin: string, validatorScriptPath: string): ConfigValidator {
  return (configPath: string) =>
    new Promise((resolve) => {
      const child = spawn(nodeBin, [validatorScriptPath, '--config', configPath], { windowsHide: true });
      let stdout = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.on('error', () => resolve({ ok: false, code: 'CONFIG_VALIDATION_FAILED', message: 'validator failed to start' }));
      child.on('close', () => {
        try {
          const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
          resolve(JSON.parse(lastLine));
        } catch {
          resolve({ ok: false, code: 'CONFIG_VALIDATION_FAILED', message: 'validator produced no parseable output' });
        }
      });
    });
}

export interface AddFolderRequest {
  folderPath: string;
  displayName?: string;
  defaultPmProfileId: string;
  force?: boolean;
}

export type AddFolderResult =
  | { ok: true; projectId: string; git: GitFacts }
  | { ok: false; code: string; message: string; existingProjectId?: string };

// Implements the canonical W2-I flow:
//   realpath -> validate -> git facts -> propose id -> duplicate check
//   -> candidate config -> atomic write -> production loader revalidation
//   -> (caller) graceful runtime restart.
// Config mutation follows W2-J: temp file + atomic rename with a
// pre-swap backup, and old config is restored verbatim on any validation
// failure so a corrupt/half-written YAML is never left on disk.
export class ProjectRegistryService {
  constructor(
    private readonly projectsYamlPath: string,
    private readonly fullConfigPath: string,
    private readonly validateConfig: ConfigValidator,
    private readonly runGit: GitRunner = defaultGitRunner,
  ) {}

  listExisting(): ProjectYamlEntry[] {
    const doc = this.readProjectsDocument();
    return doc.projects ?? [];
  }

  async addFolder(request: AddFolderRequest): Promise<AddFolderResult> {
    let real: string;
    try {
      real = fs.realpathSync(request.folderPath);
    } catch {
      return { ok: false, code: 'PROJECT_PATH_INVALID', message: 'folder does not exist or is not readable' };
    }
    if (!fs.statSync(real).isDirectory()) return { ok: false, code: 'PROJECT_PATH_INVALID', message: 'not a directory' };
    if (isNetworkPath(real)) return { ok: false, code: 'PROJECT_PATH_INVALID', message: 'network paths are not supported' };

    const existing = this.listExisting();
    const duplicate = existing.find((p) => safeRealpath(p.repo_path) === real);
    if (duplicate && !request.force) {
      return { ok: false, code: 'DUPLICATE_PROJECT_PATH', message: `this folder is already registered as project "${duplicate.id}"`, existingProjectId: duplicate.id };
    }

    const facts = gatherGitFacts(real, this.runGit);
    const projectId = proposeProjectId(real, new Set(existing.map((p) => p.id)));
    const doc = this.readProjectsDocument();
    const nextEntry: ProjectYamlEntry = {
      id: projectId,
      display_name: request.displayName || facts.repoName || path.basename(real),
      repo_path: real,
      default_pm_profile_id: request.defaultPmProfileId,
      autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', REQUEST_CANCEL: 'ALLOW', BRANCH_CREATE: 'APPROVAL', MERGE_MAIN: 'APPROVAL', PUSH_REMOTE: 'APPROVAL' } },
    };
    const candidate = { ...doc, projects: [...(doc.projects ?? []), nextEntry] };

    const written = this.writeAtomicWithBackup(stringify(candidate));
    const validation = await this.validateConfig(this.fullConfigPath);
    if (!validation.ok) {
      this.restoreBackup(written.backupPath);
      return { ok: false, code: validation.code ?? 'CONFIG_VALIDATION_FAILED', message: validation.message ?? 'configuration failed revalidation' };
    }
    this.discardBackup(written.backupPath);
    return { ok: true, projectId, git: facts };
  }

  private readProjectsDocument(): { projects?: ProjectYamlEntry[] } {
    if (!fs.existsSync(this.projectsYamlPath)) return { projects: [] };
    return (parse(fs.readFileSync(this.projectsYamlPath, 'utf8')) ?? { projects: [] }) as { projects?: ProjectYamlEntry[] };
  }

  private writeAtomicWithBackup(content: string): { backupPath: string | null } {
    const dir = path.dirname(this.projectsYamlPath);
    const tmpPath = path.join(dir, `.projects.yaml.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, content, 'utf8');
    const fd = fs.openSync(tmpPath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    let backupPath: string | null = null;
    if (fs.existsSync(this.projectsYamlPath)) {
      backupPath = path.join(dir, `.projects.yaml.bak-${process.pid}-${Date.now()}`);
      fs.copyFileSync(this.projectsYamlPath, backupPath);
    }
    fs.renameSync(tmpPath, this.projectsYamlPath); // atomic on the same filesystem
    return { backupPath };
  }

  private restoreBackup(backupPath: string | null): void {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, this.projectsYamlPath);
      fs.unlinkSync(backupPath);
    } else if (!backupPath) {
      fs.rmSync(this.projectsYamlPath, { force: true });
    }
  }

  private discardBackup(backupPath: string | null): void {
    if (backupPath && fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  }
}

function safeRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}
