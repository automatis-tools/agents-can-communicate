# Archived hardening patches

These files are exact staged diffs exported on 2026-08-15 from four Papercut worktrees sharing base `9a866cf16f97a0aa1af7ea792acc79bc02278633`.

They are not a sequential patch series. Do not run `git apply migration/patches/*.patch` and resolve conflicts mechanically.

| Patch | SHA-256 | Lines |
|---|---|---:|
| `0001-prompt-and-docs.patch` | `63bac101b783f5cb695e6bd11ad6aef487d4c28b400d306e4e7ae5774287b3a0` | 163 |
| `0002-lifecycle-and-cli.patch` | `2bf9dab2fb0ec36064684c5d2a787fb84246a6f999042e58ec11326c547c80a9` | 997 |
| `0003-storage-and-messages.patch` | `72ae9e4c074b2e5f7ff289615c4bfe76a7a34fed5de4c9e089875bb4fad5774b` | 1887 |
| `0004-doctor-and-recovery.patch` | `fbd24ebc4fb91ab8a77ae84d0c7e6374603d8b2bc7212261b71a72fd0891d390` | 789 |

See `docs/MIGRATION.md` for semantic contents, conflict points, and integration order.
