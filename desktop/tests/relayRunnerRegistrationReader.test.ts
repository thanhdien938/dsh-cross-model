import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseRunnerRegistration, readRunnerRegistration } from '../electron/main/services/relayRunnerRegistrationReader';

const VALID = JSON.stringify({
  agentId: 5,
  agentName: 'dsh-relay-01',
  poolId: 1,
  poolName: 'Default',
  serverUrl: 'https://pipelines.actions.githubusercontent.com/abc123',
  gitHubUrl: 'https://github.com/example/repo',
  workFolder: '_work',
});

const REAL_WINDOWS_2337_SHAPE = `\uFEFF${JSON.stringify({
  agentId: 17,
  agentName: 'sanitized-runner',
  poolId: 1,
  poolName: 'Default',
  serverUrl: 'https://pipelines.actions.githubusercontent.com/sanitized',
  gitHubUrl: 'https://github.com/example/repository',
  workFolder: '_work',
  useV2Flow: true,
  serverUrlV2: 'https://broker.actions.githubusercontent.com',
})}`;

describe('P0-4: .runner structural registration validation', () => {
  it('7. a valid structural registration is accepted', () => {
    const result = parseRunnerRegistration(VALID);
    expect(result).toEqual({
      ok: true,
      identity: { agentName: 'dsh-relay-01', poolId: 1, serverUrl: 'https://pipelines.actions.githubusercontent.com/abc123', gitHubUrl: 'https://github.com/example/repo' },
    });
  });

  it('7b. accepts the sanitized real Windows 2.337.0 lower-camel schema with a UTF-8 BOM', () => {
    expect(parseRunnerRegistration(REAL_WINDOWS_2337_SHAPE)).toEqual({
      ok: true,
      identity: {
        agentName: 'sanitized-runner',
        poolId: 1,
        serverUrl: 'https://pipelines.actions.githubusercontent.com/sanitized',
        gitHubUrl: 'https://github.com/example/repository',
        serverUrlV2: 'https://broker.actions.githubusercontent.com',
      },
    });
  });

  it('7c. accepts the official JIT/V2 endpoint shape when gitHubUrl is empty', () => {
    const result = parseRunnerRegistration(JSON.stringify({
      agentName: 'jit-runner',
      poolId: 1,
      gitHubUrl: '',
      useV2Flow: true,
      serverUrlV2: 'https://broker.actions.githubusercontent.com',
    }));
    expect(result).toEqual({
      ok: true,
      identity: { agentName: 'jit-runner', poolId: 1, serverUrlV2: 'https://broker.actions.githubusercontent.com' },
    });
  });

  it('8. an empty .runner is INVALID', () => {
    expect(parseRunnerRegistration('')).toMatchObject({ ok: false });
  });

  it('9. malformed JSON is INVALID', () => {
    expect(parseRunnerRegistration('{not valid json')).toEqual({ ok: false, reason: 'RUNNER_REGISTRATION_INVALID_JSON' });
  });

  it('9b. a JSON array (not an object) is INVALID', () => {
    expect(parseRunnerRegistration('[1,2,3]')).toEqual({ ok: false, reason: 'RUNNER_REGISTRATION_MALFORMED' });
  });

  it.each([
    ['agentName', { agentName: undefined }],
    ['poolId', { poolId: undefined }],
    ['serverUrl', { serverUrl: undefined }],
  ])('10. missing %s is INVALID', (_field, patch) => {
    const parsed = { ...JSON.parse(VALID), ...patch };
    const result = parseRunnerRegistration(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
  });

  it('10b. a non-https serverUrl is INVALID (not merely non-empty)', () => {
    const parsed = { ...JSON.parse(VALID), serverUrl: 'not-a-url' };
    expect(parseRunnerRegistration(JSON.stringify(parsed)).ok).toBe(false);
  });

  it.each([
    ['serverUrl', { serverUrl: 'http://pipelines.actions.githubusercontent.com/sanitized' }],
    ['gitHubUrl', { gitHubUrl: 'https:///' }],
    ['serverUrlV2', { serverUrlV2: 'javascript:alert(1)' }],
    ['null endpoint', { serverUrlV2: null }],
    ['credential-bearing URL', { serverUrl: 'https://user:password@actions.githubusercontent.com/sanitized' }],
  ])('10c. invalid %s endpoint shape is rejected', (_field, patch) => {
    expect(parseRunnerRegistration(JSON.stringify({ ...JSON.parse(VALID), ...patch })).ok).toBe(false);
  });

  it('10d. an overlong field is INVALID (bounded, not unbounded)', () => {
    const parsed = { ...JSON.parse(VALID), agentName: 'x'.repeat(10_000) };
    expect(parseRunnerRegistration(JSON.stringify(parsed)).ok).toBe(false);
  });

  it('10e. an oversized file body is rejected before JSON.parse', () => {
    expect(parseRunnerRegistration('x'.repeat(20_000))).toEqual({ ok: false, reason: 'RUNNER_REGISTRATION_TOO_LARGE' });
  });

  it('10f. an empty object has no coherent runner identity', () => {
    expect(parseRunnerRegistration('{}')).toEqual({ ok: false, reason: 'RUNNER_REGISTRATION_MISSING_AGENT_NAME' });
  });

  it('10g. a near-miss arbitrary endpoint alias is rejected', () => {
    expect(parseRunnerRegistration(JSON.stringify({
      agentName: 'spoofed-runner',
      poolId: 1,
      endpointUrl: 'https://actions.githubusercontent.com',
    }))).toEqual({ ok: false, reason: 'RUNNER_REGISTRATION_MISSING_SERVER_URL' });
  });
});

describe('P0-4: readRunnerRegistration filesystem boundary', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-fixture-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads exactly `.runner` and validates its structure', () => {
    fs.writeFileSync(path.join(dir, '.runner'), VALID);
    expect(readRunnerRegistration(dir)).toMatchObject({ ok: true });
  });

  it('a missing `.runner` is UNREADABLE, not a thrown exception', () => {
    expect(readRunnerRegistration(dir)).toEqual({ ok: false, reason: 'RUNNER_REGISTRATION_UNREADABLE' });
  });

  it('22. never opens .credentials or .credentials_rsaparams, even if present alongside .runner', () => {
    fs.writeFileSync(path.join(dir, '.runner'), VALID);
    fs.writeFileSync(path.join(dir, '.credentials'), 'SECRET_TOKEN_SHOULD_NEVER_BE_READ');
    fs.writeFileSync(path.join(dir, '.credentials_rsaparams'), 'SECRET_RSA_SHOULD_NEVER_BE_READ');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const result = readRunnerRegistration(dir);
      expect(result).toMatchObject({ ok: true });
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(readSpy).toHaveBeenCalledWith(path.join(dir, '.runner'), 'utf8');
      expect(JSON.stringify(result)).not.toMatch(/SECRET_/);
    } finally {
      readSpy.mockRestore();
    }
  });
});
