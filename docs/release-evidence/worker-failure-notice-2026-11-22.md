# A failed background update says why: development evidence

This records the development candidate that makes the update worker's failure notice name its
cause and clear once a later check succeeds. It is not a published release.

## What was seen

On 2026-11-22 the maintainer's Mac ran ACC 0.15.1, the current release, and `acc update
--check` reported it current. `acc doctor` still showed "Automatic update could not finish;
the previous runtime was kept. Run acc update for details." The runtime's `control.json` held
that notice beside a `checkedAt` from that morning: the morning check had succeeded and rewritten
the file around the notice. The pass that failed was older, and its error was not kept anywhere,
so its cause cannot be recovered.

The same machine kept a 0.14.0 generation. A pin held it: a Claude Code session pinned to
0.14.0 on 2026-11-11 has run without a break since then, and reclaim keeps a pinned generation
until its client exits, as designed. That generation goes when the session ends.

## Exact artifact

- Source: clean commit `d7697b8f0a05ab92f11e5aa3e0c81ef69d504d44`.
- Archive: `agents-can-communicate-0.15.1.tgz`, 659,696 bytes, 392 files.
- SHA-256: `67f7d76b02ad56ac598667b12d61fc9a611de814164863aabab3de2db3d3ae22`.
- Node 24.4.0, npm 11.4.2, macOS arm64.

The exact archive passed `scripts/verify-package.mjs`.

## Behaviour covered by tests

- A pass that fails while discovering a release records `Automatic update could not finish:
  fetch failed (ENOTFOUND).`; the next due check that finds nothing newer clears it.
- A cause with a message and no code (`bad port`) is named; control bytes are removed and the
  notice stays within 400 characters; a lost lock race records nothing.
- The cause-less notice that 0.15.1 and older wrote clears on the next check; any other notice
  stays.
- The clearing test fails when the check keeps the old notice.

## Installed run

The exact archive was installed with `npm install -g` into an isolated home, data home and
prefix, with the real Codex executable for detection and `--delivery off`. The installed
generation's own `bin/acc-update-worker.mjs` then ran twice:

1. Against a registry on a closed local port, the notice became `Automatic update could not
   finish: fetch failed (ECONNREFUSED). The previous runtime was kept; the next check tries
   again, or run acc update.`, and `acc doctor` showed the same line.
2. With the check made due and a local registry serving the installed version, the pass made one
   registry request and the notice was cleared.

## Limits

- The original failure on the maintainer's Mac is not reproduced; its cause was never recorded.
- A notice clears at the next due check, up to a day after the failure.
