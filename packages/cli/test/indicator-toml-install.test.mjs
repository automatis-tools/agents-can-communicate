import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createKimiAdapter} from '../../adapter-kimi/src/adapter.mjs';
import {createGrokAdapter} from '../../adapter-grok/src/adapter.mjs';
import {readTomlIndicatorSettings} from '@agents-can-communicate/adapter-sdk';
import {runInShell} from '../../../tests/helpers/host-shells.mjs';

const platforms = process.platform === 'win32' ? ['win32'] : [process.platform, 'win32'];

for(const [create,version,key,file] of [[createKimiAdapter,'2.1.1','status_line','tui.toml'],[createGrokAdapter,'1.0.46','ui.status_line','config.toml']]) {
 for(const hostPlatform of platforms) test(`${file}/${key} (${hostPlatform} command): install composes the user's command and uninstall restores it`,async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'acc-footer-install-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const adapter=create(),clientHome=path.join(home,adapter.id);
  const reader=path.join(home,'footer-reader.mjs');
  await writeFile(reader,`import {readFile} from 'node:fs/promises';
    let input='';for await(const chunk of process.stdin)input+=chunk;
    const args=process.argv.slice(2),saved=JSON.parse(await readFile(args[3],'utf8'));
    console.log(JSON.stringify({args,input,previous:saved.previous.command}));`);
  const context={home,kimiHome:clientHome,grokHome:clientHome,dataHome:path.join(home,'data'),
    indicator:'on',clientVersion:version,indicatorRunner:reader,hostPlatform};
  const config=path.join(clientHome,file),old=`# my theme\n[${key}]\ncommand = "my-footer"\nitems = ["model", "cwd"]\n`;
  await mkdir(clientHome,{recursive:true});await writeFile(config,old);
  await adapter.install(context);
  const installed=await readFile(config,'utf8');
  const settings=await readTomlIndicatorSettings({file:config,table:key.split('.')});
  const input=JSON.stringify({sessionId:'current-session',session_id:'current-session'});
  const {stdout}=await runInShell(process.platform==='win32'?'cmd':'sh',settings.command,{input});
  const report=JSON.parse(stdout);
  assert.deepEqual(report.args.slice(0,3),['--adapter',adapter.id,'--previous']);
  assert.equal(report.input,input);
  assert.equal(report.previous,'my-footer');
  assert.deepEqual(settings.items,['model','cwd']);
  await adapter.install(context);
  assert.equal(await readFile(config,'utf8'),installed);
  await adapter.uninstall(context);
  assert.equal(await readFile(config,'utf8'),old);
 });
 test(`${file}/${key}: unsupported versions keep the footer untouched`,async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'acc-footer-floor-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const adapter=create(),clientHome=path.join(home,adapter.id);
  await mkdir(clientHome,{recursive:true});const config=path.join(clientHome,file),old=`[${key}]\ncommand = "user"\n`;
  await writeFile(config,old);
  await adapter.install({home,kimiHome:clientHome,grokHome:clientHome,indicator:'on',clientVersion:'0.1.0'});
  assert.equal(await readFile(config,'utf8'),old);
 });
}
