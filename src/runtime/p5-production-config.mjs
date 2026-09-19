import {readFile,stat,realpath} from 'node:fs/promises';
import {isAbsolute,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import {normalizeAutonomyEnvelope} from '../owner/autonomy-envelope.mjs';
import {PmProfileRegistry} from '../pm/pm-profile-registry.mjs';
import {loadReconciledTelegramAliases} from '../owner/telegram-alias-reconciler.mjs';
import {loadApiProviderConfig} from '../pm/api-backend/api-provider-config.mjs';
import {resolveReconciliationMode,DSH_RECONCILIATION_MODE_ENV} from '../reconciliation/reconciliation-mode.mjs';
import {resolveRepositoryCommonDir} from '../pm/task-workspace-manager.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GIT_BASE_BRANCH=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const GIT_BASE_SHA=/^[a-fA-F0-9]{40}$/;
export async function loadP5ProductionConfig(path,{env=process.env}={}){
  const absolute=resolve(path);const root=dirname(absolute);const input=parse(await readFile(absolute,'utf8'));
  if(!plain(input))throw new TypeError('P5 configuration must be an object');
  const dsn=secret(env,input.postgres?.dsn_env,'PostgreSQL DSN');
  const sqlitePath=absolutePath(root,input.sqlite?.path,'SQLite path');
  let telegram=null;
  if(input.telegram!==undefined&&input.telegram!==null){
    if(!plain(input.telegram))throw new TypeError('Telegram configuration must be an object');
    const token=secret(env,input.telegram.token_env,'Telegram token');
    telegram={
      token,
      tokenEnv:input.telegram.token_env,
      ownerUserId:numeric(input.telegram.user_id,'Telegram owner user_id'),
      ownerChatId:numeric(input.telegram.chat_id,'Telegram owner chat_id'),
      projectId:input.telegram.project_id!=null?id(input.telegram.project_id,'Telegram project_id'):null,
      pollIntervalMs:integer(input.telegram.poll_interval_ms??1000,10,60000,'Telegram poll interval'),
    };
  }
  const projectsPath=absolutePath(root,input.projects_file,'projects file');
  const profilesPath=absolutePath(root,input.pm_profiles_file,'PM profiles file');
  const projects=await loadP5Projects(projectsPath,{root});const profilesDoc=parse(await readFile(profilesPath,'utf8'));
  const profiles=new PmProfileRegistry(profilesDoc?.pm_profiles??[]).list();
  const profileIds=new Set(profiles.map(v=>v.id));for(const project of projects)if(!profileIds.has(project.default_pm_profile_id))throw new TypeError('project default PM profile is not registered');
  // P8-R0.1 Part "WHERE STATE LIVES"/"FIRST BOOT": `telegram_aliases_file` is
  // OPTIONAL. When given, it is the DSH-MANAGED alias STATE file (never
  // operator-authored declarative config, see telegram-alias-reconciler.mjs)
  // — an explicit network-path check still applies via absolutePath(), same
  // as every other config path. When omitted, it defaults to
  // `telegram-aliases.yaml` next to this config file, so the alias feature
  // works automatically without any manual config edit. Either way, the
  // file is auto-created on first use if it does not exist yet (empty
  // initial state, then reconciled below) — a missing file is never a
  // config error.
  const telegramAliasesPath=input.telegram_aliases_file!=null?absolutePath(root,input.telegram_aliases_file,'telegram aliases file'):resolve(root,'telegram-aliases.yaml');
  // P11-R0: `api_providers_file` is OPTIONAL — omitted (the default for
  // every deployment before P11, and every deployment that hasn't
  // configured any API provider yet) yields an empty provider registry,
  // never a config-load failure (spec "NO KEY = NO REGRESSION" — the
  // stronger form: no provider CONFIG at all must not block startup
  // either). A path that IS given but unreadable/malformed is a real
  // authoring error at the document level still fails config load. A bad
  // individual provider entry is rejected and reported without discarding
  // valid sibling providers, preserving provider-level failure isolation.
  const apiProviderConfigErrors=[];
  const apiProviders=await loadApiProviderConfig({path:input.api_providers_file!=null?absolutePath(root,input.api_providers_file,'API providers file'):null,env,onInvalidProvider:(error)=>apiProviderConfigErrors.push(error)});
  // Part "FAILURE POLICY": reconciliation NEVER throws — a malformed/
  // unreadable/unwritable alias state degrades to `available:false`
  // (canonical Telegram syntax keeps working; shorthand/`/aliases` report
  // "unavailable" instead of crashing config load, let alone the runtime).
  const {registry:telegramAliases,status:telegramAliasesStatus}=await loadReconciledTelegramAliases({path:telegramAliasesPath,registeredProjectIds:projects.map(v=>v.id),registeredPmProfileIds:profiles.map(v=>v.id)});
  // P9-R0.4 Part J/W: `pmProfilesPath` is exposed on the config so the
  // composition layer can build a PmProfileStatusStore (a narrow, always-
  // fresh re-read of just the `status` field — see
  // src/pm/pm-profile-status-store.mjs) pointed at the EXACT same file
  // `profiles` above was already loaded from. `profiles` itself stays a
  // frozen snapshot (execution identity is fixed for the process
  // lifetime); this path is what lets lifecycle state be checked live.
  const config={mode:input.mode??'production',postgres:{connectionString:dsn},sqlitePath,projects,projectsPath,projectConfigRoot:root,profiles,pmProfilesPath:profilesPath,apiProviders,apiProviderConfigErrors,telegramAliases,telegramAliasesStatus,telegram,coordinator:{logicalId:id(input.coordinator?.logical_id,'coordinator logical ID'),leaseMs:integer(input.coordinator?.lease_ms??30000,1000,900000,'coordinator lease'),pollIntervalMs:integer(input.coordinator?.poll_interval_ms??250,10,60000,'coordinator poll interval')},worker:{logicalId:id(input.worker?.logical_id,'worker logical ID'),leaseMs:integer(input.worker?.lease_ms??30000,1000,900000,'worker lease'),pollIntervalMs:integer(input.worker?.poll_interval_ms??250,10,60000,'worker poll interval')},pm:{scriptedDecisions:input.pm?.scripted_decisions??null},concurrency:parseConcurrency(input.concurrency),reconciliation:{mode:resolveReconciliationMode(env[DSH_RECONCILIATION_MODE_ENV])}};
  // telegram.project_id is optional and, when present, only a documentation
  // hint. M4 multi-project routing derives its target exclusively from the
  // registered `projects` list (bare text when there is exactly one project,
  // `@<project_id>` otherwise) — see src/owner/telegram-owner-client.mjs.
  if(config.telegram?.projectId!=null&&!projects.some(v=>v.id===config.telegram.projectId))throw new TypeError('Telegram project_id is not registered');
  return deepFreeze(config);
}
// P22.7: the projects registry is the established project authority.  Keep
// startup validation and per-Git-task refresh on this one parser so a
// long-lived runtime can obtain the current explicit base binding without
// reloading secrets, profiles, aliases, or unrelated runtime configuration.
export async function loadP5Projects(path,{root=dirname(resolve(path))}={}){
  const projectsDoc=parse(await readFile(resolve(path),'utf8'));
  return validateProjects(projectsDoc?.projects,root);
}
export function publicP5Config(config){return deepFreeze({mode:config.mode,sqlitePath:config.sqlitePath,
  // P24.3B — `repository_common_dir` is excluded from the public
  // projection for the SAME reason `repo_path` itself already is: a local
  // absolute filesystem path, never surfaced to Desktop/Telegram beyond a
  // presence boolean.
  projects:config.projects.map(({repo_path,repository_common_dir,...v})=>({...v,repo_path_present:Boolean(repo_path)&&!v.path_missing})),profiles:config.profiles,reconciliation:config.reconciliation,
  // P11-R0: provider id/protocol/base_url only — never api_key_env's
  // resolved VALUE (never resolved here at all — see api-provider-config.mjs),
  // and base_url is administrator config, not a secret.
  apiProviders:Object.fromEntries(Object.entries(config.apiProviders??{}).map(([id,entry])=>[id,{protocol:entry.protocol,base_url:entry.baseUrl}])),apiProviderConfigErrors:config.apiProviderConfigErrors??[],
  telegramAliases:{projects:config.telegramAliases.listProjectAliases(),pm_profiles:config.telegramAliases.listPmAliases()},telegramAliasesStatus:config.telegramAliasesStatus,telegram:config.telegram?{configured:true,token_present:Boolean(config.telegram.token),ownerUserId:config.telegram.ownerUserId,ownerChatId:config.telegram.ownerChatId,projectId:config.telegram.projectId}:{configured:false,token_present:false,ownerUserId:null,ownerChatId:null,projectId:null},coordinator:config.coordinator,worker:config.worker,postgres:{configured:Boolean(config.postgres?.connectionString)}});}
// A structurally invalid registry entry (bad id, duplicate id, unresolvable
// repo_path *value*, network path, bad autonomy/PM-profile-id shape) is a
// genuine CONFIG INVALID error and still fails config load entirely. A
// syntactically valid repo_path whose directory does not currently exist on
// disk is a *project lifecycle* condition, not a config authoring error: the
// project is accepted into the registry with `path_missing: true` so every
// other registered project remains usable. Nothing repoints the path or
// substitutes another directory; the project simply cannot be armed or
// submitted to until the configured path exists again (see
// src/owner/owner-control-service.mjs PROJECT_PATH_MISSING).
// P13-R1 §3.2: canonical PHYSICAL workspace identity, derived HERE (the one
// place `validateProjects()` already resolves/stat()s each `repo_path`) and
// attached to the frozen project record so every existing consumer that
// already receives `project` gets `project.workspace_id` for free, with no
// new plumbing. This is the runtime-authoritative identity the P13
// admission gate (production-pm-worker.mjs's resolvePmWorkspaceIdentity())
// serializes on -- NEVER `project.id`: two registered projects pointing at
// the same physical directory (even under different ids, or via a symlink/
// junction alias) resolve to the IDENTICAL workspace_id via `realpath()`
// and are therefore treated as one workspace. A `path_missing` project
// cannot be `realpath()`'d (and cannot be submitted to at all --
// PROJECT_PATH_MISSING) -- it falls back to its own normalized absolute
// path and is marked `workspace_verified:false` ("UNVERIFIED" in the
// architecture plan): conservative, because an unverified identity can
// never be proven identical to another and is therefore always treated as
// its own exclusive workspace.
function normalizeWorkspacePath(value){
  const unified=value.replace(/\\/g,'/');
  const drive=/^([A-Za-z]):\//.exec(unified);
  return drive?`${drive[1].toLowerCase()}${unified.slice(1)}`:unified;
}
function workspaceIdFor(normalizedPath){return createHash('sha256').update(normalizedPath,'utf8').digest('hex');}
// P24.3B §4 — the repository-common-dir identity `resolvePmWorkspaceIdentity()`
// (production-pm-worker.mjs) prefers over `workspace_id` when present,
// closing the audit's own alias/common-dir concurrency gap: two registered
// project records pointing at DIFFERENT linked-worktree paths of the SAME
// underlying repository must serialize against each other, which a
// realpath-only `workspace_id` cannot express. Computed HERE (the one
// place `validateProjects()` already resolves/stat()s each `repo_path`,
// already async) — never at admission/execution time — so the hot,
// synchronous `resolvePmWorkspaceIdentity()` never needs to spawn `git`
// itself. Best-effort and silently `null` for a `path_missing` project, a
// non-Git directory, or any Git-invocation failure (missing `git` on
// PATH, etc.) — this NEVER fails config load; a `null` value here means
// exactly what an absent field always meant to `resolvePmWorkspaceIdentity()`:
// fall back to `workspace_id`, byte-for-byte pre-P24.3 behavior.
async function resolveProjectRepositoryCommonDir(workspacePath,pathMissing){
  if(pathMissing)return null;
  try{return await resolveRepositoryCommonDir({repoPath:workspacePath});}catch{return null;}
}
async function validateProjects(values,root){if(!Array.isArray(values)||values.length===0)throw new TypeError('projects registry is required');const seen=new Set();const output=[];for(const raw of values){const projectId=id(raw?.id,'project id');if(seen.has(projectId))throw new TypeError('duplicate project ID');seen.add(projectId);const repoPath=absolutePath(root,raw.repo_path,'project repo path');const info=await stat(repoPath).catch(()=>null);const pathMissing=!info?.isDirectory();let workspacePath=repoPath,workspaceVerified=!pathMissing;if(!pathMissing){try{workspacePath=await realpath(repoPath);}catch{workspaceVerified=false;}}const workspaceId=workspaceIdFor(normalizeWorkspacePath(workspacePath));const repositoryCommonDir=await resolveProjectRepositoryCommonDir(workspacePath,pathMissing);const gitBase=projectGitBase(raw,projectId);output.push(Object.freeze({...raw,id:projectId,repo_path:repoPath,path_missing:pathMissing,workspace_id:workspaceId,workspace_verified:workspaceVerified,repository_common_dir:repositoryCommonDir,default_pm_profile_id:id(raw.default_pm_profile_id,'default PM profile'),autonomy:normalizeAutonomyEnvelope(raw.autonomy),...gitBase}));}return output;}
const GIT_BASE_POLICY_VALUES=new Set(['dynamic','pinned']);
// P24.1G6A — dynamic per-task fresh base pinning (reports/
// P24_1G6_PER_TASK_FRESH_BASE_PINNING_ARCHITECTURE_20260916.md "Config
// Migration", Option B). `git_base_policy` is the new, additive, optional
// field; its ABSENCE is resolved deterministically from what is already
// configured, never silently reinterpreting an existing strict project:
//   - no policy + full branch/SHA pair  -> LEGACY pinned (unchanged
//     strict semantics an operator has not yet explicitly migrated away
//     from; `git_base_legacy_pin:true` marks the provenance).
//   - no policy + no pair (or branch-only) -> dynamic (the new default
//     for every project that was never given a strict assertion at all).
// An EXPLICIT `git_base_policy` always wins over that inference. `pinned`
// requires the full branch/SHA pair (never partially configured); dynamic
// allows an explicit `git_base_branch` alone (the new capability this
// phase introduces — no admission-time SHA equality gate at all) and
// tolerates a stale/legacy `git_base_sha` sitting alongside it as
// migration metadata ONLY — never passed through as a CAS (see
// task-base-admission.mjs's `resolveProjectBasePolicy()`, the one place
// that reads `git_base_policy` at admission time).
function projectGitBase(raw,projectId){
  const hasBranch=raw?.git_base_branch!==undefined&&raw.git_base_branch!==null;
  const hasSha=raw?.git_base_sha!==undefined&&raw.git_base_sha!==null;
  const explicitPolicy=raw?.git_base_policy;
  if(explicitPolicy!==undefined&&explicitPolicy!==null&&!GIT_BASE_POLICY_VALUES.has(explicitPolicy)){
    throw new TypeError(`project ${projectId} git_base_policy must be "dynamic" or "pinned"`);
  }
  const legacyPin=explicitPolicy===undefined||explicitPolicy===null?hasBranch&&hasSha:false;
  const policy=explicitPolicy??(legacyPin?'pinned':'dynamic');
  if(policy==='pinned'&&(!hasBranch||!hasSha)){
    throw new TypeError(`project ${projectId} git_base_policy "pinned" requires both git_base_branch and git_base_sha`);
  }
  if(policy==='dynamic'&&hasSha&&!hasBranch){
    throw new TypeError(`project ${projectId} git_base_sha requires git_base_branch to also be configured`);
  }
  if(!hasBranch&&!hasSha)return{git_base_branch:null,git_base_sha:null,git_base_policy:policy,git_base_legacy_pin:false};
  const branch=hasBranch?raw.git_base_branch:null;
  if(branch!==null&&(typeof branch!=='string'||!GIT_BASE_BRANCH.test(branch)||branch.includes('..')||branch.includes('//')||branch.includes('@{')||branch.startsWith('.')||branch.startsWith('/')||branch.endsWith('.')||branch.endsWith('/')||branch.endsWith('.lock')))throw new TypeError(`project ${projectId} git_base_branch is invalid`);
  const sha=hasSha?raw.git_base_sha:null;
  if(sha!==null&&(typeof sha!=='string'||!GIT_BASE_SHA.test(sha)))throw new TypeError(`project ${projectId} git_base_sha must be an exact 40-character hexadecimal commit SHA`);
  return{git_base_branch:branch,git_base_sha:sha?sha.toLowerCase():null,git_base_policy:policy,git_base_legacy_pin:legacyPin};
}
function secret(env,name,label){if(typeof name!=='string'||!/^DSH_[A-Z0-9_]+$/.test(name))throw new TypeError(`${label} secret environment alias is invalid`);const value=env[name];if(typeof value!=='string'||!value)throw Object.assign(new Error(`${label} secret is unavailable`),{code:'SECRET_UNAVAILABLE'});return value;}
function absolutePath(root,value,label){if(typeof value!=='string'||!value)throw new TypeError(`${label} is required`);const out=isAbsolute(value)?value:resolve(root,value);if(/^(\\\\|\/\/|smb:|nfs:)/i.test(out))throw new TypeError(`${label} cannot use a network path`);return out;}
// P13-R8: purely optional, test-only benchmark config. The real production
// entrypoint (scripts/p5-runtime.mjs) never read `deps.pmConcurrencyLimit`,
// `deps.backendConcurrencyLimits`, or `deps.resourcePressureGovernor` before
// R8 -- every live deployment (including the owner's `live1`) silently ran
// with the R1 fallback global limit of 2, no backend limits, and NO R5
// resource-pressure governor at all (`resourcePressureGovernor:deps
// .resourcePressureGovernor??null` in p5-production-composition.mjs). R8's
// benchmark needs a real, config-driven way to raise the global limit to
// N=3/N=4 and to turn the already-built, already-tested R5 governor on --
// this is that seam. Omitting `concurrency` entirely (every config file
// before R8, and `live1/production.yaml` unless the owner opts in) yields
// `{globalLimit:undefined, backendLimits:null, resourceGovernor:null}`,
// which is byte-for-byte the same fallback behaviour as before this change.
function parseConcurrency(raw){
  if(raw==null)return{globalLimit:undefined,backendLimits:null,resourceGovernor:null};
  if(!plain(raw))throw new TypeError('concurrency must be an object');
  const globalLimit=raw.global_limit!=null?integer(raw.global_limit,1,32,'concurrency.global_limit'):undefined;
  let backendLimits=null;
  if(raw.backend_limits!=null){
    if(!plain(raw.backend_limits))throw new TypeError('concurrency.backend_limits must be an object');
    backendLimits={};
    for(const[key,value]of Object.entries(raw.backend_limits)){backendLimits[id(key,'concurrency.backend_limits key')]=integer(value,1,32,`concurrency.backend_limits.${key}`);}
  }
  let resourceGovernor=null;
  if(raw.resource_governor!=null){
    if(!plain(raw.resource_governor))throw new TypeError('concurrency.resource_governor must be an object');
    const enabled=Boolean(raw.resource_governor.enabled);
    const highWatermark=raw.resource_governor.high_watermark!=null?fraction(raw.resource_governor.high_watermark,'concurrency.resource_governor.high_watermark'):0.9;
    const recoveryWatermark=raw.resource_governor.recovery_watermark!=null?fraction(raw.resource_governor.recovery_watermark,'concurrency.resource_governor.recovery_watermark'):0.8;
    if(!(recoveryWatermark<highWatermark))throw new TypeError('concurrency.resource_governor.recovery_watermark must be strictly below high_watermark');
    resourceGovernor={enabled,highWatermark,recoveryWatermark};
  }
  return{globalLimit,backendLimits,resourceGovernor};
}
function fraction(value,label){if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1)throw new TypeError(`${label} is invalid`);return value;}
function numeric(value,label){const text=String(value??'');if(!/^-?[1-9][0-9]{0,19}$/.test(text))throw new TypeError(`${label} is invalid`);return text;}
function id(value,label){if(typeof value!=='string'||!ID.test(value))throw new TypeError(`${label} is invalid`);return value;}
function integer(value,min,max,label){if(!Number.isInteger(value)||value<min||value>max)throw new TypeError(`${label} is invalid`);return value;}
function plain(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}return value;}
