# ACC's Codex profile is available, not the default

Date: 2026-10-26. Issue #329 plus the maintainer's request: in Codex Desktop, new chats
opened with ACC's permission profile `acc-workspace` selected, beside "Ask for approval"
and "Approve for me", and it looked like leftover junk.

## Why

Since 0.4.3, live opt-in has selected `default_permissions = "acc-workspace"`. The profile
extends `:workspace` and grants write access to ACC's state directory and to the Unix
sockets ACC delivers to. That made every new Codex chat run in ACC's profile, which the
maintainer never chose and Desktop shows as an unexplained approval mode.

The update to 0.12.0 also failed on the maintainer's machine (#329). Another program rewrote
`config.toml`: it sorted the tables and dropped every comment, including ACC's ownership
markers. ACC then took its own entries for foreign ones, refused the Codex refresh, and while
the update stayed pending, every ACC command and hook on the machine answered
`runtime unavailable`.

## Measured on Codex 0.164.0, macOS arm64, 2026-10-26

These runs used an isolated `CODEX_HOME`, a stand-in for `acc-cli.sh` that writes under
`~/Library/Caches`, and the same `prefix_rule` shape ACC installs:

| Run | Result |
|---|---|
| `codex exec -s workspace-write` (approval `never`), command allowed by the rule | runs outside the sandbox; the write succeeds |
| `codex exec --approve-for-me` (approval `on-request`, auto-review), allowed by the rule | runs outside the sandbox; the write succeeds |
| `codex exec -s workspace-write`, no rule (control) | `Operation not permitted` |
| a `[permissions]` profile with no `default_permissions` and no `sandbox_mode` | Codex refuses to start: "config defines `[permissions]` profiles but does not set `default_permissions`" |
| the profile with `default_permissions = ":workspace"` | accepted; sandbox `workspace-write`; the rule-allowed write succeeds |
| the profile with `sandbox_mode = "workspace-write"` | accepted; the rule-allowed write succeeds |
| no selection at all | sandbox `read-only` |
| `default_permissions = ":workspace"` | sandbox `workspace-write`, in a trusted and an untrusted directory |

The model did not request escalation in any of these runs: a command that ACC's rule allows
runs unsandboxed on its own. ACC's coordination commands therefore do not need ACC's
profile to be selected.

## Decisions

**The maintainer decided:**
- `acc-workspace` stays defined, so it can still be picked by hand, but new chats do not open in it.
- On update, ACC removes the default it selected and restores what the config held before ACC.
- When the config has no selection of its own, ACC sets `default_permissions = ":workspace"`.
  Codex needs a selection once a profile exists, and `:workspace` is Codex's own
  workspace-write mode, the mode behind Desktop's standard choices.
- This ships together with #329.

**The builder's calls (mine):**
- **Selection unit.** The `selection` unit stays and keeps carrying the restore metadata,
  because older ACC versions accept metadata only there. Its body is empty when the user's
  restored config already selects something (`default_permissions` or `sandbox_mode`). Otherwise
  its body is `default_permissions = ":workspace"`. ACC no longer removes the user's own
  `sandbox_mode` or `default_permissions`. ACC's pre-profile `[sandbox_workspace_write]` grant
  is still removed, as before.
- **Where the rule cannot carry the commands, ACC selects its profile as before.** That
  covers:
  - Windows, which gets no rules file;
  - a rules file that is foreign or could not be written;
  - Codex older than 0.164.0, the first version measured running rule-allowed commands
    outside the sandbox.

  The capture applies from 0.164.0 onward on every platform that has the rule.
- **Recognising ACC's own unmarked entries (#329):**
  - Marketplace and plugin entries are ACC's when they match what ACC writes: a
    `[marketplaces.acc-local]` with `source_type = "local"` and `source` equal to ACC's own
    marketplace root, and a `[plugins."agents-can-communicate@acc-local"]` holding only
    `enabled`. ACC then removes them and writes its marked block. Anything else is still
    refused.
  - The profile is ACC's when every key under `permissions.acc-workspace` is one ACC writes:
    `extends = ":workspace"`, the state root set to `"write"`, `network.enabled = true`, and
    only `"allow"` entries under `unix_sockets`. ACC then removes those tables, and an
    unmarked `default_permissions = "acc-workspace"` with them. Anything else stays a custom
    policy, preserved and reported as today.
- **A failed refresh for one adapter still keeps the update pending for every client.** An
  activated runtime with one adapter's integration left on the previous version is a state
  ACC cannot describe. The recovery for this case is documented, and #329's fix removes its
  cause.

## Compatibility

- **An older ACC reading the new config** finds an owned `selection` unit. Its body is empty
  or `default_permissions = ":workspace"`, and its hash matches. The older ACC therefore sees
  owned permissions and repairs them to its own selection only when it installs.
- **The rules file** is unchanged.
- **Downgrading** brings back the older default selection on the next install. This is
  documented.

## Text

- `docs/CONFIGURATION.md` "Codex outgoing permissions" should say:
  - the rule runs ACC's commands outside the sandbox;
  - the profile is available and not selected, except in the cases above;
  - which default ACC sets when the config has none.
- The install preview, the consent question and doctor's outgoing status describe the same.
- `TROUBLESHOOTING.md` gains the rewritten-config case and its recovery.
- `packages/adapter-codex/COMPATIBILITY.md` records the measurements above.

## Verification

- Unit tests in `packages/adapter-codex` cover:
  - a fresh install selecting `:workspace`;
  - a config with the user's `sandbox_mode` keeping it;
  - an owned 0.12.0 config migrating to the new units;
  - a customized config staying untouched;
  - each of the three rule-unavailable cases selecting `acc-workspace`;
  - a sorted, comment-free config being adopted;
  - a near-miss (different marketplace source, an extra profile key) being refused.
- An installed-package check with real Codex 0.164.0 in an isolated `CODEX_HOME`. A sandboxed
  `acc message` from a `codex exec` session succeeds while the session runs `:workspace`, not
  ACC's profile.
