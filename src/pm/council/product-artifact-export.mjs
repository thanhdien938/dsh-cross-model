// P24.2: product-only projection of completed durable Council/Debate stages.
// No provider calls, Git writes, clocks, or mutation of artifact authorities.
import { mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAndVerifySealedReference } from '../../artifacts/artifact-recovery.mjs';
import { canonicalArtifactRefIdentity } from '../../artifacts/artifact-schema.mjs';
import { councilStageKeyPlan } from './council-artifact-stage-keys.mjs';
import { normalizeCouncilSpec } from './council-contracts.mjs';
import { verifyCouncilArtifactTopology, verifyDebateArtifactTopology } from './council-artifact-orchestrator.mjs';
import { gitBlobSha1 } from '../workspace-output-materializer.mjs';

export class ProductArtifactExportError extends Error {
  constructor(message) { super(message); this.name = 'ProductArtifactExportError'; this.code = 'PRODUCT_ARTIFACT_EXPORT_FAILED'; }
}
const fail = (message) => { throw new ProductArtifactExportError(message); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const safeRef = (ref) => Object.fromEntries(['schema_version', 'store_id', 'project_id', 'task_id',
  'invocation_id', 'attempt_ordinal', 'artifact_relpath', 'sha256', 'bytes', 'sealed_at'].map(key => [key, ref[key]]));
function segment(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) fail('unsafe package path segment');
  return value;
}
function stat(path) { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function safePath(root, relative) {
  let path = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:]/.test(part)) fail('unsafe export path');
    path = join(path, part);
    if (stat(path)?.isSymbolicLink()) fail('symlink/junction in product export path');
  }
  return path;
}

/** Build all bytes before touching the target repo. Durable PM handoffs are
 * the success/failure authority; a sealed file alone never implies acceptance.
 * Reuse the production topology gates, including continuation/attempt binding.
 */
export function buildProductArtifactPackage({ store, taskId, projectId, baseSha = null, run }) {
  segment(taskId);
  if (!store || store.projectId !== projectId || run?.status !== 'completed') fail('completed run and matching artifact store required');
  const task = store.openTaskById(taskId);
  const manifest = task?.freshManifest();
  if (!manifest || manifest.task_state !== 'COMPLETED' || manifest.artifact_gate_state !== 'TASK_ARTIFACT_PASS') fail('task product package is not complete');
  if (!manifest.council_control) fail('Council control required');
  const council = normalizeCouncilSpec(manifest.council_control);
  const participants = council.participant_profile_ids;
  const outcomes = new Map(), aliases = new Map(), aliasOwners = new Map();
  for (const turn of run.turns ?? []) {
    const h = turn.outcome?.finalResult?.handoff;
    if (h?.transport_version !== 'artifact_v1') continue;
    if (turn.phase !== 'TURN_COMPLETE' || ![council.chair_profile_id, ...participants].includes(h.profile_id)) fail('unexpected product outcome authority');
    if (outcomes.has(h.stage_key)) fail('duplicate durable stage outcome');
    segment(h.actor_alias);
    const owner = aliasOwners.get(h.actor_alias.toLowerCase());
    if (owner && owner !== h.profile_id) fail('participant alias collision');
    if (aliases.has(h.profile_id) && aliases.get(h.profile_id) !== h.actor_alias) fail('profile alias changed across stages');
    aliases.set(h.profile_id, h.actor_alias); aliasOwners.set(h.actor_alias.toLowerCase(), h.profile_id);
    outcomes.set(h.stage_key, h);
  }
  const reports = new Map(), critiques = new Map(), rounds = new Map();
  let chairPlan, synthesis;
  for (const h of outcomes.values()) {
    if (h.step_kind === 'chair_plan') chairPlan = h;
    else if (h.step_kind === 'chair_synthesis') synthesis = h;
    else if (h.step_kind === 'participant_report') reports.set(h.profile_id, h);
    else if (h.step_kind === 'participant_critique') critiques.set(h.profile_id, h);
    else if (['debate_brief', 'debate_response', 'debate_synthesis'].includes(h.step_kind)) {
      if (!rounds.has(h.round)) rounds.set(h.round, { round: h.round, responses: new Map() });
      const r = rounds.get(h.round);
      if (h.step_kind === 'debate_response') r.responses.set(h.profile_id, h);
      else r[h.step_kind === 'debate_brief' ? 'brief' : 'synthesis'] = h;
    } else fail('unknown stage in durable product history');
  }
  const gateArgs = { store, task, council, participants, aliasRegistry: aliases, chairPlanOutcome: chairPlan,
    reportOutcomes: reports, critiqueOutcomes: critiques, synthesisOutcome: synthesis,
    stageKeyPlan: councilStageKeyPlan({ rounds: council.rounds, participantAliases: participants.map(id => aliases.get(id)) }) };
  const checked = verifyCouncilArtifactTopology(gateArgs);
  const debate = council.debate.enabled;
  const orderedRounds = [...rounds.values()].sort((a, b) => a.round - b.round);
  const final = debate ? verifyDebateArtifactTopology({ ...gateArgs, roster: checked.successfulReports, rounds: orderedRounds, councilGateArgs: gateArgs }) : { finalRef: synthesis.sealed_ref };
  if (!debate && rounds.size) fail('unexpected Debate products');
  for (const ref of [manifest.final_ref, run.data?.final_ref]) {
    if (!ref || canonicalArtifactRefIdentity(ref) !== canonicalArtifactRefIdentity(final.finalRef)) fail('final product authority mismatch');
  }
  const prefix = `reports/dsh-tasks/${taskId}`;
  const files = new Map(), artifacts = [], stageOutcomes = [], continuation = [];
  const add = (path, bytes) => {
    const full = `${prefix}/${path}`;
    if ([...files.keys()].some(k => k.toLowerCase() === full.toLowerCase())) fail('stage export collision');
    files.set(full, bytes); return full;
  };
  // Preserve sealed bytes in Git even in CRLF/autocrlf or filtered repos.
  add('.gitattributes', Buffer.from('* -text -filter -ident\n'));
  for (const h of [...outcomes.values()].sort((a, b) => a.stage_key < b.stage_key ? -1 : a.stage_key > b.stage_key ? 1 : 0)) {
    const status = h.ok ? 'SUCCESS' : 'FAILED';
    stageOutcomes.push({ stage_key: h.stage_key, stage_kind: h.artifact_stage, round: h.round ?? null,
      profile_id: h.profile_id, actor_alias: h.actor_alias, status,
      // Never copy error prose or unrestricted logs into a product manifest.
      failure_code: !h.ok && /^[A-Z][A-Z0-9_]{0,119}$/.test(h.failure_code ?? '') ? h.failure_code : null });
    if (!h.ok) continue;
    const v = resolveAndVerifySealedReference({ store, reference: h.sealed_ref });
    new TextDecoder('utf-8', { fatal: true }).decode(v.buffer);
    const destinations = {
      chair_plan: 'chair/plan.md', chair_synthesis: 'chair/synthesis.md',
      participant_report: `participants/${h.actor_alias}/round-1-report.md`,
      participant_critique: `participants/${h.actor_alias}/round-2-critique.md`,
      debate_brief: `debate/round-${String(h.round).padStart(2, '0')}/chair-brief.md`,
      debate_response: `debate/round-${String(h.round).padStart(2, '0')}/participants/${h.actor_alias}.md`,
      debate_synthesis: `debate/round-${String(h.round).padStart(2, '0')}/chair-synthesis.md`,
    };
    const exportPath = add(destinations[h.step_kind], v.buffer);
    artifacts.push({ stage_kind: h.artifact_stage, round: h.round ?? (h.step_kind === 'participant_report' ? 1 : h.step_kind === 'participant_critique' ? 2 : null),
      profile_id: h.profile_id, actor_alias: h.actor_alias, source_artifact_ref: safeRef(h.sealed_ref),
      source_sha256: v.sha256, export_path: exportPath, export_sha256: sha(v.buffer), bytes: v.bytes, status });
    if (h.step_kind === 'debate_synthesis') {
      const c = v.invocationRecord.debate_continuation;
      const record = { round: h.round, continue_debate: c.continue_debate, invocation_id: c.invocation_id,
        attempt_ordinal: c.attempt_ordinal, engine_forced_stop: h.round === final.finalRound && final.engineForcedStop };
      continuation.push(record);
      add(`debate/round-${String(h.round).padStart(2, '0')}/continuation.json`, json(record));
    }
  }
  const document = { schema_version: 1, task_id: taskId, project_id: projectId, mode: debate ? 'DEBATE' : 'COUNCIL',
    status: 'COMPLETED', base_sha: baseSha, generated_at: manifest.final_ref.sealed_at,
    chair_profile_id: council.chair_profile_id, final_artifact_ref: safeRef(final.finalRef),
    quorum: checked.successfulReports.length === participants.length ? 'full_quorum' : 'degraded',
    participants: participants.map(profile_id => ({ profile_id, actor_alias: aliases.get(profile_id),
      application_outcome: reports.get(profile_id)?.ok ? 'ACCEPTED' : 'FAILED',
      stage_artifacts: artifacts.filter(a => a.profile_id === profile_id),
      stage_outcomes: stageOutcomes.filter(a => a.profile_id === profile_id) })),
    artifacts, stage_outcomes: stageOutcomes,
    debate: debate ? { rounds_run: final.roundsRun, max_rounds: council.debate.max_rounds, continuation } : null };
  add('manifest.json', json(document));
  return { prefix, files, manifest: document };
}

/** Existing identical files are crash-replay evidence; any other existing
 * content fails closed. Exclusive creation cannot overwrite a file or link.
 */
export function materializeProductArtifactPackage({ repoRoot, ...args }) {
  const pkg = buildProductArtifactPackage(args);
  const root = realpathSync(resolve(repoRoot));
  const packagePath = safePath(root, pkg.prefix);
  const walk = (path, relative) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const rel = `${relative}/${entry.name}`, abs = safePath(root, rel);
      if (entry.isDirectory()) walk(abs, rel);
      else if (!pkg.files.has(rel)) fail('unexpected existing file in task package');
    }
  };
  if (stat(packagePath)) walk(packagePath, pkg.prefix);
  // Preflight every collision before the first write.
  for (const [rel, buffer] of pkg.files) {
    const path = safePath(root, rel), s = stat(path);
    if (s && (!s.isFile() || s.nlink !== 1 || !readFileSync(path).equals(buffer))) fail('conflicting existing task product');
  }
  for (const [rel, buffer] of pkg.files) {
    const parts = rel.split('/'); parts.pop();
    let parent = '';
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      const path = safePath(root, parent);
      if (!stat(path)) mkdirSync(path);
      if (!stat(path)?.isDirectory()) fail('export parent is not a directory');
    }
    const path = safePath(root, rel);
    if (!stat(path)) writeFileSync(path, buffer, { flag: 'wx' });
    if (!readFileSync(path).equals(buffer)) fail('export bytes changed');
  }
  return { ...pkg, blobs: [...pkg.files].map(([path, buffer]) => ({ path, blobSha1: gitBlobSha1(buffer) })) };
}
