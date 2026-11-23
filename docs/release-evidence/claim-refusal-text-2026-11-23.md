# A claim conflict tells the model what to do next: development evidence

This records the development candidate for #146. It is not a published release.

## What the investigation found

- A single claim conflict had the message "the resource is already claimed". The holder, the
  lease end and the holder's presence were only in the error details. A batch conflict listed
  each blocked resource with the holder's session id, without the participant or the lease end.
- Claims accept any resource of the form `<scheme>:<name>`. Overlap is the same rule for every
  scheme: equal names, or a `/**` glob that covers the other name segment by segment within one
  scheme. The documentation described only `file:` resources.

## Change

- The conflict message names the holder and its session, the claim the holder has when it
  differs from the requested resource, the lease end, and one next action.
- The next action depends on the holder's presence. An online holder: ask it to release, claim
  a narrower resource, or retry after the lease ends. An offline holder: ask the user whether to
  force-release with `acc release --claim <id> --authority human`.
- The message names a command only for the force release, because the user runs it. The same
  text reaches CLI and MCP clients.
- A batch conflict uses one such sentence per blocked resource.
- The error details add `ownerParticipantId`. All earlier detail fields stay.
- `docs/CLI.md` states the resource form, the overlap rule with `port:` and `tool:` examples,
  and the refusal text.

## Exact artifact

- Source: clean commit `ed54577bd832ae828aa4e7a61f18b9d46e3ef349`.
- Archive: `agents-can-communicate-0.15.3.tgz`, 665,113 bytes, 393 files.
- SHA-256: `a69f45f5089fa7089491082d82bf7c1290ac450a5ebb9c28785dabf5f59e935b`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Tests and installed run

- Core tests check the exact sentence for an online holder with a wider claim and for an offline
  holder. They also check that a `port:` claim conflicts only with the same port, and that the
  batch message has one sentence per blocked resource.
- The claim, release, MCP and hook test files that touch claims passed: 447 tests.
- The archive was installed. `bob` claimed `file:src/**` and `port:7319`. Then `alice` claimed
  `file:src/a.mjs`, and then a batch of `file:src/a.mjs`, `port:7319` and `port:7320`. Both
  calls exited 5. The single refusal was:

  > file:src/a.mjs is claimed by bob (session session_…) as file:src/\*\* until
  > 2026-11-23T07:47:37.829Z; ask bob to release it, claim a narrower resource, or retry after
  > it expires.

  The batch refusal gave the same sentence for `file:src/a.mjs` and one for `port:7319`, and
  no sentence for the free `port:7320`.

## Limits

- No real client model was observed acting on the new text.
