#!/usr/bin/env node
// Disposable UI experiment. This only reads ACC through its public indicator.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFile} from 'node:fs/promises';
const execute=promisify(execFile);
let source='';
for await(const chunk of process.stdin){source+=chunk;if(Buffer.byteLength(source)>8192)throw Error('Input too large');}
const input=JSON.parse(source);
if(typeof input.thread_id!=='string'||!input.thread_id)throw Error('Missing thread identity');
const binary=process.env.ACC_INDICATOR_ENTRY;
if(!binary)throw Error('Set ACC_INDICATOR_ENTRY to the installed read-only reader.');
let report;
try {
 const {stdout}=await execute(process.execPath,[binary,'--adapter','codex','--native-session',input.thread_id,'--json'],{timeout:400,maxBuffer:8192});
 report=JSON.parse(stdout);
} catch { report={health:'problem',reception:null,reasonCode:'provider_unavailable'}; }
const glyph=report.health==='ready'?'●':report.health==='problem'?'!':'…';
const foreground=report.health==='ready'?[44,122,57]:report.health==='problem'?[150,108,30]:[102,102,102];
const suffix=(['turn','inbox'].includes(report.reception)?' · '+report.reception:'')+(report.health==='problem'?' · acc doctor':'');
const answer={spans:[{text:'ACC '},{text:glyph,foreground,bold:true},{text:suffix}]};
if(process.env.ACC_SPIKE_OBSERVATIONS)await appendFile(process.env.ACC_SPIKE_OBSERVATIONS,JSON.stringify({at:Date.now(),thread_id:input.thread_id,cwd:input.cwd,health:report.health,reception:report.reception})+'\n');
process.stdout.write(JSON.stringify(answer)+'\n');
