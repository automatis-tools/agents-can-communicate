#!/usr/bin/env node
// Local UI review uses the same filesystem reader as the installed indicator.
// Fixture state stays in the OS temporary directory and is removed on exit.
import http from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createIndicatorFixture } from "../tests/helpers/indicator-fixture.mjs";

const cleanups = [];
const lifecycle = { after: fn => cleanups.push(fn) };
const automatic = await createIndicatorFixture(lifecycle);
await automatic.service.publishDeliveryBinding(automatic.binding);
await automatic.attempt("active");
automatic.clock.advance(4 * 60_000);
const turn = await createIndicatorFixture(lifecycle, { adapterId: "gemini_cli", version: "0.57.0" });
await turn.attempt("unsupported", "native_delivery_unsupported");
const inbox = await createIndicatorFixture(lifecycle, { adapterId: "grok", version: "1.0.24" });
await inbox.attempt("unsupported", "native_delivery_unsupported");
const problem = await createIndicatorFixture(lifecycle);
await problem.attempt("degraded", "handshake_failed");
const absent = await createIndicatorFixture(lifecycle);
await rm(path.join(absent.dataHome, "acc", "native-workspaces"), { recursive: true });
const states = { automatic, turn, inbox, problem, absent };

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ACC indicator · local preview</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f1ed;color:#252924;font:15px system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}
main{width:min(920px,94vw);padding:36px 0}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}h1{font-size:24px;letter-spacing:-.7px;margin:0}header span{font-size:12px;color:#6b746a}
.terminal{background:#181b19;color:#d7dbd4;border-radius:12px;box-shadow:0 18px 44px #16231820;overflow:hidden;font:14px ui-monospace,SFMono-Regular,monospace}.bar{padding:14px 22px;border-bottom:1px solid #30382f;color:#83947f}.body{padding:32px 24px 20px;min-height:240px}.body b{font-size:20px;color:#eef3e9}.subtle{color:#83947f;margin-top:12px}.prompt{margin-top:65px;padding:15px 0;border-top:1px solid #424e40;border-bottom:1px solid #424e40}.caret{color:#dfe9d8}.footer{display:flex;gap:20px;align-items:center;justify-content:space-between;margin:12px 0 0;color:#9daa96;font-size:13px}#badge{font:inherit;color:#95c783;background:none;border:0;padding:3px;cursor:pointer;white-space:nowrap}#badge[data-health=problem]{color:#e5b973}
#details{border-top:1px solid #333d30;margin-top:18px;padding-top:18px;color:#c8d3c1;line-height:1.6}#action{color:#edc88b}.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:26px}.controls button{border:1px solid #d6dcd1;background:#fff;padding:10px 14px;border-radius:7px;color:#4b5847;cursor:pointer}.controls button[aria-pressed=true]{background:#243922;color:#f1f6ed;border-color:#243922}button:focus-visible{outline:3px solid #a5bd96;outline-offset:3px}.hint{margin-top:16px;color:#73806c;font-size:12px}
</style><main><header><h1>ACC</h1><span>Local indicator preview</span></header>
<div class="terminal"><div class="bar">project / feature</div><div class="body"><b>Claude Code</b><div class="subtle">Ready for your next message</div><div class="prompt"><span class="caret">❯</span> <span class="subtle">Ask anything</span></div><div class="footer"><span>user status line</span><button id="badge" aria-expanded="false">ACC …</button></div><div id="details" hidden><div id="explanation"></div><div id="action"></div></div></div></div>
<div class="controls"><button data-state="automatic" aria-pressed="true">Automatic · idle</button><button data-state="turn">Next turn</button><button data-state="inbox">Inbox</button><button data-state="problem">Delivery problem</button><button data-state="absent">Not registered</button></div><div class="hint">Filesystem fixtures · production reader</div></main>
<script>
const badge=document.getElementById('badge'),details=document.getElementById('details');
async function show(state){const r=await fetch('/state/'+state).then(r=>r.json());badge.textContent=r.label;badge.dataset.health=r.health;document.getElementById('explanation').textContent=r.detail;document.getElementById('action').textContent=r.action||'';for(const b of document.querySelectorAll('[data-state]'))b.setAttribute('aria-pressed',String(b.dataset.state===state));}
document.querySelector('.controls').onclick=e=>{if(e.target.dataset.state)show(e.target.dataset.state)};
badge.onclick=()=>{details.hidden=!details.hidden;badge.setAttribute('aria-expanded',String(!details.hidden))};show('automatic');
</script></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page); return; }
  const state = states[req.url?.slice(7)];
  if (!req.url?.startsWith("/state/") || !state) { res.writeHead(404); res.end(); return; }
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(await state.read()));
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
async function close() { server.close(); await Promise.all(cleanups.map(fn => fn())); process.exit(0); }
process.once("SIGINT", close);
process.once("SIGTERM", close);
