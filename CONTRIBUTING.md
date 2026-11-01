# Contributing

Contributions are welcome: bug reports, live captures of a client, corrections to an issue,
and pull requests. This page says how a contribution is proposed, what a pull request must
carry, and what the maintainer will merge. The repository's working rules, gates and
package boundaries are in [AGENTS.md](AGENTS.md); read it before you change code.

## Report a vulnerability privately

Do not open a public issue or pull request for a vulnerability. Follow
[SECURITY.md](SECURITY.md) and report it through a private security advisory.

## Propose a fix or an adapter

1. Open an issue first, or comment on an existing one. Describe what you observed, the
   client and its version, and the ACC version. A pull request without an issue is fine
   for a typo or a broken link.
2. For a new client adapter, say which hooks or delivery path the client offers and what you
   have already captured. [docs/ADAPTER_AUTHORING.md](docs/ADAPTER_AUTHORING.md) describes
   the adapter contract.
3. Work on a branch and open a pull request against `main`. Keep each commit focused, so it
   can be reviewed on its own.

## Back every capability claim with a capture

A capability is claimed only from a live capture of the real client. A source method or
vendor documentation is not certification
([docs/CAPABILITIES.md](docs/CAPABILITIES.md)). A model's summary of vendor documentation
is not evidence either. `false` is the default and needs no defence; `true` needs a
fixture.

## Include these in an adapter pull request

- `certification.json` with an entry for every claimed capability. Each entry names its
  captured fixture (`fixture`) and one capture record (`provenance` and `provenanceId`).
- The captured fixtures under `fixtures/`, from the client version that the claim names, and
  `fixtures/certification-provenance.json` with the capture records (client, version,
  platform, digest).
- Every fixture and provenance file listed by exact path in the adapter's `package.json`
  `files`. A `fixtures/` wildcard is refused.
- An audited pass expectation for the adapter in `tests/conformance/certification-audit.mjs`.
- `COMPATIBILITY.md` with the client version, platform, what you observed, and what you
  could not observe.
- Passing conformance tests: `node --test tests/conformance/*.test.mjs`.

## Pass the gates

Every pull request passes the same gates as the maintainer's own work:

```bash
npm ci
npm run check
npm test
```

CI validates every pull request on Linux, macOS and Windows, and checks the package. Do not
bypass a gate. A new or corrected test must be shown failing on the exact change it is meant to
catch; see "Prove every gate with a mutation" in [AGENTS.md](AGENTS.md).

## Know what will be merged

The maintainer merges a pull request that:

- fixes a reproduced problem and adds a test that fails without the fix;
- adds or corrects an adapter capability with a capture behind it;
- keeps the invariants and package boundaries in [AGENTS.md](AGENTS.md).

The maintainer does not merge a pull request that:

- claims a capability without a capture;
- adds a central coordinator, or makes one session the manager of others;
- collects or shares raw session transcripts;
- makes Git a requirement;
- lets a hook fail closed, so that ACC is the reason a session stops;
- bypasses a gate instead of fixing the failure.

Prefer Node built-ins. A new dependency is pinned exactly to its latest stable release.

## License of contributions

ACC is released under the [MIT License](LICENSE). A contribution is accepted under the same
license: by opening a pull request, you agree that your contribution is licensed under MIT,
as the GitHub Terms of Service state for contributions to a public repository. No separate
sign-off or contributor agreement is required. Contribute only work that you have the right
to submit under this license.

## Credit for outside work

- A capture you contribute is credited by your GitHub handle and the issue or pull request
  in the dated entry for that capture in the adapter's `COMPATIBILITY.md`. Its capture
  record in `fixtures/certification-provenance.json` keeps the evidence next to it.
- A correction to an issue, a reproduction or a reported bug is credited by handle in the
  issue or pull request that resolves it.
- The release notes in `CHANGELOG.md` may name outside contributors to a release.

If you prefer to stay unnamed, say so in the issue or pull request.
