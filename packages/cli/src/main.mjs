import { AccError, CONFIG_FILENAME, EXIT, failure, ok }
  from "@agents-can-communicate/protocol";
import { createCoordinationService, noteNudge } from "@agents-can-communicate/core";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { parseArgs, positiveNumber } from "./args.mjs";

// A usage error names what is missing rather than failing deeper in a service
// with the argument already half-applied.
const usage = message => new AccError(EXIT.USAGE, message);
import { describeCommands, helpText } from "./help.mjs";
import { runUpdateCommand } from "./update-command.mjs";
import { runConfigCommand } from "./config-command.mjs";
import { runInstallCommand } from "./install-command.mjs";
import { runDoctor } from "./doctor-command.mjs";
import { createGitProbe } from "./git-probe.mjs";
import { canonicalClaim } from "./claim-spelling.mjs";
import { platformDataHome, runtimePaths } from "./runtime-paths.mjs";
import { resolveOwner } from "./session-owner.mjs";
import { discoverWorkspace } from "./workspace-discovery.mjs";

const DEFAULT_CADENCE_MS = 30_000;

/**
 * The claim a caller means when they name a resource instead of an id.
 *
 * `acc claim` takes `--resource`; `acc release` took `--claim`. The asymmetry
 * cost every caller - a person and an agent alike - a round trip through
 * `acc status --json` to find an id they never chose. The id is still accepted,
 * and is still the precise answer when two sessions hold the same resource and
 * an authority is releasing someone else's.
 */
async function claimOn(options, context) {
  if (options.resource === undefined) {
    throw new AccError(EXIT.USAGE,
      "release needs the claim to give back: --resource is what you claimed, "
      + "--claim is its id");
  }
  const resource = await canonicalClaim(options.resource, context.descriptor);
  const { claims } = await context.service.collectStatus({});
  // An authority releasing another session's claim is not looking for its own.
  const mine = claims.filter(claim => claim.resource === resource
    && (options.authority !== undefined || claim.ownerSessionId === options.session));

  if (mine.length === 0) {
    throw new AccError(EXIT.DATA, `no claim on ${resource} to release`,
      { resource, held: claims.map(claim => claim.resource) });
  }
  if (mine.length > 1) {
    throw new AccError(EXIT.DATA,
      `${mine.length} claims on ${resource}; name the one you mean with --claim`,
      { resource, claims: mine.map(claim => claim.claimId) });
  }
  return mine[0].claimId;
}

/**
 * Where this workspace's state lives, without reading a byte of it.
 *
 * Split out because `doctor` is the command a person runs when the store cannot
 * be read, and it has to know which store to look at before deciding whether
 * looking is safe.
 */
async function locateContext(options, runtime) {
  const descriptor = await discoverWorkspace({
    cwd: options.cwd ?? runtime.cwd,
    env: runtime.env,
    gitProbe: runtime.gitProbe ?? createGitProbe(),
    explicitConfig: options.workspace,
  });
  const paths = runtimePaths({
    dataHome: runtime.dataHome ?? platformDataHome({ platform: runtime.platform,
      env: runtime.env }),
    workspaceId: descriptor.id,
    workspaceRoots: descriptor.roots,
  });
  return { descriptor, paths };
}

async function withService({ descriptor, paths }, runtime) {
  const store = await openFilesystemStore({ root: paths.root, clock: runtime.clock,
    ids: runtime.ids, workspaceId: descriptor.id });
  return { descriptor, paths,
    service: createCoordinationService({ store, clock: runtime.clock, ids: runtime.ids }) };
}

async function openContext(options, runtime) {
  return withService(await locateContext(options, runtime), runtime);
}

/**
 * A context for the one command that has to survive an unopenable store.
 *
 * `runDoctor` already refused to read records before diagnosing them - fixed
 * after a truncated file made it answer "invalid JSON record" while the
 * inspection had already found the file and put it in a list nobody saw. The
 * throw then moved earlier: opening the store happens before any handler runs,
 * so one unreadable `protocol.json` killed the diagnosis a frame before the code
 * written to report it. Here the store is opened on request, after the report
 * has said that reading is safe.
 */
async function openDiagnosticContext(options, runtime) {
  const located = await locateContext(options, runtime);
  return { ...located, clock: runtime.clock,
    openService: async () => (await withService(located, runtime)).service };
}

const human = value => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** How many are here, and how many only look it. */
export function describePresence({ live = 0, stale = 0 } = {}) {
  if (live === 0) return "0 live";
  if (stale === 0) return `${live} live`;
  if (stale === live) return `${live} present, none answering`;
  return `${live} live (${stale} not answering)`;
}

const HANDLERS = Object.freeze({
  attach: async ({ options, context }) => {
    const session = await context.service.openSession({
      workspaceId: context.descriptor.id,
      participantId: options.participant,
      displayName: options.participant,
      harness: options.harness ?? "cli",
      parentSessionId: options.parent ?? null,
      heartbeatCadenceMs: options.cadence
        ? positiveNumber(options.cadence, "cadence") : DEFAULT_CADENCE_MS,
      sessionId: options.session,
      descriptor: context.descriptor,
    });
    // The adapter needs both to prove ownership later, so both are printed.
    return { data: { sessionId: session.sessionId, generation: session.generation },
      text: `${session.sessionId} ${session.generation}` };
  },

  heartbeat: async ({ options, context }) => {
    const session = await context.service.heartbeatSession({ sessionId: options.session,
      generation: options.generation });
    return { data: { heartbeatAt: session.heartbeatAt }, text: session.heartbeatAt };
  },

  detach: async ({ options, context }) => {
    const session = await context.service.closeSession({ sessionId: options.session,
      generation: options.generation });
    return { data: { sessionId: session.sessionId, state: session.state },
      text: `closed ${session.sessionId}` };
  },

  sync: async ({ options, context }) => {
    const result = await context.service.sync({ sessionId: options.session,
      cursor: options.cursor ?? null, scope: options.scope,
      limit: options.limit ? positiveNumber(options.limit, "limit") : undefined });
    // Solo zero-overhead: nothing to say means nothing printed, not a banner.
    const text = result.solo ? "" : `${result.attention.length} attention; `
      + `${result.roster.length} session(s); cursor ${result.cursor}`;
    return { data: result, text };
  },

  work: async ({ options, context }) => {
    // Saying nothing and saying "I have stopped" are different. Without this an
    // intent stayed on the roster until the session closed, so peers read a
    // finished piece of work as still in progress.
    if (options.clear === true) {
      const cleared = await context.service.clearIntent({ sessionId: options.session,
        generation: options.generation });
      return { data: cleared, text: "intent cleared" };
    }
    if (options.summary === undefined) throw usage("work requires --summary");
    const intent = await context.service.setIntent({ sessionId: options.session,
      generation: options.generation, summary: options.summary, mode: options.mode ?? "edit",
      state: options.state, workstreamId: options.workstream ?? null,
      resourceHints: options.hint ?? [] });
    return { data: intent, text: `intent: ${intent.summary}` };
  },

  claim: async ({ options, context }) => {
    const claim = await context.service.acquireClaim({ sessionId: options.session,
      generation: options.generation,
      resource: await canonicalClaim(options.resource, context.descriptor),
      mode: options.mode ?? "exclusive", enforcement: options.enforcement ?? "advisory",
      reason: options.reason ?? "unspecified",
      leaseSeconds: options.lease ? positiveNumber(options.lease, "lease") : undefined,
      descriptor: context.descriptor });
    return { data: claim, text: `claimed ${claim.resource}` };
  },

  release: async ({ options, context }) => {
    const claimId = options.claim ?? await claimOn(options, context);
    const request = { claimId, sessionId: options.session,
      generation: options.generation, authority: options.authority, reason: options.reason };
    if (options.authority === undefined) await context.service.releaseClaim(request);
    else await context.service.forceReleaseClaim(request);
    return { data: { claimId }, text: `released ${claimId}` };
  },

  message: async ({ options, context }) => {
    const message = await context.service.sendMessage({ sessionId: options.session,
      generation: options.generation, toParticipantIds: options.to ?? [],
      type: options.type ?? "note", subject: options.subject, body: options.body,
      priority: options.priority, workstreamId: options.workstream ?? null,
      requiresAck: options.requiresAck === true, descriptor: context.descriptor });
    // A note that reads like it wants a reply was sent with no ack obligation
    // and no standing reminder; say so once, without blocking the send. Carried
    // in `data` so an adapter reading `--json` sees it, and appended to `text`
    // for a person - the send already succeeded either way.
    const advice = noteNudge(message);
    return { data: advice ? { ...message, advice } : message,
      text: advice ? `sent ${message.messageId}\n${advice}` : `sent ${message.messageId}` };
  },

  inbox: async ({ options, context }) => {
    const messages = await context.service.readInbox({ sessionId: options.session,
      generation: options.generation, messageId: options.message });
    return { data: messages, text: messages.length === 0
      ? "inbox empty" : JSON.stringify(messages, null, 2) };
  },

  reply: async ({ options, context }) => {
    const result = await context.service.replyToMessage({ sessionId: options.session,
      generation: options.generation, messageId: options.message, body: options.body,
      subject: options.subject, type: options.type, priority: options.priority });
    return { data: result,
      text: `replied ${result.reply.messageId}; acknowledged ${options.message}` };
  },

  request: async ({ options, context }) => {
    const message = await context.service.sendMessage({
      sessionId: options.session,
      generation: options.generation,
      toParticipantIds: [options.to],
      type: "work_request",
      subject: options.title,
      body: options.detail ?? options.title,
      requiresAck: true,
      descriptor: context.descriptor,
    });
    return { data: message, text: `requested ${message.messageId} of ${options.to}` };
  },

  ack: async ({ options, context }) => {
    const receipt = await context.service.markDelivery({ sessionId: options.session,
      generation: options.generation, messageId: options.message,
      state: options.state ?? "acknowledged" });
    return { data: receipt, text: `${receipt.messageId} ${receipt.state}` };
  },

  finish: async ({ options, context }) => {
    const handoff = await context.service.finishSession({ sessionId: options.session,
      generation: options.generation, goal: options.goal, status: options.status,
      toParticipantId: options.to ?? null, completed: options.completed ?? [],
      remaining: options.remaining ?? [], blockers: options.blocker ?? [] });
    return { data: handoff, text: `handoff ${handoff.handoffId}` };
  },

  status: async ({ options, context }) => {
    const status = await context.service.collectStatus({
      participantId: options.participant, all: options.all === true });
    // `live` counts everyone present, which includes sessions gone stale - a
    // client that exited without its session being closed keeps a record that
    // stops being answered but does not disappear. Printing the number alone
    // said "1 live" about a workspace where the last agent had left minutes
    // before, which is the one thing a person reads this line to find out.
    const text = `${describePresence(status.counts)}; ${status.counts.claims} claim(s); `
      + `protection ${status.protection}`;
    return { data: status, text };
  },

  config: async ({ options, runtime }) => {
    const result = await runConfigCommand({ subcommand: options.subcommand,
      cwd: options.cwd ?? runtime.cwd,
      // A pipe is not a person. Without a TTY there is nobody to answer, so the
      // command demands --yes rather than hanging or assuming consent.
      interactive: runtime.stdout?.isTTY === true,
      yes: options.yes === true,
      // Not a silent no. A build that cannot ask says so: falling back to
      // "declined" is how `acc config init` came to print `not written` in a
      // terminal where nobody had been asked anything.
      confirm: runtime.confirm ?? (async () => {
        throw new AccError(EXIT.DATA, "this build was assembled without a way to ask");
      }),
      force: options.force === true,
      // Opened lazily and only by `init`: `config validate` has to work on a
      // workspace discovery cannot open, which is what a reader runs it to
      // find out.
      probeWorkspace: () => openContext(options, runtime),
      ids: runtime.ids });
    if (result.subcommand === "validate") {
      return { data: result, text: result.present
        ? `${result.file} is valid` : `no ${CONFIG_FILENAME}; defaults apply` };
    }
    return { data: result,
      text: result.written ? `wrote ${result.file}` : `not written: ${result.file}` };
  },

  install: async ({ options, runtime }) =>
    runInstallCommand({ options, runtime, action: "install" }),

  uninstall: async ({ options, runtime }) =>
    runInstallCommand({ options, runtime, action: "uninstall" }),

  doctor: async ({ options, context, runtime }) => runDoctor({ options, context, runtime }),

  update: async ({ options, runtime }) => runUpdateCommand({ options, runtime }),

  help: async () => ({ data: { commands: describeCommands() }, text: helpText() }),

  version: async ({ runtime }) => {
    // Read by the composition root from the package manifest: `bin/` sits at
    // the same depth in the published package as it does in this tree, which is
    // not true of anything under `packages/`. A version typed into the source
    // would be one more place the next bump has to reach, and the kind that
    // goes stale without failing.
    if (typeof runtime.version !== "function") {
      throw new AccError(EXIT.DATA, "this build was assembled without a version to report");
    }
    const version = await runtime.version();
    return { data: { version }, text: version };
  },
});

/**
 * @returns {Promise<number>} the process exit code
 */
const NO_WORKSPACE = Object.freeze(["config", "install", "uninstall", "help", "version",
  "update"]);

export async function main(argv, runtime) {
  const write = (stream, text) => new Promise((resolve, reject) =>
    stream.write(text, error => (error ? reject(error) : resolve())));
  let parsed;
  try {
    parsed = parseArgs(argv);
    // `config` is the one command that must work on a workspace ACC cannot
    // open. Discovery validates the config too, so a broken one would fail
    // there first and `acc config validate` - the command a user runs to find
    // out what is wrong - would never reach its own report.
    // These work on a machine, not a workspace. `config` must run even when
    // discovery cannot open the workspace - that is what a user is trying to
    // find out - install touches client configuration rather than ACC state,
    // and `help` has to answer in a directory that is no workspace at all.
    const context = NO_WORKSPACE.includes(parsed.command)
      ? null
      : parsed.command === "doctor"
        ? await openDiagnosticContext(parsed.options, runtime)
        : await openContext(parsed.options, runtime);
    // Which session is calling is answered once, here, rather than by each
    // handler: every one of them needs the same pair, and a handler that forgot
    // to ask would be an operation an agent cannot reach.
    const options = context === null ? parsed.options
      : await resolveOwner({ command: parsed.command, options: parsed.options,
        context, env: runtime.env });
    const { data, text, error: outcome } = await HANDLERS[parsed.command](
      { options, context, runtime });
    // A handler may have done real work and still failed: `acc install` writes
    // for the clients it could and reports the one it could not. The data is
    // printed either way, and the command still fails.
    if (outcome != null) throw Object.assign(outcome, { details: { ...outcome.details, ...data } });
    // Machine mode writes exactly one JSON object to stdout and nothing else.
    if (parsed.options.json === true) await write(runtime.stdout, `${JSON.stringify(ok(data))}\n`);
    else if (text !== "") await write(runtime.stdout, `${human(text)}\n`);
    return EXIT.OK;
  } catch (error) {
    const code = error instanceof AccError ? error.code : EXIT.DATA;
    // A usage error happens before the parse completes, so machine mode has to
    // be recognised from the raw argv. Otherwise the one caller that cannot
    // read prose - an adapter - gets prose exactly when it made a mistake.
    if (parsed?.options?.json === true || argv.includes("--json")) {
      await write(runtime.stdout, `${JSON.stringify(failure(error))}\n`);
    } else {
      await write(runtime.stderr, `${error.message}\n`);
    }
    return code;
  }
}
