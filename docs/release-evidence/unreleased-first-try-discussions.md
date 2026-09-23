# Unreleased a first-try report goes to Discussions

The README's closing call to action sent every first impression to the issue tracker. GitHub
Discussions were enabled on this repository on 2026-09-14, with the default categories, and the
README was never updated to use them. Opening an issue is a high bar for "I tried it and here is
how it went", which is the report this project most needs.

The closing paragraph now links **Discussions → Show and tell** for that report and keeps
[issues](https://github.com/automatis-tools/agents-can-communicate/issues) for bugs. The
category slug was read from the repository rather than assumed: `announcements`, `general`,
`ideas`, `polls`, `q-a`, `show-and-tell`.

This replaces PR #168, which proposed the same change on 2026-09-14. That branch could not be
landed as it stood: it conflicted with main, and its changelog record described a 0.5.8-era
candidate of 279 entries, three releases behind.

## Exact local artifact

- Source: clean commit `8e2e05becec3c9229c48ec3ae55d7232d399a486`.
- Archive: `agents-can-communicate-0.6.3.tgz`, packed from that commit.
- Size: 446,564 bytes; 306 packed entries.
- SHA-256: `66956ea9409f2bd51705c486fdc8153cf7b0f888753112984c15e61cf66964c6`.
- Package version remains `0.6.3`; this is an unpublished development artifact.

The README is packed into the tarball, so any edit to it invalidates the recorded digest; that
is why a two-line text change carries a candidate record. The exact archive passed
`scripts/verify-package.mjs`, including the check that every packed Markdown link resolves
inside the tarball. The 27 documentation tests passed.

## Limits

One paragraph of README text. No code, capability, or published claim changes.
