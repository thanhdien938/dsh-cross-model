import {open,readFile,unlink} from 'node:fs/promises';

export async function acquireRuntimeLock(path,{pid=process.pid,isAlive=defaultAlive}={}){
  for(let attempt=0;attempt<2;attempt++){
    try{const handle=await open(path,'wx');await handle.writeFile(JSON.stringify({pid,created_at:new Date().toISOString()}));return Object.freeze({status:attempt?'RECLAIMED':'ACQUIRED',release:async()=>{await handle.close();await unlink(path).catch(()=>{});}});}
    catch(error){if(error.code!=='EEXIST')throw error;let owner=null;try{owner=JSON.parse(await readFile(path,'utf8'));}catch{}if(owner?.pid&&isAlive(owner.pid))return Object.freeze({status:'HELD',owner_pid:owner.pid,release:async()=>{}});await unlink(path).catch(()=>{});}
  }
  throw new Error('runtime lock unavailable');
}
function defaultAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
