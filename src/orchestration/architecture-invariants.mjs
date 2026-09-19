export const ARCHITECTURE_INVARIANTS = Object.freeze([
  Object.freeze({ id: 'INV-001', area: 'continuity', statement: 'Level-1 fresh child dispatch must never be represented as native session continuation.' }),
  Object.freeze({ id: 'INV-002', area: 'roles', statement: 'Roles belong to tasks/workflows, never permanently to backend identities.' }),
  Object.freeze({ id: 'INV-003', area: 'bus', statement: 'Agent-to-agent transport is mediated by project-owned orchestration state/lineage rather than undocumented peer side channels.' }),
  Object.freeze({ id: 'INV-004', area: 'capability', statement: 'Only runtime-PROVED capabilities qualify for capability-aware routing; UNPROVEN and ERROR never qualify.' }),
  Object.freeze({ id: 'INV-005', area: 'health', statement: 'Capability evidence and runtime health evidence are separate dimensions.' }),
  Object.freeze({ id: 'INV-006', area: 'health', statement: 'UNKNOWN health never silently upgrades to HEALTHY; success evidence is required.' }),
  Object.freeze({ id: 'INV-007', area: 'failure', statement: 'Ambiguous task/application failure must not poison backend health.' }),
  Object.freeze({ id: 'INV-008', area: 'retry', statement: 'AUTH, CONFIG, PROTOCOL, ambiguous failure, and cancellation are not blindly retried.' }),
  Object.freeze({ id: 'INV-009', area: 'retry', statement: 'Retry/failover is bounded and every new attempt reselects from a fresh capability+health snapshot.' }),
  Object.freeze({ id: 'INV-010', area: 'audit', statement: 'Audit instrumentation must not change routing/execution semantics.' }),
  Object.freeze({ id: 'INV-011', area: 'audit', statement: 'Audit trace excludes task body/prompt content and redacts secret-bearing fields.' }),
  Object.freeze({ id: 'INV-012', area: 'truth', statement: 'Documentation may guide a proof, but installed runtime evidence is the source of truth for native capabilities.' }),
]);

export function invariantById(id) {
  return ARCHITECTURE_INVARIANTS.find((entry) => entry.id === id) ?? null;
}

export function invariantsForArea(area) {
  return ARCHITECTURE_INVARIANTS.filter((entry) => entry.area === area);
}
