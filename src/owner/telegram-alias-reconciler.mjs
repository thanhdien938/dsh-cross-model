// P8-R0.1 core: aliases FOLLOW canonical objects — a canonical object never
// follows an alias. This module reconciles the durable alias STATE (see
// telegram-alias-state-store.mjs) against the CURRENTLY REGISTERED project/
// PM-profile ids on every config load:
//
//   registered ids + persisted state
//         |
//         v  keep every existing assignment whose target is STILL registered
//         v  drop every assignment whose target is no longer registered
//         v  (its alias number is NEVER reissued — the high-water mark
//         v   already accounts for it)
//         v  allocate a fresh, monotonically increasing alias for every
//         v  registered id that has no assignment yet, in REGISTRY ORDER
//         v  (deterministic; used for both first-ever allocation and any
//         v  later incremental allocation of newly discovered ids)
//         v
//   updated state (written back atomically only if it changed)
//
// This is a pure, synchronous function — trivially unit-testable — kept
// separate from the async state-store I/O in loadReconciledTelegramAliases
// below.
import { emptyTelegramAliasState, TelegramAliasStateStore, TELEGRAM_ALIAS_STATE_VERSION } from './telegram-alias-state-store.mjs';
import { TelegramAliasRegistry } from './telegram-alias-registry.mjs';

function reconcileAxis(existingMap, nextAliasStart, registeredIds) {
  const keptEntries = Object.entries(existingMap ?? {}).filter(([, targetId]) => registeredIds.includes(targetId));
  const keptTargets = new Set(keptEntries.map(([, targetId]) => targetId));
  const toAssign = registeredIds.filter((targetId) => !keptTargets.has(targetId));
  const map = Object.fromEntries(keptEntries);
  let next = nextAliasStart;
  for (const targetId of toAssign) {
    map[String(next)] = targetId;
    next += 1;
  }
  const droppedCount = Object.keys(existingMap ?? {}).length - keptEntries.length;
  const changed = toAssign.length > 0 || droppedCount > 0;
  return { map, nextAlias: next, changed };
}

// Pure reconciliation: `state` is an already-validated persisted-state
// object (see telegram-alias-state-store.mjs); `registeredProjectIds`/
// `registeredPmProfileIds` are ORDERED arrays (registry/config-file order —
// this order is used ONLY to decide the assignment order for ids that have
// no alias yet; it never affects an id that already has one, Part
// "DETERMINISTIC INITIAL ASSIGNMENT"/"ORDER STABLE").
export function reconcileAliasState({ state, registeredProjectIds, registeredPmProfileIds }) {
  const base = state ?? emptyTelegramAliasState();
  const projects = reconcileAxis(base.projects, base.next_project_alias, registeredProjectIds);
  const pmProfiles = reconcileAxis(base.pm_profiles, base.next_pm_profile_alias, registeredPmProfileIds);
  const nextState = {
    version: TELEGRAM_ALIAS_STATE_VERSION,
    next_project_alias: projects.nextAlias,
    next_pm_profile_alias: pmProfiles.nextAlias,
    projects: projects.map,
    pm_profiles: pmProfiles.map,
  };
  return { state: nextState, changed: projects.changed || pmProfiles.changed };
}

// Orchestrates state-store I/O + reconciliation + persistence, containing
// EVERY failure mode (missing file, malformed file, unsupported version, I/O
// error on write, ...) into a non-throwing result: alias state is UX, never
// authority, so a broken alias file must never take down canonical Telegram
// or the wider DSH runtime (Part "FAILURE POLICY"). Returns
// `{ registry, status }` — `status.available` mirrors `registry.available`
// and carries a bounded, non-secret `reason`/`code`/`path` for `/aliases`
// and operator-facing diagnostics; never anything from the alias content
// itself (which is only ids, never secrets, but bounding stays consistent
// with every other diagnostic surface in this codebase).
export async function loadReconciledTelegramAliases({ path, registeredProjectIds, registeredPmProfileIds }) {
  try {
    const store = new TelegramAliasStateStore(path);
    const existing = await store.read();
    const { state, changed } = reconcileAliasState({ state: existing, registeredProjectIds, registeredPmProfileIds });
    if (changed) await store.write(state);
    return { registry: new TelegramAliasRegistry({ projects: state.projects, pmProfiles: state.pm_profiles, available: true }), status: Object.freeze({ available: true, path }) };
  } catch (error) {
    return { registry: TelegramAliasRegistry.unavailable(), status: Object.freeze({ available: false, code: error?.code ?? 'ALIAS_STATE_ERROR', reason: String(error?.message ?? 'alias reconciliation failed').slice(0, 300), path }) };
  }
}
