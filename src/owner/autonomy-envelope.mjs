import { createHash } from 'node:crypto';
import { stableJson, OwnerControlError } from './owner-contracts.mjs';

export const REMOTE_EFFECTS = Object.freeze(['SUBMIT_TASK','REQUEST_CANCEL']);
export const LOCAL_ONLY_EFFECTS = Object.freeze(['MERGE_MAIN','PUSH_REMOTE','BRANCH_CREATE','REMEDIATION_ROUND','CHILD_TASK_SPAWN','AMBIGUITY_DISPOSITION','FORCE_REPLAY']);
const LEVEL = Object.freeze({ FORBID:0, APPROVAL:1, ALLOW:2 });

export function normalizeAutonomyEnvelope(input = {}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||!input.effects||typeof input.effects!=='object'||Array.isArray(input.effects))throw new OwnerControlError('autonomy envelope is invalid','INVALID_AUTONOMY_ENVELOPE');
  const effects = {};
  for (const [key,value] of Object.entries(input.effects ?? {})) { if (!(value in LEVEL)) throw new OwnerControlError('invalid autonomy effect', 'INVALID_AUTONOMY_ENVELOPE'); effects[key]=value; }
  for (const key of LOCAL_ONLY_EFFECTS) if (effects[key] === 'ALLOW') effects[key]='APPROVAL';
  return Object.freeze({ revision:Number(input.revision ?? 1), effects:Object.freeze(effects) });
}
export function narrowAutonomy(base, requested) {
  const a=normalizeAutonomyEnvelope(base), b=normalizeAutonomyEnvelope(requested), effects={...a.effects};
  for(const [key,value] of Object.entries(b.effects)) effects[key]=LEVEL[value] < LEVEL[effects[key] ?? 'FORBID'] ? value : effects[key] ?? 'FORBID';
  return normalizeAutonomyEnvelope({revision:a.revision+1,effects});
}
export function assertEffectAuthorized(envelope, effect, { remote=false }={}) {
  if (remote && LOCAL_ONLY_EFFECTS.includes(effect)) throw new OwnerControlError('effect is local-only', 'REMOTE_EFFECT_REFUSED');
  const mode=normalizeAutonomyEnvelope(envelope).effects[effect] ?? 'FORBID';
  if(mode!=='ALLOW') throw new OwnerControlError(`effect requires ${mode.toLowerCase()} policy`, mode==='APPROVAL'?'OWNER_APPROVAL_REQUIRED':'EFFECT_FORBIDDEN');
  return true;
}
export function autonomyFingerprint(value) { return createHash('sha256').update(stableJson(normalizeAutonomyEnvelope(value))).digest('hex'); }
export class GuardedEffectExecutor {
  constructor(handlers={}){this.handlers=new Map(Object.entries(handlers));}
  async execute(effect,input,{envelope,remote=false}={}){assertEffectAuthorized(envelope,effect,{remote});const handler=this.handlers.get(effect);if(!handler)throw new OwnerControlError('effect handler unavailable','EFFECT_HANDLER_UNAVAILABLE');return handler(input);}
}
