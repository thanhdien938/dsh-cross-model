import {loadP5ProductionConfig} from '../../../src/runtime/p5-production-config.mjs';
import {createP5ProductionComposition} from '../../../src/runtime/p5-production-composition.mjs';
import {startLocalOwnerServer} from './local-owner-channel.mjs';

const configPath=value('--config'),pipeName=value('--pipe');
if(!configPath||!pipeName)throw new Error('usage: runtime-host --config PATH --pipe PIPE');
const config=await loadP5ProductionConfig(configPath),composition=await createP5ProductionComposition(config);
const abort=new AbortController();let stopping=false;
const stop=()=>{if(stopping)return;stopping=true;abort.abort();composition.requestDrain();};
const channel=await startLocalOwnerServer({pipeName,ownerService:composition.ownerService,onShutdown:stop});
const coordinator=await composition.buildCoordinator(),worker=await composition.buildWorker();
console.log(JSON.stringify({event:'p6.p0.runtime.ready',pid:process.pid,pipe:pipeName,readiness:composition.readiness()}));
try{await Promise.all([composition.ownerRuntime.run({signal:abort.signal}),coordinator.run(),worker.run()]);}
finally{await channel.close().catch(()=>{});await composition.close();console.log(JSON.stringify({event:'p6.p0.runtime.stopped'}));}
function value(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:null;}
