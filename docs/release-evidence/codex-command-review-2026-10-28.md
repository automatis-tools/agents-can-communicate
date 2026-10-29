# Unreleased: local context in Codex approval requests

| Candidate artifact | Value |
|---|---|
| Built from | `a3765c5807ea272176ae32d1b966e99980251de2` |
| Tarball | `agents-can-communicate-0.12.2.tgz`, 629,756 bytes, 380 files |
| sha256 | `1528df809be8bbcb5d04eb10b4e52f7891fb7679d497090aebfdfd655df4bd14` |
| Host | macOS arm64, Node 26.5.1, Codex 0.165.0 |

The working tree was clean at the source commit immediately before packing.
`node scripts/verify-package.mjs <exact-tarball>` passed installation into a clean
consumer, package boundaries, documentation links, doctor, a non-Git workspace,
and reversible client integration. The verifier's supplied-archive revision is
unknown; the table records the actual source captured before packing.

## Failure and correction

An exact history read in a real IDE session requested escalation without a
justification. Its reviewer rejected it before execution as synchronization to an
external ACC workspace. The reviewer's retained transcript did not contain the
skill's local-storage facts. The installed rule still parsed as `allow`.

The installed skill now starts commands with default permissions. A sandbox or
local transport refusal uses approved escalation with the operation and local
destination in the exact request. Reviewer denial is treated separately, and no
alternate route is prescribed to bypass it. No global permissions, reviewer
policy, hook trust, active user installation, or public package was changed.

## Measured checks

- Syntax: 882 modules parsed or reused by identical-byte syntax checks.
- Focused rule and permission-install tests: 28 passed, one Windows-only test skipped.
- Installed native command test: one passed on Codex 0.165.0, including a repeat
  using the exact archived tarball above through `ACC_TEST_PACKED_TEMPLATE`. A restricted profile
  denied the ordinary read even with the rule installed. With an explicit local
  state grant and no rule, the read succeeded with zero reviewer requests.
- A fallback after admission denial carried the installed read justification into
  one exact reviewed action. An approved send retry recorded one new message.
  A rejected send recorded none. Exact history reads left receipts unchanged.
- Mutation: removing the read justification made the native read fail after the
  fixture reviewer rejected it. Restoring the justification passed.
- Mutation: removing legacy generated-rule recognition failed its migration test.
  Restoring recognition passed. Edited rules remained operator-owned.
- Independent read-only review found no remaining blockers after corrections.

The native test uses a scripted model and reviewer on `127.0.0.1`. It proves real
client routing, context propagation, sandbox enforcement and ACC effects. It
does not prove an OpenAI reviewer's judgment or autonomous model compliance.
The native send retry starts before recording, not after a recorded transport
failure. Existing idempotent-send tests retain that separate coverage. Linux CI
and Windows command-rule behavior were not captured on this host.

The new dated observation in `packages/adapter-codex/COMPATIBILITY.md` qualifies
the older rule-bypass capture without changing historical release evidence.
