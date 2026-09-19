import {describe,expect,it} from 'vitest';
import fs from 'fs'; import path from 'path';
import {canonicalTaskCancellable,projectOwnerTaskState,summarizeOwnerTasks} from '../electron/main/services/readProjection';
import {elapsed} from '../src/components/MultiTaskControl';

describe('P13-R6 canonical multi-task owner projection',()=>{
  it('does not call an unclaimed running pm_run RUNNING',()=>expect(projectOwnerTaskState({pmStatus:'running',active:false,awaitingOwner:false,waitingReason:'GLOBAL_CAPACITY'})).toBe('WAITING — GLOBAL CAPACITY'));
  it('counts only active execution projection as running',()=>expect(summarizeOwnerTasks([{displayState:'RUNNING'},{displayState:'WAITING — OTHER'}]).activeCount).toBe(1));
  it('excludes await-owner from queued',()=>expect(summarizeOwnerTasks([{displayState:'AWAITING OWNER'},{displayState:'WAITING — OTHER'}]).queuedCount).toBe(1));
  for(const [reason,state] of [['GLOBAL_CAPACITY','WAITING — GLOBAL CAPACITY'],['WORKSPACE_CAPACITY','WAITING — WORKSPACE BUSY'],['BACKEND_CAPACITY','WAITING — BACKEND CAPACITY'],['RESOURCE_PRESSURE','WAITING — RESOURCE PRESSURE'],['IDENTITY_UNRESOLVED','WAITING — OTHER']] as const) it(`maps ${reason}`,()=>expect(projectOwnerTaskState({pmStatus:'running',active:false,awaitingOwner:false,waitingReason:reason})).toBe(state));
  it('projects open parked work as awaiting owner before waiting reasons',()=>expect(projectOwnerTaskState({pmStatus:'running',active:false,awaitingOwner:true,waitingReason:'GLOBAL_CAPACITY'})).toBe('AWAITING OWNER'));
  it('queued task is cancellable',()=>expect(canonicalTaskCancellable('running')).toBe(true));
  it('active task is cancellable through the same canonical status rule',()=>expect(canonicalTaskCancellable('running')).toBe(true));
  it('await-owner task is cancellable through the same canonical status rule',()=>expect(canonicalTaskCancellable('running')).toBe(true));
  for(const terminal of ['completed','failed','cancelled']) it(`${terminal} task has no Cancel`,()=>expect(canonicalTaskCancellable(terminal)).toBe(false));
  it('terminalization updates counts',()=>expect(summarizeOwnerTasks([{displayState:'COMPLETED'},{displayState:'RUNNING'}])).toEqual({activeCount:1,queuedCount:0,awaitOwnerCount:0}));
  it('auto-promotion projection updates from waiting to active without durable status change',()=>{expect(projectOwnerTaskState({pmStatus:'running',active:false,awaitingOwner:false,waitingReason:'GLOBAL_CAPACITY'})).not.toBe('RUNNING');expect(projectOwnerTaskState({pmStatus:'running',active:true,awaitingOwner:false,waitingReason:null})).toBe('RUNNING');});
  it('Council is represented by one outer task row',()=>expect(summarizeOwnerTasks([{displayState:'RUNNING'}]).activeCount).toBe(1));
  it('elapsed time is owner readable',()=>expect(elapsed('2026-01-01T00:00:00Z',Date.parse('2026-01-01T00:01:05Z'))).toBe('1m 5s'));
  it('history query is hard bounded to 50 terminals',()=>{const source=fs.readFileSync(path.resolve(__dirname,'../electron/main/services/readProjection.ts'),'utf8');expect(source).toContain('Math.min(Math.max(terminalLimit, 0), 50)');});
  it('list uses one bounded scroll container',()=>{const css=fs.readFileSync(path.resolve(__dirname,'../src/components/MultiTaskControl.css'),'utf8');expect(css).toContain('max-height:360px;overflow-y:auto');expect(css).toContain('overscroll-behavior:contain');});
  it('renderer has no direct state mutation or process kill',()=>{const source=fs.readFileSync(path.resolve(__dirname,'../src/components/MultiTaskControl.tsx'),'utf8');expect(source).not.toMatch(/UPDATE |DELETE |kill\(/);expect(source).toContain('onCancelTask');});
});
