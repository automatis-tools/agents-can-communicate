# Security model

## Trust boundaries

ACC coordinates processes running under the same local user in the first release. Same-user access is not equivalent to trusted model output.

Trust levels:

1. human instructions and approved policy;
2. local ACC core invariants;
3. adapter-reported lifecycle facts;
4. peer-agent messages and summaries;
5. referenced external artifacts.

Peer messages are never automatically promoted to human authority.

## Prompt injection

Inbound messages are rendered as structured, attributed peer data. Adapters must not concatenate them into system instructions without a boundary.

Required rendering properties:

- sender and harness visible;
- message type visible;
- authority visible;
- referenced artifacts separate from instructions;
- suspicious content cannot masquerade as ACC policy;
- raw HTML or terminal control sequences escaped in human views.

## Identity and session generations

- Persistent participant identity and ephemeral session identity are different.
- Every mutable ownership record includes an unguessable session generation token.
- Resume, heartbeat, release, and close require the current generation.
- Stale recovery never deletes a new generation after observing an old one.
- Workspace identity is validated before every mutation, including doctor and initialization paths.

## Claims

- Claims are advisory unless the active adapter declares and proves a guard capability.
- Guarded does not imply protection from out-of-band writes by unrelated applications.
- Force release requires a human or explicit policy authority and records reason, actor, and prior owner.
- Generic resource matching must reject ambiguous or non-canonical file paths.

## Durable records

- Messages, decisions, events, and acknowledgements are immutable or append-only.
- Publication uses no-replace semantics.
- Idempotent retries accept only byte- or semantic-equivalent destinations.
- Record filenames and IDs are bound.
- Symlink traversal outside managed storage is rejected.
- Corruption and incompatible protocol versions fail closed before mutation.

## Adapter installation

- Detect and present every settings file that will change.
- Preserve unrelated config keys and ordering where the format permits.
- Record ownership markers so uninstall removes only ACC-managed entries.
- Never copy API keys into project or ACC configuration.
- Do not ask for broader filesystem or shell privileges than the hook requires.

## Privacy

Default collected data:

- session and harness identity;
- one-line Intent summaries;
- explicit messages and decisions;
- claim and task metadata;
- artifact references;
- delivery and health events.

Default excluded data:

- complete prompts;
- complete assistant responses;
- raw transcripts;
- environment variables;
- secrets and credentials;
- unrelated filesystem contents.

Transcript or artifact ingestion must be an explicit, scoped action.

## Threat-model deliverable

Before the first public release, add a structured threat model covering:

- malicious or compromised peer agent;
- accidental duplicate identities;
- stale/crashed sessions;
- symlink and path traversal;
- message spoofing and replay;
- denial through claims or inbox spam;
- installer/config takeover;
- MCP tool poisoning;
- local database corruption;
- remote transport, if later introduced.

## Enforced, not documented

Everything above is asserted by `tests/security/*.test.mjs`, which the release
gate runs. Each rule is written as an attack rather than a description:

| Rule | Test |
|---|---|
| Peer text cannot leave its quoted block | `peer-injection.test.mjs` |
| Peer text cannot forge or close the fence | `peer-injection.test.mjs` |
| Peer text cannot repaint the terminal | `peer-injection.test.mjs` |
| Flooding cannot bury a conflict warning | `peer-injection.test.mjs` |
| No path escapes the managed root | `storage-boundary.test.mjs` |
| A workspace id cannot traverse | `storage-boundary.test.mjs` |
| A config cannot point roots outside itself | `storage-boundary.test.mjs` |
| A symlinked config is refused, not followed | `storage-boundary.test.mjs` |
| A committed config cannot carry runtime state | `storage-boundary.test.mjs` |
| Uninstall deletes only bytes it recognises | `installer.test.mjs` |
| A shared config is never deleted | `installer.test.mjs` |
| A corrupt install record stops the run | `installer.test.mjs` |
| A dry run cannot be tricked into writing | `installer.test.mjs` |

Scenarios, consequences, and residual risk: [THREAT_MODEL.md](THREAT_MODEL.md).
Reporting: [SECURITY.md](../SECURITY.md) at the repository root.
