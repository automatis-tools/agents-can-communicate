import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {configureTomlIndicator} from '../src/toml-indicator.mjs';

async function fixture(t, source) {
 const dir=await mkdtemp(path.join(tmpdir(),'acc-toml-indicator-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'tui.toml'), marker=path.join(dir,'marker.json');
 if(source!==null)await writeFile(file,source);
 return {file,marker,table:['status_line'],enabled:true,set:{command:'acc-reader'},defaults:{},dir};
}

test('indicator wraps a quoted TOML table and restores the exact original bytes',async t=>{
 const source='# keep\r\ntheme = "light"\r\n["status_line"] # footer\r\ncommand = \'user command\' # mine\r\nitems = ["cwd",\n "model"]\r\n[editor]\r\ncommand = "vim"\r\n';
 const f=await fixture(t,source);
 await configureTomlIndicator(f);
 const saved=JSON.parse(await readFile(f.marker));
 assert.equal(saved.previous.command,'user command');
 assert.deepEqual(saved.previous.items,['cwd','model']);
 assert.match(await readFile(f.file,'utf8'),/command = "vim"/);
 await configureTomlIndicator(f);
 assert.equal(JSON.parse(await readFile(f.marker)).previous.command,'user command');
 await configureTomlIndicator({...f,enabled:false});
 assert.equal(await readFile(f.file,'utf8'),source);
});

test('indicator preserves later user edits through refresh and removal',async t=>{
 const f=await fixture(t,'theme = "light"\n[status_line]\ncommand = "old"\nitems = ["cwd"]\n');
 await configureTomlIndicator(f);
 let edited=(await readFile(f.file,'utf8')).replace('"light"','"dark"').replace('["cwd"]','["model"]');
 await writeFile(f.file,edited);
 await configureTomlIndicator(f);
 await configureTomlIndicator({...f,enabled:false});
 assert.equal(await readFile(f.file,'utf8'),edited.replace('"acc-reader"','"old"'));
 await configureTomlIndicator(f);
 edited=(await readFile(f.file,'utf8')).replace('"acc-reader"','"new-user-command"');
 await writeFile(f.file,edited);
 await configureTomlIndicator(f);
 await configureTomlIndicator({...f,enabled:false});
 assert.equal(await readFile(f.file,'utf8'),edited);
});

test('indicator ignores fake table headers in multiline TOML and removes files it created',async t=>{
 const source='note = """\n[status_line]\ncommand = "not a command"\n"""\n';
 const f=await fixture(t,source);
 await configureTomlIndicator(f);
 assert.equal(JSON.parse(await readFile(f.marker)).previous.command,undefined);
 await configureTomlIndicator({...f,enabled:false});
 assert.equal(await readFile(f.file,'utf8'),source);
 const absent=await fixture(t,null);
 await configureTomlIndicator(absent);
 await configureTomlIndicator(absent);
 await configureTomlIndicator({...absent,enabled:false});
 await assert.rejects(readFile(absent.file),{code:'ENOENT'});
});

test('ambiguous inline or duplicate status settings fail before any write',async t=>{
 for(const source of ['status_line = {command="old"}\n','[status_line]\ncommand="one"\ncommand="two"\n','[status_line]\ncommand="unterminated\n']) {
  const f=await fixture(t,source);
  await assert.rejects(configureTomlIndicator(f),/TOML/);
  assert.equal(await readFile(f.file,'utf8'),source);
  await assert.rejects(readFile(f.marker),{code:'ENOENT'});
 }
});

test('a replacement command disowns all presentation fields that ACC installed',async t=>{
 const f=await fixture(t,'[status_line]\ntype = "builtin"\n');
 f.set={command:'acc-reader',type:'command'};f.defaults={refresh_interval:1};
 await configureTomlIndicator(f);
 const edited=(await readFile(f.file,'utf8')).replace('"acc-reader"','"user-replacement"');
 await writeFile(f.file,edited);
 await configureTomlIndicator(f);
 await configureTomlIndicator({...f,enabled:false});
 assert.equal(await readFile(f.file,'utf8'),edited);
});

test('nested status tables and dotted descendants cannot be overwritten by scalar settings',async t=>{
 for(const source of ['[status_line.command]\nargument = "custom"\n','[status_line]\ncommand.argument = "custom"\n']) {
  const f=await fixture(t,source);
  await assert.rejects(configureTomlIndicator(f),/TOML/);
  assert.equal(await readFile(f.file,'utf8'),source);
  await assert.rejects(readFile(f.marker),{code:'ENOENT'});
 }
});

test('a failed config write leaves installation retryable', {skip: process.platform==='win32'||process.getuid?.()===0},async t=>{
 const {chmod}=await import('node:fs/promises');
 const f=await fixture(t,'[status_line]\ncommand = "old"\n');
 await chmod(f.file,0o444);
 await assert.rejects(configureTomlIndicator(f),{code:'EACCES'});
 await chmod(f.file,0o644);
 await configureTomlIndicator(f);
 assert.match(await readFile(f.file,'utf8'),/command = "acc-reader"/);
 await configureTomlIndicator({...f,enabled:false});
 assert.equal(await readFile(f.file,'utf8'),'[status_line]\ncommand = "old"\n');
});
