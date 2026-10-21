# Unreleased — website and macOS endpoint discovery

This development artifact accompanies the ACC website and a focused macOS
Antigravity discovery correction. It is not a published release. Version 0.11.1
is unchanged; the earlier candidate record retains its original artifact.

## Source and artifact

| Fact | Value |
|---|---|
| Source commit | `e4c3ca6d731d7800bede7092f074098231c30654` |
| Source state at pack time | clean feature worktree |
| Archive | `agents-can-communicate-0.11.1.tgz` |
| Archive size | 611,093 bytes |
| Packed files | 376 |
| SHA-256 | `242ec5a2bd8367a4e9fcc08a42511f07211b2c8fab28e0dcd3980ae0bc26ca8e` |
| Local environment | macOS, Node 24.4.0 |

`npm pack --json --pack-destination` produced this archive from the clean source.
`node scripts/verify-package.mjs` then verified that exact archive: inventory,
bundled dependencies, documentation links, installed commands, a workspace
without Git, and install/uninstall restoration. The artifact contains no website
or build dependency. The manifest now names a development-only Markdown builder;
ACC's runtime dependency boundary is unchanged.

## macOS prerequisite

The existing desktop-delivery process scenario failed before the website work:
TCP discovery exhausted its one-second `lsof` deadline. Against the same owned
listening process, the original flags took 3,456 ms; adding `-b` took 28 ms.
The flag avoids kernel calls that can block on a mounted filesystem.

Commit `464fd7b6` adds `-b` only on macOS, preserving Linux flags, timeouts and
delivery boundaries. The platform-specific argument regression failed before
the correction; the delivery unit and original process checks then passed
16/16. This is synthetic endpoint evidence, not a new native-client capability
capture. The failure mode remains visible inbox fallback.

## Website evidence

The website lives outside the published package. Its own build produces 31 HTML
pages and 22 reviewed articles. Source-only Git archive validation confirms the
public reports are tracked and the build needs no private research directories.

Website regressions cover built output, metadata and Markdown safety, unpublished
draft exclusion, internal links, output ownership, redirects, preview headers and
real local HTTP responses. Review-found metadata injection and failed-search
feedback each failed their new regression before correction; all nine website
checks then passed.

An isolated desktop browser replay passed at 1440px and 390px, including keyboard
navigation, the light-only output under a dark OS preference, search and its
network-failure fallback, and horizontal article tables. Clipboard success and
denial were simulated through the browser API; this is not physical clipboard
or native phone evidence.

One local Lighthouse 13.5.0 mobile artifact run recorded Performance 98,
Accessibility 100, Best Practices 100 and SEO 100, with LCP 2.1 s and CLS 0.
Those are laboratory observations, not field Core Web Vitals, search ranking or
indexation proof. Hosting, DNS and domain redirects have not been deployed.
