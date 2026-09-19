import React, { useEffect, useState } from 'react';
import { MultiTaskStatus } from '../../electron/main/types';
import CancelTaskDialog from './CancelTaskDialog';
import './MultiTaskControl.css';

export function elapsed(since: string | null, now=Date.now()) { if(!since)return '—'; const seconds=Math.max(0,Math.floor((now-new Date(since).getTime())/1000)); return seconds<60?`${seconds}s`:seconds<3600?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`; }

export default function MultiTaskControl({runtimeRunning,armedProjectId,onCancelTask}:{runtimeRunning:boolean;armedProjectId:string|null;onCancelTask:(taskId:string,projectId:string)=>Promise<void>}) {
  const [status,setStatus]=useState<MultiTaskStatus|null>(null); const [target,setTarget]=useState<{taskId:string;projectId:string}|null>(null); const [,tick]=useState(0);
  // P15-REM-R3-G (P15-D-015): `window.desktop.tasks.runtimeStatus()` now
  // returns a typed ProjectionResult — `unavailable` tracks whether the
  // LAST poll failed, so this pane shows an explicit degraded state
  // instead of unmounting (which used to hide every running/queued/
  // awaiting-owner task from the owner on a transient projection failure).
  // The last successfully-read `status` is kept on screen (never reset to
  // null on a failed poll) so the owner still sees the most recent known
  // task list, clearly labeled as possibly stale.
  const [unavailable,setUnavailable]=useState<{code:string;message:string}|null>(null);
  const load=()=>window.desktop.tasks.runtimeStatus().then((result)=>{
    if(result.status==='ERROR'){setUnavailable(result.error);}
    else{setStatus(result.data);setUnavailable(null);}
  }).catch(()=>{});
  useEffect(()=>{if(!runtimeRunning){setStatus(null);setUnavailable(null);return;} void load(); const id=setInterval(load,750); return()=>clearInterval(id);},[runtimeRunning]);
  useEffect(()=>{const id=setInterval(()=>tick(v=>v+1),1000);return()=>clearInterval(id);},[]);
  if(!runtimeRunning||(!status&&!unavailable))return null;
  if(!status&&unavailable)return <section className="multi-task card" aria-label="Multi-task control"><div className="multi-task-unavailable" role="alert">Task status unavailable ({unavailable.code}). Running/queued tasks may exist that this view cannot currently show.</div></section>;
  return <section className="multi-task card" aria-label="Multi-task control">
    {unavailable&&<div className="multi-task-unavailable" role="alert">Task status could not be refreshed ({unavailable.code}) — showing the last known state, which may be stale.</div>}
    <div className="multi-task-summary">
      <div className="multi-task-stat"><span className="multi-task-stat-label">Running</span><span className="multi-task-stat-value">{status.activeCount} / {status.globalLimit}</span></div>
      <div className="multi-task-stat"><span className="multi-task-stat-label">Queued</span><span className="multi-task-stat-value">{status.queuedCount}</span></div>
      <div className="multi-task-stat"><span className="multi-task-stat-label">Awaiting owner</span><span className="multi-task-stat-value">{status.awaitOwnerCount}</span></div>
    </div>
    <div className="multi-task-list">
      {status.tasks.map(task=><div className="multi-task-row" key={task.pmRunId}>
        <div><code>{task.taskId.slice(0,12)}</code><span>{task.projectName??'Unknown project'}</span></div>
        <div><strong>{task.backend??'Unknown backend'}</strong><span>{task.profileId??'Unknown profile'}</span></div>
        <div><strong>{task.mode}</strong><span>{task.runtimeClass??'NORMAL'} · {task.durability??'DIRECT'}</span></div>
        <div><strong className={`task-state task-state-${task.displayState.split(' ')[0].toLowerCase()}`}>{task.displayState}</strong><span>{elapsed(task.elapsedSince)}</span>{task.reconciliation&&<div className="task-reconciliation" title={`${task.reconciliation.classification} · ${task.reconciliation.reason}`}><span>{task.reconciliation.indicator}</span>{task.reconciliation.indicator==='RECOVERY REQUIRED'&&<small>{task.reconciliation.affectedLayer} · {task.reconciliation.reason} · impact {task.reconciliation.resourceImpact}</small>}</div>}</div>
        <div>{task.cancellable&&task.projectId===armedProjectId?<button className="btn btn-danger" onClick={()=>setTarget({taskId:task.taskId,projectId:task.projectId!})}>Cancel</button>:task.cancellable?<span className="task-arm-note">Arm project to cancel</span>:null}</div>
      </div>)}
    </div>
    {target&&<CancelTaskDialog taskId={target.taskId} onClose={()=>setTarget(null)} onConfirm={async()=>{await onCancelTask(target.taskId,target.projectId);await load();}}/>}
  </section>;
}
