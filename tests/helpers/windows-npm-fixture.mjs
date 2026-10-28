// Native Windows uses real cmd/npm.cmd. Other hosts bridge only the fixed query
// to /bin/sh; the shim, preload, recorded npm CLI and final Node are real children.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const query = "npm --version --offline --update-notifier=false --logs-max=0 --color=false";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export async function windowsNpmFixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-npm-shim-")));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = path.join(root, "checkout & (data) %PATH% !literal! ^caret");
  await mkdir(cwd);
  const record = path.join(root, "record.jsonl");
  const env = { ...process.env, ACC_NPM_RECORD: record, ACC_NPM_MARKER: "original" };
  for (const key of Object.keys(env)) if (/^(PATH|NODE_OPTIONS|NODE_TEST_CONTEXT)$/i.test(key)) delete env[key];
  const preload = path.join(root, "original preload.cjs");
  await writeFile(preload, "process.env.ACC_ORIGINAL_PRELOAD = 'ran';\n");
  env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  const node = path.join(root, process.platform === "win32" ? "other node.exe" : "other node");
  await copyFile(process.execPath, node);
  await chmod(node, 0o755);
  const clis = [];
  const bins = [];
  for (const label of ["first", "second"]) {
    const pkg = path.join(root, `external ${label} & (npm) %PATH% !literal! ^caret`);
    const bin = path.join(root, label);
    await mkdir(pkg); await mkdir(bin);
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "npm", type: "module",
      bin: label === "first" ? { npm: "entry.mjs" } : "entry.mjs" }));
    const cli = path.join(pkg, "entry.mjs");
    await writeFile(cli, `import {appendFileSync} from 'node:fs';
      appendFileSync(process.env.ACC_NPM_RECORD, JSON.stringify({label:${JSON.stringify(label)},
        node:process.execPath,args:process.argv.slice(2),cwd:process.cwd(),env:process.env})+'\\n');
      if (process.argv[2] === '--version') console.log('1.0.0');`);
    const helper = path.join(pkg, "npm-prefix.js");
    await writeFile(helper, "// npm's non-bin prefix helper must not record an executor\n");
    env[`ACC_FIXTURE_CLI_${label}`] = cli;
    env[`ACC_FIXTURE_HELPER_${label}`] = helper;
    await writeFile(path.join(bin, "npm.cmd"), `@echo off\r\n"%ACC_FIXTURE_NODE%" "%ACC_FIXTURE_HELPER_${label}%"\r\n"%ACC_FIXTURE_NODE%" "%ACC_FIXTURE_CLI_${label}%" %*\r\n`);
    await writeFile(path.join(bin, "npm"), `#!/bin/sh\n${quote(node)} ${quote(helper)}\nexec ${quote(node)} ${quote(cli)} "$@"\n`);
    await chmod(path.join(bin, "npm"), 0o755);
    bins.push(bin); clis.push(await realpath(cli));
  }
  const adjacent = path.join(bins[0], "node_modules/npm");
  await mkdir(path.join(adjacent, "bin"), { recursive: true });
  await writeFile(path.join(adjacent, "package.json"), '{"name":"npm","bin":{"npm":"bin/npm-cli.js"}}');
  await writeFile(path.join(adjacent, "bin/npm-cli.js"), "throw Error('wrong npm selected');");
  env.ACC_FIXTURE_NODE = node;
  env.ComSpec ??= process.platform === "win32" ? process.env.ComSpec : "/bin/sh";
  env.PATH = [bins[0], bins[1], path.dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)].join(path.delimiter);
  // An old PATH/node_modules resolver must never accidentally run real ACC npm.
  const calls = [];
  const launch = (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === "/d") {
      assert.deepEqual(args, ["/d", "/v:off", "/s", "/c", query]);
      return process.platform === "win32" ? spawn(file, args, options) : spawn("/bin/sh", ["-c", query], { ...options, env: { ...options.env,
        PATH: Object.entries(options.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] } });
    }
    assert.equal(options.shell, false, "validation must stay shell-free");
    assert.ok(clis.includes(args[0]), "selected shim must win over unrelated adjacent npm");
    return spawn(file, args, options);
  };
  return { root, cwd, node: await realpath(node), clis, bins, env, calls, launch,
    records: async () => (await readFile(record, "utf8")).trim().split("\n").map(JSON.parse) };
}


// Exercise the unchanged public entry point. Only its command-boundary import
// uses a private wrapper to select Windows npm and inject controlled failures.
export async function publicNpmFailure(t, f, mode) {
  const target = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/push-targets.mjs")).href;
  const entry = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/validate-push.mjs")).href;
  const wrapper = path.join(f.base, "public-npm-wrapper.mjs");
  const preload = path.join(f.base, "public-npm-loader.mjs");
  const record = path.join(f.base, "public-npm-probe.json");
  await writeFile(wrapper, `export * from ${JSON.stringify(target)};
    import {runPushCommand as original} from ${JSON.stringify(target)};
    import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
    import {writeFileSync} from 'node:fs';
    export function runPushCommand(file,args,options) {
      if(file!=='npm') return original(file,args,options);
      return original(file,args,{...options,platform:'win32',
        env:{ComSpec:process.env.ComSpec ?? process.env.COMSPEC ?? '/bin/sh'},spawnCommand:(file,args,options)=>{
          const child=Object.assign(new EventEmitter(),{pid:12345,unref(){},stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
          if(file==='taskkill') queueMicrotask(()=>child.emit('close',0));
          else {
            if(args[0]!=='/d') throw Error('unexpected final validation');
            writeFileSync(${JSON.stringify(record)},JSON.stringify(options.env.ACC_PUSH_NPM_PROBE));
            queueMicrotask(()=>${JSON.stringify(mode)}==='forced' ? child.stdout.write(Buffer.alloc(65537)) : child.emit('close',0));
          }
          return child;
        }});
    }`);
  await writeFile(preload, `import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){
      if(context.parentURL===${JSON.stringify(entry)} && specifier==='./push-targets.mjs')
        return {url:${JSON.stringify(pathToFileURL(wrapper).href)},shortCircuit:true};
      return next(specifier,context);
    }});`);
  const oid = await f.oid();
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.resolve(import.meta.dirname, "../../scripts/validate-push.mjs"), "--remote", "origin"], {
    cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(`refs/heads/main ${oid} refs/heads/main ${"0".repeat(oid.length)}\n`);
  const result = await completed;
  const output = JSON.parse(await readFile(record, "utf8"));
  t.after(() => rm(path.dirname(output), { recursive: true, force: true }));
  return { ...result, output };
}
