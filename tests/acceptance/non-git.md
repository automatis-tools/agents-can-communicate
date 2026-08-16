# Non-Git acceptance

A workspace that is not a Git repository at all. This is the case most likely to leak,
because Git is how ACC identifies a workspace when one is there: a probe that fails
loudly, a stray lookup surfacing as an error the user never asked about, or runtime state
dropped into the project because there was no repository root to put it beside.

Automated in `tests/acceptance/non-git.test.mjs`, which runs in `npm test`. The recipe is
here so the scenario stays legible without reading the assertions.

## Recipe

In a fresh temporary directory with no `.git` anywhere above it:

```bash
acc attach --participant solo --harness cli --json
acc work   --session S --generation G --summary "checking the non-git path" --mode explore
acc claim  --session S --generation G --resource file:notes.txt --reason "editing notes"
acc message --session S --generation G --to solo --subject hello --body "…"
acc detach --session S --generation G
```

## What must hold

1. **The whole cycle works.** Attach, Intent, claim, message and close all succeed. Git is
   how a workspace is identified when one is present, not a requirement for having one.

2. **No Git failure ever reaches the user.** `stderr` is empty. The probe running and
   finding nothing is a normal answer, not an error, and a user in a plain directory must
   never see git's voice - no `fatal:`, no `not a git repository`.

3. **Nothing is written into the project directory.** After attaching and claiming, the
   directory is still empty. Coordination state belongs to the machine, under the runtime
   data home; a workspace with no repository is exactly where a tool is tempted to drop a
   dotfile instead.

4. **Two sessions in the same directory find each other.** Without Git, identity falls
   back to the directory itself, so both sessions must land in the same workspace rather
   than in two lookalikes. Both appear on one roster.

5. **A conflict is reported the same way it would be inside a repository.** Exit code 5,
   and the failure arrives as a JSON envelope - an adapter is the one caller that cannot
   read prose, and a conflict is exactly when it needs to understand the answer.

## Note on the environment

The tests clear `GIT_DIR` and `GIT_WORK_TREE` before running. Those variables are exported
into every child process by any git-driven caller - a hook, a pre-push gate - and would
point the probe at a repository that is not the one being tested. This repository has been
damaged by exactly that once before; the pre-push hook now unsets them too.
