import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';
import { ProjectRegistryService, proposeProjectId, gatherGitFacts, isNetworkPath, GitRunner } from '../electron/main/services/projectRegistry';

const fakeGitRunner: GitRunner = (args) => {
  if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return { ok: true, stdout: 'true\n' };
  if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { ok: true, stdout: 'C:/repo\n' };
  if (args[0] === 'branch') return { ok: true, stdout: 'main\n' };
  if (args[0] === 'status') return { ok: true, stdout: ' M file.txt\n?? new.txt\n' };
  if (args[0] === 'remote') return { ok: true, stdout: 'origin\n' };
  return { ok: false, stdout: '' };
};

describe('proposeProjectId', () => {
  it('slugifies a folder name into a valid project id', () => {
    expect(proposeProjectId('C:/repos/My Cool Project!!')).toBe('my-cool-project');
  });
  it('avoids collisions with existing ids', () => {
    expect(proposeProjectId('C:/repos/dup', new Set(['dup']))).toBe('dup-2');
  });
});

describe('gatherGitFacts', () => {
  it('reports observational facts only, never mutating', () => {
    const facts = gatherGitFacts('C:/repo', fakeGitRunner);
    expect(facts).toEqual({ isGitRepo: true, root: 'C:/repo', branch: 'main', detachedHead: false, dirtyCount: 2, hasRemote: true, repoName: 'repo' });
  });
  it('reports non-repo folders honestly', () => {
    const facts = gatherGitFacts('C:/not-a-repo', () => ({ ok: false, stdout: '' }));
    expect(facts.isGitRepo).toBe(false);
  });
});

describe('isNetworkPath', () => {
  it('rejects UNC and smb/nfs paths', () => {
    expect(isNetworkPath('\\\\server\\share')).toBe(true);
    expect(isNetworkPath('smb://server/share')).toBe(true);
    expect(isNetworkPath('C:/local/path')).toBe(false);
  });
});

describe('ProjectRegistryService.addFolder', () => {
  let root: string;
  let projectsPath: string;
  let configPath: string;
  let folder: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-registry-'));
    projectsPath = path.join(root, 'projects.yaml');
    configPath = path.join(root, 'config.yaml');
    folder = path.join(root, 'new-repo');
    fs.mkdirSync(folder);
    fs.writeFileSync(projectsPath, 'projects: []\n');
    fs.writeFileSync(configPath, 'mode: production\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('atomically appends a validated project and never repoints an existing id', async () => {
    const service = new ProjectRegistryService(projectsPath, configPath, async () => ({ ok: true }), fakeGitRunner);
    const result = await service.addFolder({ folderPath: folder, defaultPmProfileId: 'pm-a' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const doc = parse(fs.readFileSync(projectsPath, 'utf8'));
    expect(doc.projects).toHaveLength(1);
    expect(doc.projects[0].id).toBe(result.projectId);
    expect(doc.projects[0].repo_path).toBe(fs.realpathSync(folder));
    // No .tmp/.bak files left behind.
    expect(fs.readdirSync(root).filter((f) => f.includes('.tmp-') || f.includes('.bak-'))).toHaveLength(0);
  });

  it('restores the exact prior config verbatim when production revalidation fails', async () => {
    const before = fs.readFileSync(projectsPath, 'utf8');
    const service = new ProjectRegistryService(projectsPath, configPath, async () => ({ ok: false, code: 'CONFIG_VALIDATION_FAILED', message: 'nope' }), fakeGitRunner);
    const result = await service.addFolder({ folderPath: folder, defaultPmProfileId: 'pm-a' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('CONFIG_VALIDATION_FAILED');
    expect(fs.readFileSync(projectsPath, 'utf8')).toBe(before);
    expect(fs.readdirSync(root).filter((f) => f.includes('.tmp-') || f.includes('.bak-'))).toHaveLength(0);
  });

  it('warns on a duplicate repo path instead of silently merging identities', async () => {
    const service = new ProjectRegistryService(projectsPath, configPath, async () => ({ ok: true }), fakeGitRunner);
    const first = await service.addFolder({ folderPath: folder, defaultPmProfileId: 'pm-a' });
    expect(first.ok).toBe(true);
    const second = await service.addFolder({ folderPath: folder, defaultPmProfileId: 'pm-a' });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.code).toBe('DUPLICATE_PROJECT_PATH');
    if (!first.ok) throw new Error('unreachable');
    expect(second.existingProjectId).toBe(first.projectId);
  });

  it('force:true may register the same repo path under a second id after the warning', async () => {
    const service = new ProjectRegistryService(projectsPath, configPath, async () => ({ ok: true }), fakeGitRunner);
    const first = await service.addFolder({ folderPath: folder, defaultPmProfileId: 'pm-a' });
    const second = await service.addFolder({ folderPath: folder, defaultPmProfileId: 'pm-a', force: true });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.projectId).not.toBe(first.projectId);
    const doc = parse(fs.readFileSync(projectsPath, 'utf8'));
    expect(doc.projects).toHaveLength(2);
  });

  it('rejects a missing folder without touching the config', async () => {
    const before = fs.readFileSync(projectsPath, 'utf8');
    const service = new ProjectRegistryService(projectsPath, configPath, async () => ({ ok: true }), fakeGitRunner);
    const result = await service.addFolder({ folderPath: path.join(root, 'does-not-exist'), defaultPmProfileId: 'pm-a' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('PROJECT_PATH_INVALID');
    expect(fs.readFileSync(projectsPath, 'utf8')).toBe(before);
  });
});
