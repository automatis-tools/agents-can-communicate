// Removing the post-audit abort decision falsely succeeds; keeping validation
// handlers active after cleanup commitment misclassifies a destructive phase.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fixture, waitForOwnedProcessExit } from "../helpers/push-fixture.mjs";

const exec = promisify(execFile);
function bounded(promise, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(description)), 10000);
  })]).finally(() => clearTimeout(timer));
}
function message(child, event) {
  return bounded(new Promise(resolve => {
    const listen = value => {
      if (value.event !== event) return;
      child.off("message", listen);
      resolve(value);
    };
    child.on("message", listen);
  }), `validator did not send ${event}`);
}

for (const phase of ["audit", "remove"]) {
  test(`interruption boundary during final ${phase}`, { timeout: 30000, skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    const realGit = (await exec("which", ["git"])).stdout.trim();
    const bin = path.join(f.base, "bin");
    const armed = path.join(f.base, "armed");
    const endpoint = path.join(f.base, "phase.sock");
    await mkdir(bin);
    // Execute actual Git after one IPC-controlled pause. The callback arms this
    // outside the tree, so preparation audits never trigger the final-audit case.
    await writeFile(path.join(bin, "git"), `#!/usr/bin/env node
      const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
      const args=process.argv.slice(2);
      const selected=${JSON.stringify(phase)}==='audit'?args.includes('--show-toplevel'):
        args.includes('worktree')&&args.includes('remove');
      (async()=>{
        if(selected&&fs.existsSync(${JSON.stringify(armed)})){
          fs.renameSync(${JSON.stringify(armed)},${JSON.stringify(`${armed}-used`)});
          await new Promise((resolve,reject)=>{
            const socket=net.connect(${JSON.stringify(endpoint)},()=>socket.write(JSON.stringify({pid:process.pid,args})+'\\n'));
            socket.once('error',reject);socket.once('data',()=>{socket.end();resolve();});
          });
        }
        const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
        process.exit(result.status??1);
      })().catch(error=>{console.error(error.message);process.exit(1);});
    `, { mode: 0o755 });
    let connection;
    const server = net.createServer();
    const reached = bounded(new Promise(resolve => server.once("connection", socket => {
      connection = socket;
      let bytes = "";
      socket.on("data", data => {
        bytes += data;
        if (bytes.includes("\n")) resolve(JSON.parse(bytes.trim()));
      });
    })), "Git did not reach selected phase");
    await new Promise(resolve => server.listen(endpoint, resolve));
    const helper = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/push-targets.mjs")).href;
    // Programmatic emit observes an absent handler without default OS process
    // termination. Actual post-boundary signals follow the caller/OS policy.
    const source = `import {withPushCheckout} from ${JSON.stringify(helper)};import{writeFileSync}from'node:fs';
      let signal;process.on('message',value=>{if(value.event==='interrupt'){
        const handled=process.emit('SIGTERM');process.send({event:'interrupt',handled,aborted:signal.aborted});
      }});
      try{await withPushCheckout(process.cwd(),{commit:${JSON.stringify(await f.oid())},checkout:'isolated'},async(cwd,observed)=>{
        signal=observed;writeFileSync(${JSON.stringify(armed)},'armed');process.send({event:'callback',cwd});
      });process.send({event:'result',ok:true,aborted:signal.aborted});}
      catch(error){process.send({event:'result',ok:false,error:error.message,aborted:signal?.aborted});process.exitCode=1;}
      process.disconnect();`;
    const env = { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}` };
    delete env.CODEX_HOME;
    delete env.AGENTS_HOME;
    const validator = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: f.root, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    validator.stderr.on("data", bytes => { stderr += bytes; });
    validator.stdout.resume();
    const closed = new Promise(resolve => validator.once("close", resolve));
    const callback = message(validator, "callback");
    const result = message(validator, "result");
    let owned;
    let shimPid;
    try {
      owned = (await callback).cwd;
      const paused = await reached;
      shimPid = paused.pid;
      t.diagnostic(`paused ${phase}: Git shim PID ${paused.pid}, args=${JSON.stringify(paused.args)}`);
      assert.equal(await f.exists(owned), true, "checkout disappeared before paused Git operation");
      const interrupted = message(validator, "interrupt");
      validator.send({ event: "interrupt" });
      const observed = await interrupted;
      t.diagnostic(`${phase} interruption: handled=${observed.handled}, controller aborted=${observed.aborted}`);
      connection.end("continue\n");
      const outcome = await result;
      const code = await bounded(closed, `validator did not exit: ${stderr}`);
      if (phase === "audit") {
        assert.equal(observed.handled, true, "final byte audit must remain inside validation interruption handling");
        assert.equal(observed.aborted, true);
        assert.equal(outcome.ok, false, "handled final-audit interruption falsely reported success");
        assert.notEqual(code, 0);
        assert.match(outcome.error, /interrupted.*checkout retained/);
        assert.equal(await f.exists(owned), true);
      } else {
        assert.equal(observed.handled, false, "validation interruption handler remained active after cleanup commitment");
        assert.equal(observed.aborted, false, "cleanup-phase event was misclassified as handled validation interruption");
        assert.equal(outcome.ok, true);
        assert.equal(code, 0);
        assert.equal(await f.exists(owned), false);
      }
    } finally {
      if (connection && !connection.writableEnded) connection.end("continue\n");
      await bounded(closed, "validator teardown stalled").catch(async () => {
        validator.kill("SIGKILL"); await closed;
      });
      connection?.destroy();
      await new Promise(resolve => server.close(resolve));
      if (shimPid) await waitForOwnedProcessExit([shimPid]);
      if (owned && await f.exists(owned)) await f.git(["worktree", "remove", "--force", owned]);
      if (owned) await rm(path.dirname(owned), { recursive: true, force: true });
    }
  });
}
