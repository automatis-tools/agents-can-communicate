# Speaker script

## Delivery contract

**Title:** When Codex and Claude Code Need to Talk

**Audience:** builders already using multiple coding clients, and engineers building agent integrations.

**Goal:** recruit useful technical feedback from one small real workflow, without a sales pitch.

**Through-line:** an API contract question between independent sessions exposes the same reliability problems as other message systems, plus the uncertainty of model attention and changing client capabilities.

Use the same master deck for every version. Speak the important facts aloud so a recording
makes sense without the slides. Timings below are targets. The native workflow and code
inspection consume the allocated time. Rehearse aloud before accepting a final duration.

## Six-minute cut: slides 1, 3, 5, 16

### 0:00–0:35, slide 1

I use more than one AI coding client. When two independently opened sessions work on one
feature, an interface question can still leave me carrying a message between them.

I built Agents Can Communicate, or ACC, to carry that exchange locally. Each session keeps
its own conversation and permissions. I'll show one dependency and then what the delivery
record actually proves.

### 0:35–3:05, slide 3 and native exchange

Codex owns the API contract. Claude Code owns an example of the form that uses it. I opened
each session normally and gave each its own scope.

Watch the form session ask its peer for the request and error fields. I'm interested in the
specific answer, not in whether the agents can produce a convincing conversation.

[Show the question, answer, and resulting UI example. Inspect the same message's history.
Do not wait more than 2:30. If next-turn delivery needs a user prompt, show and name it.]

The example uses the contract's fields. The artifact is the evidence for that part of the
work. The receipt tells us something narrower about the communication.

[Fallback replacement: “The native exchange hasn't completed, so I'll show the protocol
through the real CLI using synthetic participants. This demonstrates the transport,
not a model acting on a message.” Run the replay, advancing quickly through the six beats.]

### 3:05–4:35, slide 5

ACC records the message before it tries to make a client receive it sooner. A failed live
attempt leaves a durable inbox item.

Queued means the message committed. Offered means a transport accepted the bytes, or a
certified hook carried the body. Retrieved means the recipient fetched that body.
Acknowledged means that recipient acknowledged it or replied.

None of those words means the model finished a task. In the CLI replay there is no native
transport, so the receipt goes from queued to retrieved to acknowledged. I don't manufacture
an offered state just to make every box in a diagram light up.

The reusable idea is to name the facts your system can actually observe and keep the
fallback available when a client cannot wake.

### 4:35–6:00, slide 16

A second lesson came from integration testing. A written config or an API that appears
usable is weaker evidence than a message reaching the installed client. ACC keeps client
support, current reachability and recipient consent separate. Hooks also fail open, so a
coordination failure is not why your coding session stops.

The repository has the implementation and a reproducible CLI replay. If you already use
two coding clients, try one feature with a real dependency between them. Tell me where the
question reached the peer, where the reply helped, and where you still had to carry a
message yourself. A clear failure report is useful feedback. I'd be happy to walk through
your setup after the demos.

## Twenty-minute route

Slides 1–6, 9, 10, 14, 16. Allocate 1 minute to the opening, 1 minute to the setup,
4 minutes to the native workflow, 2 minutes to record/offer, 2 minutes to receipts,
2 minutes to retry/replay, 2 minutes to capability evidence, 2 minutes to trust,
2 minutes to installed verification, and 2 minutes to the experiment and close.
Use the corresponding full-script paragraphs below. Omit the generation, claim,
fail-open and performance deep dives. Keep Q&A outside these twenty minutes when possible.

## Thirty-five-minute main talk

### Slide 1, 0:00–1:00 — When Codex and Claude Code Need to Talk

Imagine you have two coding sessions open. One is working on an API and the other is
working on the screen that calls it. They have access to the project, but the question in
one conversation doesn't automatically appear in the other. You become the messenger.

That small interface question is where this project started. I built Agents Can Communicate,
which I call ACC, as a local channel between sessions that I open independently. I choose
the tools and the work. Each session keeps its own conversation, model access and permissions.

Today we'll follow one question through the running system, then look underneath it.
The useful result is a set of techniques you can apply to another agent integration:
what to record, what to verify, and what to say when a client cannot receive a message yet.

### Slide 2, 1:00–3:00 — Independently opened sessions

There are several ways to divide work among agents. For this talk, I care about sessions
that the developer already opened in different clients. That choice matters because each
client already owns a conversation, a permission model, and its own relationship with its
provider. Taking ownership of those lifecycles would change the problem.

The ACC core records shared coordination facts. There is no model running above the other
models to distribute their work. A session publishes a short intent, can reserve a file
scope, and can send a question or a request. The recipient decides how to respond under
its own instructions. A request can be declined.

This keeps the shared surface small. ACC stores explicit messages and handoffs rather
than collecting the conversations that produced them. A handoff can state the decision,
what was checked, and what remains. The receiving session still needs to verify the
artifact and its own authorized scope before continuing.

That doesn't make coordination automatic in the human sense. An agent might miss a
useful dependency or answer the wrong question. What the tool can do is expose presence,
carry an explicit exchange, and make its delivery facts inspectable. We need to evaluate
those facts separately from whether the resulting code is good.

### Slide 3, 3:00–8:00 — One interface question

Let's make that distinction visible. Codex is defining a registration contract in the API
scope. Claude Code is preparing an example of the form that uses it. The duplicate-email
case needs a particular status and error code, so the form session needs the contract.

I deliberately bounded the example. We don't need a whole application build to observe
this dependency. We need the question, the answer, and a small artifact using the answer.

[Run the native workflow from demo-runbook.md. Show intents, addressed question, answer,
UI example, and exact receipt history. Allow at most five minutes for the whole block.]

Notice the separate evidence. The messages establish what the agents exchanged. The
receipt history establishes which communication steps ACC observed. The example file
establishes whether the answer was used. We'd need a different check to establish whether
a production implementation was correct.

[If the native path fails or waits too long, switch to the labelled real-CLI replay.]

The fallback uses the actual ACC command boundary and filesystem store, with synthetic
participants. It is reproducible without model credentials. It proves protocol behavior,
but it doesn't prove that a model noticed a dependency or that a native client woke.
That boundary is part of the demo, not an embarrassment to hide.

### Slide 4, 8:00–10:00 — Record before delivery

Follow the question through the architecture. Core validates the sender's session and
records the message with a queued receipt for each resolved recipient. That transaction
finishes before the delivery router asks an adapter to make the message arrive sooner.

This order gives us a useful guarantee. If the live path refuses a request, the durable
message still exists. The sender has a message id and can inspect its history. A transport
failure changes the acceleration path, rather than pretending the question never existed.

The router looks for exactly one eligible session generation and an appropriate binding.
The adapter owns the client-specific endpoint and transport behavior. Core doesn't need
to interpret a vendor socket or branch on a vendor name. Its packages receive those
observations through a smaller contract.

After the transport accepts an offer, ACC can record the offered fact. There is a crash
window between acceptance and that receipt commit. A later attempt could display the
message again. The design accepts that possibility rather than recording delivery before
it happens. The receiving side needs stable ids and clear retry behavior to handle it.

That's an engineering tradeoff you can reuse. Pick the durable fact first, then define
what evidence permits the next state. Don't use a successful send call as shorthand for
all downstream activity.

### Slide 5, 10:00–12:00 — What a receipt proves

This vocabulary is easy to get wrong because familiar messaging products compress several
observations into a word like seen. ACC keeps four narrower states.

Queued means durable recording succeeded. Offered means a transport accepted delivery
bytes or a certified next-turn hook carried the message body. Retrieved means the
participant fetched that body through its inbox or equally strong evidence. Acknowledged
means the participant acknowledged it or replied.

A plain inbox listing returns headers without advancing a receipt. That lets an agent
choose what to read without making the system claim it has read every listed body. An
exact read is the stronger observation. A reply acknowledges the original communication
and creates a separate answer in the same thread.

Even acknowledgement doesn't establish task completion. The answer might say I can't take
that work. It might state a contract, as in our demo. It could make a mistaken claim about
an artifact. The human or another authorized agent still has to inspect the result.

Also, a workflow doesn't have to visit every state. Our manual CLI receiver has no native
transport, so a direct inbox read advances from queued to retrieved. State transitions
are monotonic evidence, not a checklist that every interaction must animate.

When building another agent tool, ask what each status lets an operator conclude. If the
conclusion requires evidence you don't possess, use a narrower status.

### Slide 6, 12:00–14:00 — Retry without a second question

Now suppose the sender is uncertain whether its command finished. Perhaps the process
exited after the store committed, or delivery failed after recording. Sending the same
question as an unrelated new message could create a second obligation for the recipient.

ACC accepts a client message id as an equivalence key. The same key and equivalent content
return the original message. Reusing that key with different content is an error. A genuinely
new question needs a new key. This makes recovery explicit without collapsing distinct
messages that happen to have similar text.

[Show the retry and header-listing steps in the CLI replay. Compare the message id and
single inbox item. Keep the remaining replay steps brief because the receipt semantics
were already explained.]

There are two different kinds of duplicate here. An equivalent retry should not create
a second durable message. A crash after a transport accepts bytes can still permit a
repeat display. Stable identity helps us reason about both, but the guarantees differ.

This is why I prefer a replay with assertions to a pretty prerecorded conversation.
If the retry starts creating a second message, the replay stops instead of continuing
to narrate a success that the system no longer provides.

### Slide 7, 14:00–16:00 — Participant and session generation

The address and the process opening need different identities. A participant is the stable
address used for messages. A session is one current opening of that participant. Its
generation distinguishes the owner of this opening from a process that used to own it.

That distinction appears on mutations and inbox operations. The caller supplies its own
session and generation. A stale process cannot take over the replacement's records just
because it knows a public participant id. An inbox read must also belong to the recipient
whose receipt it advances.

A native hook supplies the current caller pair. An agent doesn't discover its credentials
by selecting the only session in status. Public visibility is not ownership. This becomes
especially important when tools spawn subprocesses or several sessions use the same client.

Workspace identity is another separate fact. Git worktrees can share a coordination room
while keeping different checkout files. Git is optional. A session retains the room chosen
at startup as it moves through child directories. The runtime state stays outside those
repositories.

None of this is a security boundary against an attacker who already controls the same
local account and its files. It is an ownership and lifecycle boundary for cooperating
clients, including stale processes and accidental identity confusion. Name that scope
clearly instead of calling every id an authentication system.

### Slide 8, 16:00–18:00 — Claims have a limited job

Intent says what a session is doing. It doesn't reserve anything. A claim makes a more
specific commitment: this session holds a lease for this canonical resource.

In our example the API and UI scopes don't overlap. If the UI session also asks to claim
an API file, the claim operation refuses the overlap and names the current holder. The
peers can narrow their scopes or communicate about the dependency. ACC doesn't choose
which task is more important.

The reservation is advisory by default. Some clients expose certified guards for relevant
writes, but guarded claims need those capabilities and an explicit request. Even a guard
cannot stop another program or a mutation path the client never presents to its hook.
A file claim isn't a universal filesystem lock.

Leases also matter. A process can disappear without a useful final message. A reservation
needs expiry and visible ownership so the project doesn't remain blocked indefinitely.
Generation checks prevent an old process from renewing or releasing the replacement's work.

The reproducible test for this boundary runs independent processes contending for one
exclusive claim. A Promise race inside one process wouldn't establish the writer-lock
behavior we're relying on. Match the test's boundary to the claim it is supposed to prove.

### Slide 9, 18:00–21:00 — Support, reachability and consent

A capability claim sounds simple: this client can receive a message. In practice it hides
several independent questions.

First, what exact behavior has been captured from an installed client? A method in our
source or a vendor's documented API isn't enough. The integration might write valid JSON
that the client silently ignores. The evidence needs to reach the client and observe the
behavior the product promises.

Second, is the relevant session reachable now? A captured minimum version does not tell
us whether this current thread has a live binding. Runtime identity, protocol handshake,
lease and endpoint reachability have to agree. An embedded chat can also use a different
server layout from the terminal client with the same brand name.

Third, did the recipient opt into live delivery? Waking a session can spend model tokens.
That policy belongs to the user. ACC's live acceleration is experimental and off by default.
The router rereads current consent rather than treating an old binding as permanent permission.

Finally, what remains when one of those answers is no? The durable inbox remains. Depending
on the adapter, a normal turn can carry a message, or the participant can explicitly read
its inbox. The operator should be able to see the degradation and its reason.

The transport details also differ. In the captured Claude Code path, ACC sends fixed wake
text containing the message id. The next-turn hook carries the attributed body. A wake by
itself leaves the receipt queued. In eligible Codex sessions, the native path uses the
local daemon's protocol, and a busy session takes the message after its current turn.
Those are client-specific observations, not a universal wake contract.

You can apply this separation to many integrations. Store static compatibility evidence,
measure current reachability, keep permission current, and give the user a useful fallback.
Don't compress all four into one green installed badge.

### Slide 10, 21:00–23:00 — Peer text remains untrusted

Successful delivery creates another problem: a model now sees text from another model.
That text can sound authoritative, but its arrival doesn't make it a user instruction.

ACC renders an attributed peer envelope with the sender, message id, kind and obligation.
The frame identifies the text as untrusted peer input. Rendering escapes terminal controls
and fence-like content, and respects a bounded context budget. If a body doesn't fit, the
agent gets its identity and an exact inbox recovery path rather than a truncated frame.

Those controls preserve the transport boundary. They don't make a model incapable of
following persuasive text. The recipient still has to use its own instructions and
permissions. A message saying the human approved an action isn't approval merely because
another session wrote it.

The data-minimization boundary is similarly precise. ACC doesn't collect raw transcripts,
but a sender can put sensitive text in an explicit message. The tool preserves that body.
It doesn't promise to recognize and remove every secret the sender chooses to transmit.
Also, a coding client can send its received context to its normal model provider. Local
coordination storage doesn't make the whole model workflow offline.

When evaluating an agent integration, keep transport integrity, authority and model behavior
as separate subjects. An escaped message and an attributed envelope are useful controls.
They aren't a proof that the model's next action will be safe or correct.

### Slide 11, 23:00–25:00 — Coordination can fail open

A hook runs in the path of somebody else's work. If the coordination layer blocks that
path whenever its store is slow or unavailable, it becomes the reason the coding session
can't make progress.

ACC's hook boundary therefore fails open on coordination timeout or failure. It reports
the degradation and allows the client to continue. That is a product invariant, not just
an exception handler added to make a test green.

There is a tradeoff. Continuing without fresh coordination context can mean a session
misses a dependency or claim conflict. A guarded integration is also limited by what the
client can observe. We don't claim that failing open preserves every reservation under
every outage.

At the storage boundary, corrupt or incompatible durable data is different. Refusing to
mutate a store we can't interpret protects the records. The client hook can continue while
ACC declines that mutation. Separate the health of the coordination subsystem from whether
the coding tool itself may run.

This distinction helped identify a performance problem. The system could correctly fail
open yet still stop providing useful context in a large workspace because its hook budget
was consumed. Passing the client through was necessary, but it wasn't enough for a useful
integration. We had to measure the work inside the budget.

### Slide 12, 25:00–27:00 — A hook reread the backlog

The historical measurements on this slide came from a copied real data home, with three
alternating rounds between main and the change, on macOS and Node 26.5.1. They are retained
development evidence, not a benchmark I just ran on the stage machine.

Before the change, a turn read messages and receipts three times. Sync took a whole-store
read. Next-turn delivery read those records again. The hook then collected a closing status
that read the store a third time. The heartbeat also loaded every session when it needed
only its own record.

In the largest copied workspace, a turn went from a measured range of 3.21 to 3.80 seconds
to 0.39 to 0.41 seconds after the changes. The table shows the other two workspaces too.
At higher machine load, the old hook could cross its budget and continue without ACC context.

The lesson is about unnecessary reads and the actual workload, rather than a general claim
about agent speed. A quiet fixture with a few records would hide the problem. Growing
backlogs and machine contention mattered.

The remaining limit matters as well. The turn still reads every message and receipt once.
The change removes repetition but doesn't make cost independent of workspace size. A
performance slide should say what got cheaper and what still grows.

### Slide 13, 27:00–29:00 — One shared read per turn

Here are the changes underneath those ranges. The hook reads one snapshot and passes it
to sync and next-turn delivery. It asks for the closing session status only when a caller
explicitly needs it. The heartbeat loads its own session as an exact transaction record.
The filesystem reader loads a bounded number of records concurrently and preserves their
listing order.

[Open the actual source anchors in evidence.md. Show the snapshot handoff, includeSessions
check, and exact session read. Keep the code font large. Spend roughly forty-five seconds
on code, not a tour of the whole package tree.]

The accompanying test observes filesystem reads in a real before-turn hook. Removing the
shared read made it count ninety message reads in a thirty-message fixture. Reintroducing
the old heartbeat made the session-read count expand again. The assertions detect the
specific unnecessary work rather than relying on a noisy timing threshold alone.

A wall-clock measurement tells us whether the change mattered for the copied workload.
The read-count mutation tells us which regression the gate catches. Both are useful, and
they answer different questions.

### Slide 14, 29:00–31:00 — The installed boundary is the test

Integration tests can be green without reaching the promised behavior. A configuration
writer can produce a file that looks reasonable. A hook command can be registered even
though the executable it names isn't available in the installed package. A client may
accept a setting and ignore the event it describes.

The repository therefore tests the artifact users receive. Package verification checks
bundled workspaces, command entrypoints, a non-Git project and installation ownership.
Native capability records retain the exact client capture and its limits. The current
release-candidate evidence also describes real client binaries run against a local model
stub. That verifies integration transport and hook behavior without claiming anything
about a provider model's reasoning quality.

The extra rule is to prove a new gate with a mutation. Make the intended bad behavior
happen and watch the relevant assertion fail. Restore it and run again. Otherwise the
check might only be measuring the convenience of its fixture.

[Point to the replay's duplicate-message assertion and the existing installed-client
capture sources. Do not show private runtime files or use a historical capture as proof
of the currently open session's activation.]

This is the broader takeaway for agent tooling. Follow the claim through packaging,
client loading, transport and model-visible context. Put the test at the boundary where
the promised behavior becomes observable.

### Slide 15, 31:00–33:00 — Current boundaries

Let's be explicit about the scope before trying this in another setup. ACC coordinates
sessions on one machine under one operating-system user. Git is optional. Worktrees can
share a room, but that doesn't make their checkout files identical or merge their changes.

The shared store contains explicit coordination records. It isn't a shared raw conversation,
and the participating clients retain their provider access. Models can choose when to ask
for help, but ACC doesn't guarantee that they identify every dependency. The deterministic
parts are the protocol and ownership checks, not the quality of the agents' choices.

Claims have the advisory and guard limits we discussed. Native delivery depends on the
particular client evidence, current handshake and recorded consent. Turning live delivery
off prevents new offers, but it can't recall bytes a vendor queue already accepted.

Those boundaries define a sensible first experiment. Choose a small dependency whose
result you can inspect. Observe the exchange and the artifact separately. If the workflow
requires a manual prompt to read an inbox, include that in the result rather than excluding
it from the story.

I don't have a controlled productivity measurement to claim here. What I have is a working
local protocol, client evidence, and specific failure modes that other builders can
reproduce. The next useful evidence is what happens in your actual two-client workflow.

### Slide 16, 33:00–35:00 — One real dependency

The experiment I'd like you to try is deliberately small. Open the two clients you already
use. Give each one a bounded part of the same feature. Choose a point where one session
needs a fact owned by the other, such as an API response shape.

Observe whether the session asks, whether the question reaches the right recipient, and
whether the answer reaches the sender. Then inspect the resulting artifact. If you still
carry the message yourself, write down exactly where and why. That is useful information,
even if the underlying protocol behaved correctly.

For a reproducible report, include the client versions, operating system, the small task,
and a redacted message id or receipt observation. Don't publish credentials, socket paths,
raw conversations or private project data. A minimal fixture is more helpful than a claim
that everything felt faster.

The implementation and the CLI replay are in the ACC repository shown here. There is no
signup step in this talk. If you want to try the workflow or inspect a particular adapter,
find me afterwards and we'll walk through the boundary that interests you.

The idea I hope you reuse is simple: record the coordination fact first, name only the
delivery evidence you have, and verify the integration where the client actually receives
it. Those choices make the uncertain part of an agent workflow easier to see and debug.

## Q&A, reserve ten minutes at the Summit

**Why not a subagent framework?** This case connects sessions the user already opened in
separate clients. A framework that owns the whole lifecycle is appropriate for a different
workflow. ACC carries coordination facts while each session retains its own authority.

**Why not native messaging?** If your chosen client already covers the sessions you need,
try its channel. ACC's motivating case crosses independently opened clients and vendors.
Avoid claiming a particular current vendor feature is absent without checking it.

**Is MCP enough?** MCP exposes the same operations, but a receiver polling a tool isn't a
captured next-turn injection or wake. A sender can still reach a recipient with an eligible
native adapter. Native delivery and generic tool access are separate capabilities.

**Does this guarantee agents work together?** No. It exposes peers and transports explicit
messages. The agents can miss dependencies, decline work or reason incorrectly. Evaluate
the resulting artifacts separately from transport evidence.

**What happens without live delivery?** Durable recording remains. A supported normal-turn
hook or an explicit owned inbox read recovers the body. Use doctor and exact message history
for the concrete session instead of inferring activation from installation.

**Does acknowledged mean finished?** It means the recipient acknowledged or replied. The
body might decline the request. Completion requires evidence of the actual result.

**Is this exactly-once delivery?** Equivalent sends with the same retry key return the same
durable message. A crash after an accepted transport offer and before receipt commit can
cause another display. Do not describe those two boundaries as a universal exactly-once guarantee.

**Can agents bypass each other's permissions?** Peer text doesn't grant authority or transfer
approval. Each client retains its controls. ACC isn't a sandbox against malicious processes
already controlling the same OS account, and models can still mishandle untrusted text.

**Is everything private/offline?** ACC storage and coordination transport stay local. Clients
use their ordinary providers, which can receive model context. Explicit message bodies can
contain whatever the sender put in them. No transcript collection isn't a blanket privacy claim.

**Will it prevent all file conflicts?** Claims are advisory by default. Certified guards
cover specific client paths when requested. Unrelated programs and unobserved writes remain
outside that scope. Worktrees also keep files separate, requiring normal Git integration.

**What did the performance change prove?** It reduced measured hook wall time in three copied
workspaces and removed repeated record reads. It didn't establish productivity, universal
latency or constant cost. The backlog still contributes to each turn's read work.

**How can I help?** Try one real dependency with two independent clients. Report versions,
platform, observed receipt facts, and the precise place human forwarding was still needed.
A small redacted reproduction is the most useful feedback.
