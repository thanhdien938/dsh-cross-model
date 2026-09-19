import pg from 'pg';
import Database from 'better-sqlite3';

export class ReadProjectionService{
  constructor({connectionString,sqlitePath}={}){this.connectionString=connectionString;this.sqlitePath=sqlitePath;this.pg=null;this.sqlite=null;}
  async open(){this.pg=new pg.Client({connectionString:this.connectionString});await this.pg.connect();await this.pg.query('BEGIN READ ONLY');this.sqlite=new Database(this.sqlitePath,{readonly:true,fileMustExist:true});this.sqlite.pragma('query_only = ON');return this;}
  async close(){if(this.pg){await this.pg.query('ROLLBACK').catch(()=>{});await this.pg.end();}this.sqlite?.close();}
  async timeline(projectId){
    const owner=(await this.pg.query(`SELECT command_id,client_kind,project_id,created_at,canonical_result FROM dsh_coordination.owner_command WHERE project_id=$1 ORDER BY created_at,command_id`,[projectId])).rows.map(row=>({event_kind:row.client_kind==='TELEGRAM'?'USER_TELEGRAM':'USER_GUI',project_id:row.project_id,task_id:row.canonical_result?.task_id??null,pm_run_id:row.canonical_result?.pm_run_id??null,source:'postgres-owner',timestamp:row.created_at.toISOString(),stable_source_id:row.command_id,human_summary:'Owner command accepted'}));
    const interactions=(await this.pg.query(`SELECT interaction_id,project_id,task_id,pm_run_id,status,created_at,runtime_facts FROM dsh_coordination.owner_interaction WHERE project_id=$1 ORDER BY created_at,interaction_id`,[projectId])).rows.map(row=>({event_kind:row.runtime_facts?.notification_kind==='TERMINAL_PM_RESULT'?'RESULT':'APPROVAL',project_id:row.project_id,task_id:row.task_id,pm_run_id:row.pm_run_id,source:'postgres-interaction',timestamp:row.created_at.toISOString(),stable_source_id:row.interaction_id,human_summary:row.status==='OPEN'?'Owner interaction opened':'Owner interaction updated'}));
    const tasks=this.sqlite.prepare(`SELECT id,project_id,created_at FROM tasks WHERE project_id=? ORDER BY created_at,id`).all(projectId).map(row=>({event_kind:'SYSTEM',project_id:row.project_id,task_id:row.id,pm_run_id:null,source:'sqlite-task',timestamp:row.created_at,stable_source_id:row.id,human_summary:'Task materialized'}));
    const pmById=new Map(owner.filter(row=>row.pm_run_id).map(row=>[row.pm_run_id,row.task_id]));
    const pm=this.sqlite.prepare(`SELECT id,status,created_at FROM pm_runs ORDER BY created_at,id`).all().filter(row=>pmById.has(row.id)).map(row=>({event_kind:'PM',project_id:projectId,task_id:pmById.get(row.id),pm_run_id:row.id,source:'sqlite-pm',timestamp:row.created_at,stable_source_id:row.id,human_summary:`PM ${row.status}`}));
    const agents=this.sqlite.prepare(`SELECT r.id,r.task_id,r.status,r.created_at,t.project_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? ORDER BY r.created_at,r.id`).all(projectId).map(row=>({event_kind:'AGENT',project_id:row.project_id,task_id:row.task_id,pm_run_id:null,source:'sqlite-run',timestamp:row.created_at,stable_source_id:row.id,human_summary:`Agent run ${row.status}`}));
    return stable([...owner,...interactions,...tasks,...pm,...agents]);
  }
}
export function stable(rows){return rows.map(row=>({...row,lineage_key:row.task_id??row.pm_run_id??`${row.source}:${row.stable_source_id}`})).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.source.localeCompare(b.source)||a.stable_source_id.localeCompare(b.stable_source_id));}
