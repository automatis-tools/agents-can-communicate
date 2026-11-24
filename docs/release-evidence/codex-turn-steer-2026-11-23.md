# A busy Codex session reads a peer message inside its running turn: development evidence

This records the development candidate for #132. It is not a published release.

## Question

Codex native delivery used the app-server daemon queue. A message accepted during a running
turn waited until that turn ended. `turn/steer` adds input to the running turn, but it needs
that turn's id. ACC opens one short connection per delivery, so it never saw the
`turn/started` notifications that carry the id.

## Spike on Codex 0.171.0

The setup was a real TUI on its daemon in an isolated HOME, and two more daemon clients.

- **No subscription.** A client that only initializes gets `thread/status/changed` for the
  TUI's thread, but no turn notifications.
- **Subscribed.** A client that calls `thread/resume` with `excludeTurns: true` gets
  `turn/started` and `turn/completed` for turns the TUI starts later. It cannot resume a
  thread that has no turn yet.
- **Turn read.** `thread/turns/list` with `limit: 1` and `itemsView: "notLoaded"` returns the
  running turn's id and `inProgress` status, with no items. No subscription is needed.
- **Steer.** `turn/steer` with that id added the text to the running turn, and the model used
  it in that turn. A wrong id, or a thread with no running turn, is refused with `-32600`.

ACC therefore keeps its short connection. It reads the newest turn, steers when the turn is
running, and queues the message in every other case.

## Installed-product capture

Captured on darwin-arm64 with Codex CLI 0.171.0 in the TUI on its daemon, model `gpt-6.2-sol`
at low effort. The archive was built from `b1a7cf0f` and installed into an isolated HOME,
`CODEX_HOME` and ACC data home. The hooks were trusted by writing the hashes that `hooks/list`
reported. Each observation comes from ACC's own results and events, or from the receiving
thread's rollout. Recorder: `scripts/e2e/codex-steer-product.mjs`.

| Case | Branch | Observed |
|---|---|---|
| X01 | idle | offered via `codex-app-server`; the message started a turn |
| X02 | busy | offered; the message joined the turn that was already running |
| X03 | reply | `acc reply` answer recorded; receipt acknowledged |
| X04 | duplicate | same message id; one offer; the turn showed the message once |
| X05 | fallback | daemon stopped, session closed; message queued as `recipient_offline` |

The busy case timeline:

| Event | Time (UTC) |
|---|---|
| Turn started | 00:14:52.5 |
| Question recorded and offered | 00:14:59.7 / 00:15:00.0 |
| Answer recorded | 00:15:06.1 |
| Turn ended | 00:16:02.3 |

Before this change, the same question would have waited until 00:16:02. The turn ran three
20-second shell commands after the answer.

The capture is in `packages/adapter-codex/fixtures/delivery/codex-cli-0.171.0-turn-steer.json`.
Its product evidence is in `codex-cli-0.171.0-turn-steer-product-evidence.json`.

## Exact artifact

- Captured archive: built from `b1a7cf0f`, SHA-256
  `a4dd48e5c792065051ade860b0740a2a808c505d8cd17f85687ceaf7cc07efae`.
- Recorded candidate: clean commit `ff34f9481bb2a56da4a88c7001ad3d2335b6a58f`, the branch with
  main merged after the token-cost change (#135).
- `agents-can-communicate-0.15.3.tgz`, 671,024 bytes, 397 files.
- SHA-256: `e2f8e065c07b596336f5789b5623f399b881630bc935727e5e9deffac8428703`.
- Built with Node 24.4.0 and npm 11.4.2 on macOS arm64.

In the Codex adapter's code the candidate is the captured archive. It differs in these files:

- `README.md`, `docs/CAPABILITIES.md` and `docs/HOW_IT_WORKS.md`;
- the Codex adapter's certification, provenance and `package.json` file list;
- the two new fixtures;
- the Kimi Code and Gemini CLI skill manifests, `ACC.md` and the docs from #135, merged from main.

It passed `scripts/verify-package.mjs`.

## Limits

- **Race not captured live.** The capture did not include a turn that ends between the turn
  read and the steer. Tests cover it: the steer is refused, and the message is queued.
- **Busy prompt.** The busy prompt asked the model to answer peer questions with `acc reply`.
  Without that request, a model can finish its current step first.
- **Platforms.** Linux and native Windows were not captured. Older daemons were not
  captured either; when one cannot list turns, it keeps the queue path.
