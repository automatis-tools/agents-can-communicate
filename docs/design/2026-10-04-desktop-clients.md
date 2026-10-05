# Desktop clients: Antigravity 2.0, Claude Code in Claude.app, Codex in ChatGPT.app

## Problem

ACC's integrations were built and captured against terminal clients. Each vendor now also ships
a desktop app that runs the same agent engine, reads the same hook configuration, and therefore
already runs ACC's hooks:

- **Antigravity 2.0** (`/Applications/Antigravity.app`) runs ACC's `~/.gemini/config/hooks.json`.
  A desktop conversation joins ACC and receives messages at its next model invocation, but live
  delivery never starts: the relay that serves Antigravity CLI cannot start inside the desktop's
  command sandbox, and ACC does not recognise the desktop's process as the client.
- **Claude Code in Claude.app** (the Code tab, Local environment) runs Claude Code's own binary
  with the user's `~/.claude`. Live delivery already works, but ACC reports the version of the
  `claude` on PATH instead of the build the app runs.
- **Codex in ChatGPT.app** runs every window on a private stdio app-server (openai/codex#41014).
  ACC attaches its threads through hooks, and every live attempt is recorded as
  `handshake_failed`, which names a symptom instead of the cause.

Issue #171's reporter found that the desktop language server takes its CSRF token on its command
line, and pushed a message into a desktop conversation with it. This design turns that finding
into a supported delivery path and fixes the client identity that all three apps expose.

## Evidence

Captured 2026-10-04 on macOS 27.0 arm64 with ACC 0.8.5 installed, on the maintainer's machine.

### Antigravity 2.19.1 (desktop)

| Observation | Result |
|---|---|
| Process | `Antigravity.app/Contents/MacOS/Antigravity` starts `Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --subclient_type hub --override_ide_version 2.19.1 … --https_server_port 0 --csrf_token <uuid> --app_data_dir antigravity …`. One language server serves every window and conversation. |
| Ports | The language server listens on two loopback ports, HTTPS (gRPC) and HTTP; its log names both ("listening on random port at N for HTTP"). `agentapi` talks to the HTTP one. |
| Hooks | `SessionStart` and `PreInvocation` from `~/.gemini/config/hooks.json` ran as **direct children of `language_server`**; no `agy` process is involved. |
| ACC session | A participant attached (`antigravity-…`), `clientPid: null`, `clientVersion: 1.2.16` (the `agy` on PATH), native attempt `degraded / client_process_unknown`, so the relay was never even suggested. |
| Next turn | `PreInvocation` injected the queued ACC message into the model's context. |
| Tool shell | Carries `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_AGENTAPI_EXE` and six more, **but every command runs in a sandbox**: `ps` and ACC's own `acc-cli.sh` fail with `operation not permitted`. The model then retries with `BypassSandbox`, which raises an approval prompt. |
| Permissions | "Always allow" writes `command(<wrapper>)` to `~/.gemini/config/config.json` → `userSettings.globalPermissionGrants.allow`. The desktop does not read Antigravity CLI's `~/.gemini/antigravity-cli/settings.json`, where ACC writes its rule today. |
| Push | `agy agentapi send-message` with the language server's argv token and HTTP port woke an idle desktop conversation within one second. The model saw a `SYSTEM_MESSAGE`, read the `acc` skill from `~/.gemini/config/plugins/acc`, and answered with `acc reply` once the sandbox bypass was approved. |
| agentapi | The app ships no `agy`. It installs `~/.gemini/antigravity/bin/agentapi`, a shell script that runs `language_server agentapi "$@"`; the language server binary itself serves `agentapi --help`, `send-message` and `get-conversation-metadata`. |
| Side effects | The first launch's wizard installed `/Applications/Antigravity IDE.app` and copied `~/.gemini/antigravity` twice; the app added 241 files under `~/.gemini/config/plugins`, which Antigravity CLI also loads. |

### Claude Code 2.1.286 in Claude.app (Local)

| Observation | Result |
|---|---|
| Process | `Claude.app` → `Contents/Helpers/disclaimer` → `~/Library/Application Support/Claude/claude-code/2.1.286/<hash>/claude.app/Contents/MacOS/claude`. `ps` reports the full path as the command. |
| Registry | `~/.claude/sessions/<pid>.json`: `kind: interactive`, `entrypoint: claude-desktop`, `version: 2.1.286`, `messagingSocketPath: /tmp/cc-socks/<pid>.sock`. |
| ACC session | Attached as managed, `liveDelivery: true`, but `clientVersion: 2.1.289` - the `claude` on PATH. |
| Live | A question sent at 02:59:39 woke the idle session through its inbox; `UserPromptSubmit` showed the body at 02:59:40; the model answered with `acc reply` at 02:59:49 and the original was acknowledged. |

The PATH probe is wrong for terminal sessions too: Claude Code updates itself in place, so a
session started before an update reports the new version (session 65378 runs 2.1.284; PATH says
2.1.289). The session registry records the version that is running.

### Codex in ChatGPT.app 26.928

Read from the machine without starting a turn: each desktop window runs
`…/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server` over
stdio, never the shared daemon socket, because the app always passes config overrides
(openai/codex#41014). Desktop threads carry `"originator":"codex_work_desktop"`; ACC attached four
of them with `clientPid` = that private app-server; every native attempt reads `handshake_failed`.

## Decisions

Made by the maintainer on 2026-10-04:

1. **ACC reads the desktop language server's endpoint itself.** The token is on the language
   server's command line, which every process on the machine can read already. ACC reads it at
   the moment it delivers, from the one process its own hooks run under, and never stores it.
   No relay and no command for the agent to run.
2. Whether a woken desktop agent can answer without anyone at the screen - the allow rule
   against the sandbox bypass - is settled by the candidate's product capture.
3. Codex desktop gets an honest reason now; live delivery waits for openai/codex#41014.
4. Claude desktop needs no adapter change beyond its version.

## Design

### 1. The running client says who and what version it is

Today the hook runner walks its ancestry for the adapter's `client.command` and asks the binary
on PATH for `--version`. Both answers can name a different program than the one running.

**SDK.** `defineAdapter` accepts two optional members:

- `client.variants: [{ certificationName, displayName }]` - other products whose hooks this
  adapter serves. Certification evidence may name the primary `certificationName` or a variant.
- `identifyClientProcess(entry)` - called with each ancestor `{ comm, args }` while the runner
  walks up from the hook. It returns `null` (not the client) or
  `{ certificationName?, version? }`. A variant name must be declared. Pure and synchronous: it
  reads only the entry it is given. Adapters without it keep today's basename/script match.
- `clientVersionOf({ pid, entry, env })` - optional, asynchronous, bounded by the hook's budget:
  the version of the running client, or `null`.

**Hook runner.** `sessionStart` keeps the PATH probe running in parallel with the process-table
read, as now, and then takes the first of:

1. the version `identifyClientProcess` returned;
2. `clientVersionOf` for the resolved pid;
3. the client's own executable, when `ps` reports it as an absolute path named like the client
   command (`<that path> --version`);
4. the PATH probe.

The session binding gains an optional `clientName` (the certification name) beside
`clientVersion`. `loadSessionBinding` already ignores fields it does not know, so an older
runtime reading a newer binding is unaffected. `capabilityEvidence` and `effectiveCapabilities`
take `clientName` and select evidence rows by it, defaulting to the primary name.

**Claude Code** implements `clientVersionOf` from `<CLAUDE_CONFIG_DIR or ~/.claude>/sessions/<pid>.json`
(`version`), the record its inbox delivery already reads. **Codex** gains nothing new: the
desktop's private app-server is reported with its full path, so rule 3 runs it.

### 2. Native delivery contracts per protocol

A native contract keeps one `minimum`, the first passing capture of the primary client. An
anchor may now name another declared client:
`{ version, protocolContract, client }`. Each protocol contract's floor is its earliest anchor.
`validateNativeHandshake` and `evaluateNativeEligibility` judge a handshake or probe against the
floor of the contract it reports; an unknown contract is `protocol_mismatch`. The router's
static offer check is unchanged. `knownBad` applies to the primary contract.

### 3. Antigravity desktop

**Identity.** `identifyClientProcess` returns the CLI for an `agy` ancestor, and the desktop for
an ancestor whose first word ends in `/language_server`, that carries `--standalone` and
`--app_data_dir antigravity`. The desktop's version is the value of `--override_ide_version`.
The variant is `{ certificationName: "antigravity-desktop", displayName: "Antigravity" }`.
The session then has a client pid, so presence follows the language server: the participant goes
offline when the app quits, not when one conversation closes (the app has one language server for
all of them).

**Endpoint record.** `<runtimeDir>/native/antigravity-desktop/<endpointId>.json`, mode `0600` in a
`0700` directory, with the relay record's write/read rules:

```json
{ "schemaVersion": 1, "endpointId": "antigravity_desktop_<32 hex>",
  "conversationId": "<uuid>", "serverPid": 77034, "serverStartedAt": "<ps lstart>",
  "port": 55330, "clientVersion": "2.19.1",
  "protocolContract": "antigravity-desktop-agentapi-v1",
  "modes": ["livePush", "idleWake", "busyQueue"], "leaseUntil": "<iso>" }
```

It holds no token, no address string beyond the port, and no command line.

**Reading the endpoint.** One function reads `ps -o lstart=,args= -p <serverPid>`, refuses unless
the start time matches the record (pid reuse) and the arguments still identify the desktop
language server, and returns `{ executable, token }`: the language server path (absolute, named
`language_server`) and the `--csrf_token` value. The token lives in that function's caller for one
`agentapi` call and is passed only in that child's environment, exactly as the relay passes it.

**Bind** (`bindNativeSession`, every `SessionStart` and `beforeTurn`): when the client pid is the
desktop language server, list its TCP listeners with `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN`,
and for each port run `<language_server> agentapi get-conversation-metadata <conversationId>`
with the endpoint in the child's environment; the first port that answers for this conversation
is the endpoint. Previous records for the conversation are removed, the new one written, and the
closed handshake returned with protocol `antigravity-desktop-agentapi-v1` and a 120-second lease.
The CLI path (relay) is unchanged.

**Refresh** repeats the identity check and the metadata call against the recorded port.

**Offer** reads the record, re-reads the endpoint, renders the envelope with the relay's
`renderMessage` (fenced, bounded by the context budget, with the `acc inbox --message` recovery
line), and runs `<language_server> agentapi send-message --title "ACC peer message"
<conversationId> <text>`. Answers map through the relay's `classifyAnswer`. An accepted push is
`offered`, so `PreInvocation` does not show the body again.

**No activation hint.** `nativeActivationHint` answers `null` unless the client process is `agy`.

**Contract.** `nativeDelivery.anchors` gains
`{ version: "2.19.1", protocolContract: "antigravity-desktop-agentapi-v1", client: "antigravity-desktop" }`,
proven by the product capture below. `probeNativeDelivery` reports the CLI when `agy agentapi`
exists, otherwise the desktop when its language server answers `agentapi --help`.

**Permissions.** Install adds `command(<acc-cli.sh>)` to
`~/.gemini/config/config.json` → `userSettings.globalPermissionGrants.allow` when that file exists
(the desktop creates it on first launch), with its own ownership claim in ACC's data home, and
uninstall removes exactly what ACC added. A file that does not parse, or whose list is not a list,
is left alone, as the CLI rule already does. Doctor reports the rule when the file exists.

**Out of scope.** Installing Antigravity on a machine without `agy`: install verifies hook
registration by reading `agy -p "/hooks"` back, and the desktop offers no read-back. Linux and
Windows desktop builds are uncaptured; the bind needs `lsof`, so a machine without it refuses by
its own handshake.

### 4. Codex desktop

`embeddedHost` also recognises the desktop's private app-server - an `app-server` command with no
`--listen` whose executable sits inside an `.app` bundle - and the bind refuses with the existing
`client_session_embedded`, without a launch option. The one-time notice for that case says the
Codex app runs this chat on its own app server, so peers reach it at its next turn; there is
nothing for the user to change.

### 5. Documentation

CAPABILITIES, GETTING_STARTED, README and each adapter's COMPATIBILITY say which desktop apps ACC
reaches and how. Claude desktop: Local sessions are supported; Cloud, SSH, Cowork and scheduled
runs are out of reach. Stale statements fixed on the way: live delivery is not Apple-Silicon-only
since 0.8.0's cross-platform change, Antigravity is a live client, and CAPABILITIES no longer says
ACC never takes the Antigravity token.

## Security

The relay principle was "the session's CSRF token stays inside the process tree that owns it, and
in memory". The desktop already publishes its token on its command line, readable by every
process of every user on macOS. ACC does not widen that: it reads the token only for the
language server its own hook ran under (pid and start time recorded at bind, arguments re-checked
at every use), keeps it for one child process's environment, and writes it nowhere - not to the
endpoint record, the delivery binding, the native-attempt record, logs or diagnostics. What the
token lets ACC do is exactly what the relay did: put one fenced, ACC-rendered message into one
conversation. Tests assert the token never appears in any file under the data home.

## Testing

- SDK: `identifyClientProcess` and `clientVersionOf` validation; variant evidence rows; anchors
  for a second client; handshake judged against its own contract's floor; unknown contract.
- Hook runner: version precedence (identity → `clientVersionOf` → own executable → PATH); the
  binding carries `clientName`; capabilities read the variant's evidence.
- Antigravity: identity for `agy`, the desktop language server, the IDE's language server (not
  matched) and a lookalike; endpoint read refuses a changed start time or arguments; bind picks
  the answering port; offer renders, classifies and never writes the token (a scan of the data
  home); no hint for the desktop; config.json rule install/uninstall/doctor.
- Claude Code: version from the registry, missing or foreign record falls back.
- Codex: desktop host → `client_session_embedded` without a launch option, and its notice.
- Product capture of a private candidate on the real desktop app, cases D01-D06: idle wake;
  busy turn; reply loop (with the allow rule, does the bypass run unasked); duplicate message id;
  app quit then message stays queued; app restart (new token and port) rebinds on the next turn.
