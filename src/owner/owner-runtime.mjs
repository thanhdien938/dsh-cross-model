// P7-R0.3 Part C: `log` shares the same sanitized, bounded, allow-listed
// event shape and sentinel prefix as telegram-owner-client.mjs's notifier
// logging (##DSH_OWNER_NOTIFY##) — one structured log stream, not a second
// subsystem. Only ever receives {stage,cycle,error} here: never a token,
// chat id, HTTP auth URL, or raw result text (this file never even has
// access to those).
function defaultLog(event) {
  try { console.error(`##DSH_OWNER_NOTIFY## ${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}`); }
  catch { /* observability must never itself break the owner loop */ }
}

export class OwnerRuntime {
  constructor({adapter,notifier,pollIntervalMs=1000,notifierIntervalMs=1000,backoffMs=1000,log=defaultLog}={}){
    if(!adapter||typeof adapter.pollOnce!=='function'||!notifier||typeof notifier.flush!=='function')throw new TypeError('owner runtime dependencies required');
    this.adapter=adapter;this.notifier=notifier;this.pollIntervalMs=bounded(pollIntervalMs);this.notifierIntervalMs=bounded(notifierIntervalMs);this.backoffMs=bounded(backoffMs);this.running=false;this.draining=false;this.lastError=null;this.log=log;
  }
  requestDrain(){this.draining=true;}
  async run({signal,maxCycles=Infinity}={}){this.running=true;let cycles=0;try{while(!this.draining&&!signal?.aborted&&cycles<maxCycles){cycles+=1;try{await this.adapter.pollOnce({signal});await this.notifier.flush();this.lastError=null;await delay(Math.min(this.pollIntervalMs,this.notifierIntervalMs),signal);}catch(error){
    // A normal drain aborts an in-flight Telegram long poll. That abort is
    // the requested loop termination, not an owner-loop failure to log and
    // back off from before noticing the already-aborted signal.
    if(signal?.aborted)break;
    this.lastError=error?.code??'OWNER_LOOP_FAILURE';
    // P7-R0.3 Part C: previously this cycle's failure (either
    // adapter.pollOnce() or notifier.flush() — indistinguishable) only ever
    // set `lastError` to a bare code, forever, with no cycle count and no
    // way to tell "one failing cycle" from "a thousand identical repeated
    // failures" from the outside. This is purely additive diagnostic
    // evidence — the existing catch-and-backoff (at-least-once) behavior
    // below is completely unchanged.
    this.log({stage:'owner_loop_failure',cycle:cycles,error:this.lastError});
    await delay(this.backoffMs,signal);}}}finally{this.running=false;}return{status:'STOPPED',cycles};}
}
function bounded(value){if(!Number.isInteger(value)||value<10||value>60000)throw new TypeError('owner loop interval is invalid');return value;}
function delay(ms,signal){return new Promise(resolve=>{if(signal?.aborted)return resolve();const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',done);clearTimeout(timer);resolve();}signal?.addEventListener('abort',done,{once:true});});}
