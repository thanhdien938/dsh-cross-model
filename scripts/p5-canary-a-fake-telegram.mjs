// Canary A only: the sole fake is Telegram's HTTP transport. All state changes
// flow through the production adapter, services, coordinator and worker.
import {loadP5ProductionConfig} from '../src/runtime/p5-production-config.mjs';
import {createP5ProductionComposition} from '../src/runtime/p5-production-composition.mjs';

const configPath=process.argv[2];
if(!configPath)throw new Error('usage: node scripts/p5-canary-a-fake-telegram.mjs <config.yml>');
const updates=[];const messages=[];let updateId=1;
const fetchImpl=async(url,init)=>{if(url.includes('/getUpdates'))return{ok:true,json:async()=>({result:updates.shift()??[]})};messages.push(JSON.parse(init.body).text);return{ok:true,json:async()=>({ok:true})};};
const config=await loadP5ProductionConfig(configPath);const composition=await createP5ProductionComposition(config,{fetchImpl});
try{
  const telegram=(text)=>[{update_id:updateId++,message:{from:{id:Number(config.telegram.ownerUserId)},chat:{id:Number(config.telegram.ownerChatId)},text}}];
  updates.push(telegram(process.env.DSH_P5_CANARY_TASK??'Canary A bounded PM lifecycle'));await composition.adapter.pollOnce();
  const worker=await composition.buildWorker();const initial=await worker.runOnce();
  const [interaction]=await composition.ownerRepository.listInbox({limit:2});if(!interaction)throw new Error('Canary A expected one open owner interaction');
  const parkedPoll=await worker.runOnce();updates.push(telegram(`/decide ${interaction.interaction_id} ${interaction.revision} ${interaction.allowed_responses[0]}`));await composition.adapter.pollOnce();
  const beforeRestore=await worker.runOnce();const coordinator=await composition.buildCoordinator();const restored=await coordinator.runOnce();const duplicate=await coordinator.runOnce();const resumed=await worker.runOnce();
  const run=composition.pmRepository.load(interaction.pm_run_id);const work=await composition.coordination.readClaim(initial.work_item_id);
  const evidence={initial:initial.outcome.status,parkedPoll:parkedPoll.status,beforeRestore:beforeRestore.status,restored:restored.result?.restored,duplicateRestoration:duplicate.result?.restored,resumed:resumed.outcome?.status,pmStatus:run.status,claimState:work.claim_state,postgresSchema:await composition.coordination.readSchemaVersion(),sqliteSchema:await composition.sqlite.readSchemaVersion(),telegramMessages:messages.length};
  const passed=evidence.initial==='PARKED'&&evidence.parkedPoll==='IDLE'&&evidence.beforeRestore==='IDLE'&&evidence.restored===1&&evidence.duplicateRestoration===0&&evidence.resumed==='COMPLETED'&&evidence.pmStatus==='completed'&&evidence.claimState==='COMPLETED'&&evidence.postgresSchema===4&&evidence.sqliteSchema===6;
  const report={status:passed?'PASS':'FAIL',...evidence};
  console.log(JSON.stringify(report));if(report.status!=='PASS')process.exitCode=1;
}finally{await composition.close();}
