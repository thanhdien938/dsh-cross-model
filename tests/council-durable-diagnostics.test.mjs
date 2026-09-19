import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';

const path = 'src/synthetic.mjs';
const hash = 'a'.repeat(64);
const valid = { type: 'council_report', analysis: 'synthetic analysis', recommendation: 'pass', risks: [], uncertainties: [], evidence: [{ path, sha256: hash, line_start: null, line_end: null, claim: 'synthetic claim' }] };
const invalidEvidence = { ...valid, evidence: [{ path: 'private-source-sentinel', sha256: 'b'.repeat(64), claim: 'private-claim-sentinel' }] };

for (const repairSucceeds of [true, false]) {
  test(`four participant durable reports: repair ${repairSucceeds ? 'succeeds' : 'fails closed'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-'));
    const store = new SqlitePersistenceStore();
    try {
      await store.open({ path: join(dir, 'test.sqlite') });
      await store.migrate();
      const repository = new WorkflowRepository({ store });
      const stepState = new DurableWorkflowState({ repository });
      const calls = new Map();
      const project = { id: 'synthetic', repo_path: dir };
      const runner = new CouncilStepWorkflowRunner({ project, stepState,
        profileRegistry: { get: id => ({ id, product: 'antigravity' }) },
        resolveDriver: (profile) => createCliPmDriver({ profile: { ...profile, product: 'codex' }, project,
          run: async () => {
            const n = calls.get(profile.id) ?? 0; calls.set(profile.id, n + 1);
            const data = profile.id !== 'p4' ? valid : n === 0 ? {} : repairSucceeds ? valid : invalidEvidence;
            return JSON.stringify({ type: 'finish', output: 'synthetic-output-sentinel', data });
          },
        }),
      });
      for (const profileId of ['p1', 'p2', 'p3', 'p4']) {
        const id = `synthetic-${profileId}`;
        const outcome = await runner.run({ id, kind: 'council_step', stepKind: 'participant_report', round: 1, profileId, prompt: 'synthetic', workspaceRequirement: 'READ', workspaceEvidencePaths: [path], workspaceEvidenceHashes: { [path]: hash } });
        const handoff = outcome.finalResult.handoff;
        const persisted = repository.getWorkflow(id).steps[0].dispatchedContext;
        assert.deepEqual(persisted, JSON.parse(JSON.stringify(outcome.finalResult)));
        assert.equal(handoff.ok, profileId !== 'p4' || repairSucceeds);
        assert.equal(calls.get(profileId), profileId === 'p4' ? 2 : 1);
        assert.equal(persisted.handoff.structured_output.provider, 'antigravity');
        assert.ok(persisted.handoff.attempts.every(a => a.structured_output_requested && a.structured_output_applied));
        if (profileId === 'p4') {
          assert.equal(handoff.semantic_repair_used, true);
          assert.equal(handoff.original_failure.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:WRONG_DATA_TYPE:missing');
          assert.equal(handoff.attempts.length, 2);
          assert.ok(handoff.attempts.every(a => a.ok));
          if (!repairSucceeds) {
            assert.equal(handoff.reason, 'COUNCIL_PARTICIPANT_REPORT_INVALID:NO_VALID_EVIDENCE_ENTRIES');
            assert.equal(handoff.data_diagnostics, handoff.repaired_failure.data_diagnostics);
            assert.equal(handoff.evidence_diagnostics, handoff.repaired_failure.evidence_diagnostics);
            assert.deepEqual(persisted.handoff.repaired_failure, handoff.repaired_failure);
          }
          const diagnostics = JSON.stringify([handoff.original_failure, handoff.repaired_failure ?? null, handoff.attempts]);
          for (const sentinel of [path, hash, 'b'.repeat(64), 'private-source-sentinel', 'private-claim-sentinel', 'synthetic-output-sentinel', 'synthetic analysis', 'prior_data']) assert.ok(!diagnostics.includes(sentinel));
        }
      }
      // A true cycle must fail before mutation at the same production boundary.
      const before = repository.getWorkflow('synthetic-p1').steps[0];
      const cycle = {}; cycle.self = cycle;
      assert.throws(() => repository.updateStepStatus('synthetic-p1', before.id, { dispatchedContext: cycle }), { code: 'NOT_JSON_FAITHFUL' });
      assert.deepEqual(repository.getWorkflow('synthetic-p1').steps[0], before);
      const fresh = new CouncilStepWorkflowRunner({ project, stepState, resolveDriver: () => { throw new Error('must not replay'); } });
      assert.deepEqual(fresh.result('synthetic-p4').finalResult, repository.getWorkflow('synthetic-p4').steps[0].dispatchedContext);
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
