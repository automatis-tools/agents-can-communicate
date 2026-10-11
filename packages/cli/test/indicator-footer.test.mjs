import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify,stripVTControlCharacters} from 'node:util';
import test from 'node:test';
import {createIndicatorFixture} from '../../../tests/helpers/indicator-fixture.mjs';
const exec=promisify(execFile);
async function run(f,adapter,payload,args=[]) {
 const p=exec(process.execPath,[path.resolve('bin/acc-indicator.mjs'),'--adapter',adapter,...args],
  {env:{...process.env,ACC_DATA_HOME:f.dataHome},timeout:4000});
 p.child.stdin.end(JSON.stringify(payload));return (await p).stdout;
}
for(const [adapter,version,id] of [['kimi','2.1.1','sessionId'],['grok','1.0.46','session_id']]) {
 test(`${adapter}: current-session indicator and footer share one line without injected terminal controls`,async t=>{
  const f=await createIndicatorFixture(t,{adapterId:adapter,version});
  const payload={[id]:'native-session',model:adapter==='kimi'?'K3':{display_name:'Grok'},cwd:'/tmp/demo\x1b[31m\nBAD',
   context_window:{used_percentage:12},permissionMode:'auto',planMode:true};
  const out=await run(f,adapter,payload);
  assert.match(out,/\x1b\[22;1;38;2;44;122;57m●/);
  assert.match(stripVTControlCharacters(out),adapter==='kimi'?/^ACC ● · turn │ auto · plan · K3/:/^ACC ● · inbox │/);
  assert.equal(out.trimEnd().includes('\n'),false);
  assert.equal(out.includes('\x1b[31m'),false);
  const wrong=await run(f,adapter,{...payload,[id]:'different'});
  assert.match(stripVTControlCharacters(wrong),/^ACC !/);
 });
 test(`${adapter}: existing custom command receives identical stdin and stays on the first line`,async t=>{
  const f=await createIndicatorFixture(t,{adapterId:adapter,version});
  const file=path.join(f.root,'previous.mjs'),marker=path.join(f.root,'marker.json');
  await writeFile(file,`let s='';for await(const c of process.stdin)s+=c;console.log('mine:'+JSON.parse(s).${id});`);
  await writeFile(marker,JSON.stringify({previous:{command:`"${process.execPath}" "${file}"`}}));
  const out=stripVTControlCharacters(await run(f,adapter,{[id]:'native-session'},['--previous',marker]));
  assert.match(out,/^ACC ● · (turn|inbox) │ mine:native-session\n$/);
 });
}
test('Kimi welcome screen retains its footer without a spurious registration error',async t=>{
 const f=await createIndicatorFixture(t,{adapterId:'kimi',version:'2.1.1'});
 const out=await run(f,'kimi',{sessionId:'',model:'K3',cwd:'/tmp/demo',permissionMode:'manual'});
 assert.equal(stripVTControlCharacters(out),'K3 · /tmp/demo\n');
});

test('Kimi does not accept a different client session field as its own identity',async t=>{
 const f=await createIndicatorFixture(t,{adapterId:'kimi',version:'2.1.1'});
 const out=await run(f,'kimi',{session_id:'native-session',model:'K3'});
 assert.match(stripVTControlCharacters(out),/^ACC !/);
});

test('Kimi footer follows a user item edit without reinstalling ACC',async t=>{
 const f=await createIndicatorFixture(t,{adapterId:'kimi',version:'2.1.1'});
 const {configureKimiIndicator,kimiIndicatorPaths}=await import('../../adapter-kimi/src/indicator-install.mjs');
 const context={home:f.root,dataHome:f.dataHome,clientVersion:'2.1.1'};
 const {file,marker}=kimiIndicatorPaths(context);
 await writeFile(file,'[status_line]\nitems = ["cwd"]\n');
 await configureKimiIndicator(context,true);
 const {readFile}=await import('node:fs/promises');
 await writeFile(file,(await readFile(file,'utf8')).replace('["cwd"]','["model"]'));
 const out=stripVTControlCharacters(await run(f,'kimi',{sessionId:'native-session',model:'K3',cwd:'/tmp/hidden'},['--previous',marker]));
 assert.equal(out,'ACC ● · turn │ K3\n');
});
