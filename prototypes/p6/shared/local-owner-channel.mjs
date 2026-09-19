import net from 'node:net';

const MAX_LINE=256*1024;

export function startLocalOwnerServer({pipeName,ownerService,onShutdown=()=>{}}={}){
  if(!isLocalPipe(pipeName)||!ownerService)throw new TypeError('local pipe and owner service required');
  const server=net.createServer(socket=>{
    let buffered='';
    socket.setEncoding('utf8');
    socket.on('data',chunk=>{
      buffered+=chunk;
      if(buffered.length>MAX_LINE){socket.destroy();return;}
      for(let end;(end=buffered.indexOf('\n'))>=0;){const line=buffered.slice(0,end);buffered=buffered.slice(end+1);void respond(socket,line,ownerService,onShutdown);}
    });
  });
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipeName,()=>resolve(Object.freeze({server,close:()=>new Promise(done=>server.close(done))})));});
}

export function requestLocalOwner({pipeName,request,disconnectAfterWrite=false}={}){
  if(!isLocalPipe(pipeName))throw new TypeError('local pipe required');
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(pipeName);let buffered='';
    socket.setEncoding('utf8');
    socket.once('error',reject);
    socket.once('connect',()=>{socket.write(`${JSON.stringify(request)}\n`);if(disconnectAfterWrite){socket.destroy();resolve(null);}});
    if(disconnectAfterWrite)return;
    socket.on('data',chunk=>{buffered+=chunk;const end=buffered.indexOf('\n');if(end<0)return;socket.end();try{resolve(JSON.parse(buffered.slice(0,end)));}catch(error){reject(error);}});
  });
}

async function respond(socket,line,ownerService,onShutdown){
  let id=null;
  try{
    const request=JSON.parse(line);id=request.id;
    if(request.operation==='PING')return send(socket,{id,ok:true,result:{status:'READY'}});
    if(request.operation==='SHUTDOWN'){send(socket,{id,ok:true,result:{status:'DRAINING'}});queueMicrotask(onShutdown);return;}
    if(request.operation!=='SUBMIT_TASK'||!request.command||request.command.operation!=='SUBMIT_TASK')throw typed('operation is not allowed','LOCAL_OPERATION_REFUSED');
    const result=await ownerService.mutate(request.command);
    send(socket,{id,ok:true,result:sanitize(result)});
  }catch(error){send(socket,{id,ok:false,error:{code:safeCode(error?.code),message:'local owner request refused'}});}
}
function send(socket,value){if(!socket.destroyed)socket.end(`${JSON.stringify(value)}\n`);}
function isLocalPipe(value){return typeof value==='string'&&(/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value)||/^\/[^\0]+\.sock$/.test(value));}
function safeCode(value){return /^[A-Z][A-Z0-9_]{0,63}$/.test(value??'')?value:'LOCAL_REQUEST_FAILED';}
function sanitize(value,depth=0){if(depth>5)return'[TRUNCATED]';if(value===null||['string','number','boolean'].includes(typeof value))return typeof value==='string'?value.replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi,'[REDACTED_URL]').replace(/bearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,4096):value;if(Array.isArray(value))return value.slice(0,100).map(v=>sanitize(v,depth+1));if(typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(token|secret|password|dsn|fencing)/i.test(k)).slice(0,100).map(([k,v])=>[k,sanitize(v,depth+1)]));return String(value);}
function typed(message,code){return Object.assign(new Error(message),{code});}
