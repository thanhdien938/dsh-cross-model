import fs from 'fs';
import path from 'path';

// P0-4 remediation: prove the configured directory holds a genuine GitHub
// Actions runner registration, not merely that a file named `.runner`
// happens to exist there. This module is the ONLY place in the runner
// integration that ever calls fs.readFileSync — deliberately isolated from
// relayRunnerLifecycleManager.ts so that file's own boundary test (which
// asserts the lifecycle source never reads file *content*) stays a true
// statement about the lifecycle manager itself. This reader:
//   - opens exactly one file: `<runnerDir>/.runner` (a path this module
//     constructs itself; it never accepts a caller-supplied filename), so
//     it can never be redirected onto `.credentials` or
//     `.credentials_rsaparams`;
//   - only extracts a handful of bounded, non-secret identity fields
//     (the same fields the official GitHub Actions runner writes into
//     `.runner` on registration: agent name, pool id, server/repository
//     endpoint) — enough to prove "this is a coherent registration",
//     never enough to reconstruct a token or credential;
//   - never returns or logs the raw file content.
export interface RunnerRegistrationIdentity {
  agentName: string;
  poolId: number;
  serverUrl?: string;
  gitHubUrl?: string;
  serverUrlV2?: string;
}

export type RunnerRegistrationResult =
  | { ok: true; identity: RunnerRegistrationIdentity }
  | { ok: false; reason: string };

const MAX_FILE_BYTES = 16 * 1024;
const MAX_FIELD_LENGTH = 500;

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function isBoundedHttpsUrl(value: unknown): value is string {
  if (!isBoundedString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// Pure, dependency-free — exported so the exact validation rules (bounded
// lengths, required identity/pool/endpoint shape, rejection of malformed
// JSON) can be unit tested directly against fixture strings, without
// touching a filesystem.
export function parseRunnerRegistration(raw: string): RunnerRegistrationResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) return { ok: false, reason: 'RUNNER_REGISTRATION_TOO_LARGE' };
  let parsed: unknown;
  try {
    // GitHub Actions Runner writes `.runner` through its .NET persistence
    // helper. Real Windows registrations may therefore begin with the
    // standard UTF-8 BOM. Node preserves that marker as U+FEFF when reading
    // with `utf8`, while JSON.parse rejects it before examining the otherwise
    // valid RunnerSettings object. Strip exactly one leading BOM only; a BOM
    // anywhere else remains invalid JSON.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return { ok: false, reason: 'RUNNER_REGISTRATION_INVALID_JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'RUNNER_REGISTRATION_MALFORMED' };
  }
  const value = parsed as Record<string, unknown>;
  const { agentName, poolId, serverUrl, gitHubUrl, serverUrlV2 } = value;
  if (!isBoundedString(agentName)) return { ok: false, reason: 'RUNNER_REGISTRATION_MISSING_AGENT_NAME' };
  if (typeof poolId !== 'number' || !Number.isInteger(poolId)) return { ok: false, reason: 'RUNNER_REGISTRATION_MISSING_POOL_ID' };

  // RunnerSettings explicitly permits GitHubUrl to be absent/empty for JIT
  // registrations and then derives hosted-server identity from ServerUrl or
  // ServerUrlV2. Preserve that official alternative without accepting an
  // arbitrary endpoint alias: every supplied endpoint must be a bounded,
  // credential-free HTTPS URL, and at least one runner service endpoint
  // (classic or V2) must be present.
  const hasServerUrl = serverUrl !== undefined && serverUrl !== '';
  const hasGitHubUrl = gitHubUrl !== undefined && gitHubUrl !== '';
  const hasServerUrlV2 = serverUrlV2 !== undefined && serverUrlV2 !== '';
  if (hasServerUrl && !isBoundedHttpsUrl(serverUrl)) return { ok: false, reason: 'RUNNER_REGISTRATION_MISSING_SERVER_URL' };
  if (hasGitHubUrl && !isBoundedHttpsUrl(gitHubUrl)) return { ok: false, reason: 'RUNNER_REGISTRATION_MISSING_GITHUB_URL' };
  if (hasServerUrlV2 && !isBoundedHttpsUrl(serverUrlV2)) return { ok: false, reason: 'RUNNER_REGISTRATION_MISSING_SERVER_URL_V2' };
  if (!hasServerUrl && !hasServerUrlV2) return { ok: false, reason: 'RUNNER_REGISTRATION_MISSING_SERVER_URL' };

  return {
    ok: true,
    identity: {
      agentName,
      poolId,
      ...(hasServerUrl ? { serverUrl: serverUrl as string } : {}),
      ...(hasGitHubUrl ? { gitHubUrl: gitHubUrl as string } : {}),
      ...(hasServerUrlV2 ? { serverUrlV2: serverUrlV2 as string } : {}),
    },
  };
}

export function readRunnerRegistration(runnerDir: string): RunnerRegistrationResult {
  const filePath = path.join(runnerDir, '.runner');
  let raw: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { ok: false, reason: 'RUNNER_REGISTRATION_TOO_LARGE' };
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'RUNNER_REGISTRATION_UNREADABLE' };
  }
  return parseRunnerRegistration(raw);
}
