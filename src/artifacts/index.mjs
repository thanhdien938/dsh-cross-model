/**
 * P20.1 — Artifact Workspace Foundation public surface.
 *
 * This barrel is the single import point future P20 phases (P20.2+) use to
 * reach the inactive artifact store. Importing it has no side effects and
 * touches no filesystem.
 *
 * See docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md and
 * docs/planning/P20_IMPLEMENTATION_PLAN_POST_SURVEY_PM_FREEZE.md §9–§13.
 */

export * from './artifact-paths.mjs';
export * from './artifact-schema.mjs';
export * from './artifact-store.mjs';
export * from './artifact-transport.mjs';
export * from './artifact-delivery.mjs';
export * from './backend-report-capability.mjs';
export * from './report-executive-log.mjs';
export * from './artifact-integrity.mjs';
export * from './artifact-repair.mjs';
export * from './artifact-recovery.mjs';
