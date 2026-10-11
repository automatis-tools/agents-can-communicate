import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createKimiAdapter} from '../../adapter-kimi/src/adapter.mjs';
import {createGrokAdapter} from '../../adapter-grok/src/adapter.mjs';

for(const [create,version,key,file] of [[createKimiAdapter,'2.1.1','status_line','tui.toml'],[createGrokAdapter,'1.0.46','ui.status_line','config.toml']]) {
 test(`${file}/${key}: install composes the user's command and uninstall restores it`,async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'acc-footer-install-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const adapter=create(),clientHome=path.join(home,adapter.id);
  const context={home,kimiHome:clientHome,grokHome:clientHome,dataHome:path.join(home,'data'),indicator:'on',clientVersion:version};
  const config=path.join(clientHome,file),old=`# my theme\n[${key}]\ncommand = "my-footer"\nitems = ["model", "cwd"]\n`;
  await mkdir(clientHome,{recursive:true});await writeFile(config,old);
  await adapter.install(context);
  const installed=await readFile(config,'utf8');
  assert.match(installed,/acc-indicator/);
  assert.match(installed,/items = \["model", "cwd"\]/);
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
