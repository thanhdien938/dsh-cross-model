// Research only. Never returns response content or parsed decision values.
import { createHash } from 'node:crypto';
import { normalizePmDecision, PM_DECISION_TYPES } from '../../../src/pm/pm-contracts.mjs';
const bytes = x => Buffer.byteLength(x, 'utf8');
const hash = x => createHash('sha256').update(x).digest('hex');
const type = x => x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x;
const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}` : JSON.stringify(x);
const shape = x => Array.isArray(x) ? ['array', [...new Set(x.map(v => canonical(shape(v))))].sort()] : x && typeof x === 'object' ? ['object', Object.keys(x).sort().map(k => [k, shape(x[k])])] : type(x);
const contract = x => { try { normalizePmDecision(x); return true; } catch { return false; } };
const shaped = x => x?.type === 'finish' ? typeof x.output === 'string' && !!x.output.trim() : x?.type === 'await_owner' || contract(x);

// Exact subset used by participant_critique; unknown keywords fail the diagnostic.
export function matchesSchema(x, s) {
  if (Object.keys(s).some(k => !['type','const','required','properties','items','minLength','pattern'].includes(k))) throw new Error('UNSUPPORTED_RESEARCH_SCHEMA_KEYWORD');
  if (s.type && type(x) !== s.type) return false;
  if ('const' in s && x !== s.const) return false;
  if (s.minLength != null && [...x].length < s.minLength) return false;
  if (s.pattern && !new RegExp(s.pattern).test(x)) return false;
  if (s.required && !s.required.every(k => Object.hasOwn(x, k))) return false;
  if (s.properties && !Object.entries(s.properties).every(([k,v]) => !Object.hasOwn(x,k) || matchesSchema(x[k],v))) return false;
  if (s.items && !x.every(v => matchesSchema(v,s.items))) return false;
  return true;
}

export function inspectStructure(summary, schema) {
  const events = summary.events ?? [];
  const results = events.filter(e => e?.event === 'result' && e.result && typeof e.result === 'object');
  const result = summary.result;
  const response = typeof result?.response === 'string' ? result.response : null;
  const fields = result ? Object.keys(result).sort() : [];
  const envelope = {
    event_count: events.length, result_event_count: results.length,
    terminal_result_event_count: results.length,
    selected_terminal_result_ordinal: results.findIndex(e => e.result === result) < 0 ? null : results.findIndex(e => e.result === result) + 1,
    selected_result_status: ['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING'].includes(result?.status) ? result.status : 'UNKNOWN',
    selected_result_field_names: fields,
    selected_result_field_types: Object.fromEntries(fields.map(k => [k,type(result[k])])),
    structured_output_related_field_names: fields.filter(k => /structur|schema|json|output|response/i.test(k)),
    response_field_present: !!result && Object.hasOwn(result,'response'), response_field_type: type(result?.response),
  };
  if (response === null) return { ...envelope, whole_response_bytes: null, whole_response_sha256: null };
  const objects = []; let start = -1, depth = 0, quoted = false, escaped = false, stray = false;
  for (let i = 0; i < response.length; i++) {
    const c = response[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '{') { if (!depth) start = i; depth++; }
    if (c === '}') { if (!depth) { stray = true; continue; } if (--depth === 0) {
      const raw = response.slice(start, i + 1); let value, valid = false;
      try { value = JSON.parse(raw); valid = true; } catch {}
      objects.push({ start, end: i + 1, raw, value, valid });
    } }
  }
  const decisions = objects.filter(o => o.valid && shaped(o.value));
  const same = fn => decisions.length > 1 ? decisions.every(o => fn(o) === fn(decisions[0])) : null;
  const nonwhite = x => bytes(x.replace(/\s/gu,''));
  const prefix = objects.length ? nonwhite(response.slice(0,objects[0].start)) : nonwhite(response);
  const suffix = objects.length ? nonwhite(response.slice(objects.at(-1).end)) : 0;
  const between = objects.slice(1).reduce((n,o,i) => n + nonwhite(response.slice(objects[i].end,o.start)),0);
  return { ...envelope,
    whole_response_bytes: bytes(response), whole_response_sha256: hash(response),
    extracted_trimmed_response_bytes: bytes(response.trim()), extracted_trimmed_response_sha256: hash(response.trim()),
    top_level_balanced_object_count: objects.length, decision_candidate_count: decisions.length,
    json_fence_count: [...response.matchAll(/```json\b/gi)].length,
    non_whitespace_prefix_bytes: prefix, non_whitespace_suffix_bytes: suffix,
    non_whitespace_between_top_level_objects_bytes: between,
    non_whitespace_outside_candidates: prefix + suffix + between > 0 || objects.length !== decisions.length,
    incomplete_object_or_string: depth !== 0 || quoted, stray_closing_brace: stray,
    candidates: objects.map((o,i) => ({
      candidate_ordinal: i + 1, candidate_bytes: bytes(o.raw), candidate_sha256: hash(o.raw),
      candidate_json_valid: o.valid, candidate_top_level_type: o.valid ? type(o.value) : 'UNKNOWN',
      candidate_pm_decision_shaped: o.valid && shaped(o.value),
      candidate_pm_decision_type: Object.values(PM_DECISION_TYPES).includes(o.value?.type) ? o.value.type : 'UNKNOWN',
      candidate_finish_output_present: o.value?.type === 'finish' && typeof o.value.output === 'string' && !!o.value.output.trim(),
      candidate_pm_contract_valid: o.valid && contract(o.value),
      candidate_matches_requested_native_schema_shape: o.valid && matchesSchema(o.value,schema),
    })),
    candidates_byte_identical: same(o => o.raw), candidates_canonical_json_identical: same(o => canonical(o.value)),
    candidate_keyset_identical: same(o => canonical(Object.keys(o.value).sort())),
    candidate_decision_type_identical: same(o => o.value.type), candidate_data_shape_identical: same(o => canonical(shape(o.value.data))),
  };
}
