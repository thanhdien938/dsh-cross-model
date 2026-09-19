import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildProjectList } from '../electron/main/services/readProjection';
import { setResolvedRepoRoot } from '../electron/main/repoRoot';

describe('buildProjectList — R1-A per-project PATH MISSING', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-path-missing-'));
    fs.mkdirSync(path.join(root, 'repo-a'));
    // repo-b intentionally not created.
    // P12-R5A: buildProjectList() now dynamically imports
    // src/owner/autonomy-envelope.mjs via getRepoRoot() — point it at this
    // real checkout (two levels up from desktop/tests/) so that import
    // resolves in the test environment exactly as it does at runtime.
    setResolvedRepoRoot(path.resolve(__dirname, '..', '..'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setResolvedRepoRoot(null);
  });

  // P12-R5A: buildProjectList() became async so it can derive
  // pushRemotePolicy via the real normalizeAutonomyEnvelope() (imported
  // live from the runtime) — see readProjection.test.ts for dedicated
  // coverage of that new field. These pre-existing tests only needed
  // `await` added; every other assertion is unchanged.
  // P15-REM-R3-D (P15-A-005): buildProjectList() now returns
  // {projects, skipped} rather than a bare array — every existing assertion
  // below unwraps `.projects`; the new tests at the bottom cover `.skipped`.
  it('marks a project with an existing directory READY and a missing one PATH_MISSING, without dropping either', async () => {
    const doc = {
      projects: [
        { id: 'proj-a', repo_path: './repo-a' },
        { id: 'proj-b', repo_path: './repo-b' },
      ],
    };
    const { projects, skipped } = await buildProjectList(doc, root);
    expect(projects).toHaveLength(2);
    expect(skipped).toEqual([]);
    expect(projects.find((p) => p.id === 'proj-a')?.state).toBe('READY');
    expect(projects.find((p) => p.id === 'proj-b')?.state).toBe('PATH_MISSING');
    // The configured path is preserved verbatim — no repoint, no substitution.
    expect(projects.find((p) => p.id === 'proj-b')?.path).toBe(path.resolve(root, './repo-b'));
  });

  it('treats a path that exists but is a file, not a directory, as PATH_MISSING', async () => {
    fs.writeFileSync(path.join(root, 'not-a-dir'), 'x');
    const { projects } = await buildProjectList({ projects: [{ id: 'proj-c', repo_path: './not-a-dir' }] }, root);
    expect(projects[0].state).toBe('PATH_MISSING');
  });

  it('restoring the directory flips the project back to READY on the next read', async () => {
    const doc = { projects: [{ id: 'proj-b', repo_path: './repo-b' }] };
    expect((await buildProjectList(doc, root)).projects[0].state).toBe('PATH_MISSING');
    fs.mkdirSync(path.join(root, 'repo-b'));
    expect((await buildProjectList(doc, root)).projects[0].state).toBe('READY');
  });

  // P15-REM-R3-D (P15-A-005) — RED/GREEN: one malformed entry must not
  // erase unrelated valid entries.
  it('RED (mechanism): a non-string repo_path throws inside path.resolve() for that ONE entry', () => {
    expect(() => path.resolve(root, undefined as any)).toThrow();
  });

  it('GREEN: a malformed entry (non-string repo_path) is skipped, but valid entries before AND after it survive intact', async () => {
    const doc = {
      projects: [
        { id: 'proj-a', repo_path: './repo-a' },
        { id: 'proj-bad', repo_path: undefined },
        { id: 'proj-c', repo_path: './repo-a' },
      ],
    };
    const { projects, skipped } = await buildProjectList(doc, root);
    expect(projects.map((p) => p.id)).toEqual(['proj-a', 'proj-c']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ index: 1, id: 'proj-bad' });
    expect(skipped[0].reason).toBeTruthy();
  });

  it('GREEN: ALL entries malformed still returns an empty (never throwing) projects array with every entry recorded as skipped', async () => {
    const doc = { projects: [{ id: 'proj-x', repo_path: null }, { id: 'proj-y', repo_path: 42 }] };
    const { projects, skipped } = await buildProjectList(doc, root);
    expect(projects).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('GREEN: a malformed entry with no id at all is still recorded (id: null), never crashing the skip-reporting itself', async () => {
    const doc = { projects: [{ repo_path: undefined }] };
    const { skipped } = await buildProjectList(doc, root);
    expect(skipped).toEqual([{ index: 0, id: null, reason: expect.any(String) }]);
  });
});
