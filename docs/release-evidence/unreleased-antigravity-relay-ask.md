# Unreleased an ignored Antigravity relay ask comes back

On 2026-09-22 a degraded Antigravity session was asked once to start its relay, on a greeting
that never ran the command. The marker was already written, so the ask never returned and the
session stayed unreachable while idle. Issue #189.

The reminder now returns on a later turn while the binding stays degraded and no relay for
that conversation is serving, up to three times. An empty marker left by the one-ask rule
counts as zero asks. A serving relay is not asked, and neither is a binding that is not
degraded; those calls do not spend an ask. A permission decline and a model that never tried
leave the same trace — the shim never ran — so the asking cannot stop because someone
declined. The third ask is what stops it.

The 2026-09-21 live-push capture still records what that build did: one ask. This note does
not replace that capture. No new Antigravity session was observed for this change. The
behavior is the adapter function, covered by `packages/adapter-antigravity/test/native-delivery.test.mjs`.

## Exact local artifact

- Source: clean commit `e497d41d1704d29fd66be044723daf3f595a62c7`.
- Archive: `agents-can-communicate-0.6.3.tgz`, packed from that commit.
- Size: 447,284 bytes; 306 packed entries.
- SHA-256: `83aa8e5dc86922a51c69d72a05d31f75f8465c4b1b47586f83727cf4cb634219`.
- Package version remains `0.6.3`; this is an unpublished development artifact.

The exact archive passed `scripts/verify-package.mjs`: pack, contents, certification
allowlist, packed Markdown links, bundled workspace versions, clean installation, doctor,
no-Git workspace operations, and install/uninstall byte restoration.

## Limits

The ask bound is three. Operator text in the getting-started guide, the troubleshooting
page, the capabilities table, and `acc doctor` says so. This record does not claim a new
live capture of the Antigravity client.
