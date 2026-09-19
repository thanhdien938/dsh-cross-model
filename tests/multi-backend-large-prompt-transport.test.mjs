import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

import {runClaudeProcess} from '../src/session/claude-code-session-bridge.mjs';
import {runCodexCliProcess} from '../src/session/codex-cli-session-bridge.mjs';
import {runAntigravityCliProcess} from '../src/session/antigravity-cli-session-bridge.mjs';

const codexOutput=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}});
const antigravityOutput=JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ok'}});

function capturingSpawn({stdout='',capture={},stdinError=null}={}){
  return(binary,args,options)=>{
    Object.assign(capture,{binary,args,options,stdin:''});
    const child=new EventEmitter();
    child.stdout=new PassThrough();
    child.stderr=new PassThrough();
    child.stdin=new PassThrough();
    child.kill=()=>true;
    child.stdin.setEncoding('utf8');
    child.stdin.on('data',chunk=>capture.stdin+=chunk);
    if(stdinError){
      child.stdin.on('error',()=>{});
      queueMicrotask(()=>child.stdin.emit('error',stdinError));
    }else{
      queueMicrotask(()=>{
        child.stdout.end(stdout);
        child.stderr.end();
        queueMicrotask(()=>child.emit('close',0));
      });
    }
    return child;
  };
}

function realPipeSpawn({provider,capture}){
  return(binary,args,options)=>{
    Object.assign(capture,{binary,args:[...args],options});
    const fixture=[
      "const {createHash}=require('node:crypto');let input='';",
      "process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);",
      "process.stdin.on('end',()=>{",
      provider==='antigravity'?"const prompt=JSON.parse(input).message.content;":"const prompt=input;",
      "const report={stdinChars:input.length,stdinBytes:Buffer.byteLength(input),promptChars:prompt.length,promptBytes:Buffer.byteLength(prompt),promptSha256:createHash('sha256').update(prompt).digest('hex')};",
      provider==='antigravity'
        ?"process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:JSON.stringify(report)}}));"
        :"process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report)}}));",
      "});",
    ].join('');
    return spawn(process.execPath,['-e',fixture],{...options,shell:false});
  };
}

const sha256=value=>createHash('sha256').update(value).digest('hex');

test('Codex small prompt uses documented stdin sentinel with bounded control argv',async()=>{
  const capture={};
  await runCodexCliProcess({binary:'codex-safe',prompt:'small prompt',model:'gpt-5.6-sol',reasoning:'high',spawnImpl:capturingSpawn({stdout:codexOutput,capture})});
  assert.equal(capture.stdin,'small prompt');
  assert.equal(capture.args.at(-1),'-');
  assert.equal(capture.args.includes('small prompt'),false);
  assert.deepEqual(capture.options.stdio,['pipe','pipe','pipe']);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'),capture.args.indexOf('--model')+2),['--model','gpt-5.6-sol']);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('-c'),capture.args.indexOf('-c')+2),['-c','model_reasoning_effort=high']);
});

test('Codex 250k+ prompt is absent from argv and reaches stdin byte-complete',async()=>{
  const prompt=`CODEX-LARGE-START\n${'x'.repeat(260_000)}\nCODEX-LARGE-END`;
  const capture={};
  const out=await runCodexCliProcess({binary:'codex-safe',prompt,timeoutMs:5_000,spawnImpl:realPipeSpawn({provider:'codex',capture})});
  assert.equal(capture.args.includes(prompt),false);
  assert.ok(capture.args.join(' ').length<1000);
  const report=JSON.parse(out.events[0].item.text);
  assert.equal(report.promptChars,prompt.length);
  assert.equal(report.promptBytes,Buffer.byteLength(prompt));
  assert.equal(report.promptSha256,sha256(prompt));
});

test('Codex stdin failure is typed CODEX_STDIN_FAILED',async()=>{
  await assert.rejects(runCodexCliProcess({binary:'codex-safe',prompt:'p',spawnImpl:capturingSpawn({stdinError:new Error('broken pipe')})}),error=>error?.code==='CODEX_STDIN_FAILED');
});

test('Antigravity small prompt uses proven stream-json stdin transport and preserves flags',async()=>{
  const capture={};
  await runAntigravityCliProcess({binary:'agy-safe',prompt:'small prompt',model:'gemini-3.1-pro-high',reasoning:'high',timeoutMs:20_000,spawnImpl:capturingSpawn({stdout:antigravityOutput,capture})});
  assert.equal(capture.args.includes('small prompt'),false);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--input-format'),capture.args.indexOf('--input-format')+2),['--input-format','stream-json']);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--mode'),capture.args.indexOf('--mode')+2),['--mode','plan']);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--output-format'),capture.args.indexOf('--output-format')+2),['--output-format','stream-json']);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'),capture.args.indexOf('--model')+2),['--model','gemini-3.1-pro-high']);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--effort'),capture.args.indexOf('--effort')+2),['--effort','high']);
  assert.deepEqual(capture.args.slice(capture.args.indexOf('--print-timeout'),capture.args.indexOf('--print-timeout')+2),['--print-timeout','20s']);
  assert.deepEqual(capture.options.stdio,['pipe','pipe','pipe']);
  assert.equal(JSON.parse(capture.stdin).message.content,'small prompt');
});

test('Antigravity 250k+ prompt is absent from argv/path and reaches stdin envelope byte-complete',async()=>{
  const prompt=`AGY-LARGE-START\n${'y'.repeat(260_000)}\nAGY-LARGE-END`;
  const capture={};
  const out=await runAntigravityCliProcess({binary:'agy-safe',prompt,timeoutMs:5_000,spawnImpl:realPipeSpawn({provider:'antigravity',capture})});
  assert.equal(capture.args.includes(prompt),false);
  assert.ok(capture.args.join(' ').length<1000);
  assert.equal(capture.args.some(arg=>typeof arg==='string'&&arg.includes('AGY-LARGE-START')),false);
  const report=JSON.parse(out.result.response);
  assert.equal(report.promptChars,prompt.length);
  assert.equal(report.promptBytes,Buffer.byteLength(prompt));
  assert.equal(report.promptSha256,sha256(prompt));
});

test('Antigravity stdin failure is typed ANTIGRAVITY_STDIN_FAILED',async()=>{
  await assert.rejects(runAntigravityCliProcess({binary:'agy-safe',prompt:'p',spawnImpl:capturingSpawn({stdinError:new Error('broken pipe')})}),error=>error?.code==='ANTIGRAVITY_STDIN_FAILED');
});

test('Claude stdin transport remains prompt-complete and prompt-free in argv',async()=>{
  const capture={};
  await runClaudeProcess({binary:'claude-safe',prompt:'claude prompt',spawnImpl:capturingSpawn({stdout:JSON.stringify({result:'ok'}),capture})});
  assert.equal(capture.stdin,'claude prompt');
  assert.equal(capture.args.includes('claude prompt'),false);
  assert.deepEqual(capture.options.stdio,['pipe','pipe','pipe']);
});
