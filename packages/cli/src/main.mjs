import { AccError, CONFIG_FILENAME, EXIT, failure, ok }
  from "@agents-can-communicate/protocol";
import { createCoordinationService } from "@agents-can-communicate/core";
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

async function openContext(options, runtime) {
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
  const store = await openFilesystemStore({ root: paths.root, clock: runtime.clock,
    ids: runtime.ids, workspaceId: descriptor.id });
  return { descriptor, paths,
    service: createCoordinationService({ store, clock: runtime.clock, ids: runtime.ids }) };
}

const human = value => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

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
    const request = { claimId: options.claim, sessionId: options.session,
      generation: options.generation, authority: options.authority, reason: options.reason };
    if (options.authority === undefined) await context.service.releaseClaim(request);
    else await context.service.forceReleaseClaim(request);
    return { data: { claimId: options.claim }, text: `released ${options.claim}` };
  },

  message: async ({ options, context }) => {
    const message = await context.service.sendMessage({ sessionId: options.session,
      generation: options.generation, toParticipantIds: options.to ?? [],
      type: options.type ?? "note", subject: options.subject, body: options.body,
      priority: options.priority, workstreamId: options.workstream ?? null,
      requiresAck: options.requiresAck === true, descriptor: context.descriptor });
    return { data: message, text: `sent ${message.messageId}` };
  },

  /**
   * Ask another agent to do something. One call, one write.
   *
   * The recipient hears about it twice by design: the task raises an attention
   * item for the participant it names, and the message reaches their turn as
   * quoted peer text explaining why.
   */
  request: async ({ options, context }) => {
    const { task, message } = await context.service.requestWork({
      sessionId: options.session, generation: options.generation,
      toParticipantId: options.to, title: options.title, detail: options.detail,
      workstreamId: options.workstream, priority: options.priority,
      dependsOn: options.dependsOn ?? [], descriptor: context.descriptor });
    return { data: { task, message },
      text: `requested ${task.taskId} of ${options.to}` };
  },

  ack: async ({ options, context }) => {
    const receipt = await context.service.markDelivery({ sessionId: options.session,
      generation: options.generation, messageId: options.message,
      state: options.state ?? "acknowledged" });
    return { data: receipt, text: `${receipt.messageId} ${receipt.state}` };
  },

  /**
   * What was settled, and on whose authority.
   *
   * `--human` is the caller stating that a person actually decided this. The
   * core refuses `--authority human` without it, because a peer proposal
   * becoming a human decision on its own is the one way this record could
   * launder an agent's opinion into a ruling.
   */
  decide: async ({ options, context }) => {
    const decision = await context.service.recordDecision({
      sessionId: options.session, generation: options.generation,
      title: options.title, outcome: options.outcome,
      authority: options.authority ?? "workstream",
      workstreamId: options.workstream ?? null,
      decidedBy: options.decidedBy,
      supersedes: options.supersedes ?? null,
      humanConfirmed: options.human === true,
      descriptor: context.descriptor });
    return { data: decision,
      text: `${decision.decisionId} ${decision.authority}: ${decision.title}` };
  },

  workstream: async ({ options, context }) => {
    const owner = { sessionId: options.session, generation: options.generation };
    // Taking the coordination of one and creating one are the same noun, so
    // they stay one command rather than two the model has to choose between -
    // the same shape `acc task` already has.
    if (options.take === true || options.release === true) {
      if (options.workstream === undefined) {
        throw usage(`workstream --${options.take === true ? "take" : "release"} `
          + "requires --workstream");
      }
      const acted = options.take === true
        ? await context.service.acquireCoordinator({ ...owner,
          workstreamId: options.workstream })
        : await context.service.releaseCoordinator({ ...owner,
          workstreamId: options.workstream });
      return { data: acted,
        text: `${acted.workstreamId} ${options.take === true ? "coordinated" : "released"}` };
    }
    if (options.title === undefined) throw usage("workstream requires --title");
    if (options.objective === undefined) throw usage("workstream requires --objective");
    const workstream = await context.service.createWorkstream({ ...owner,
      title: options.title, objective: options.objective,
      descriptor: context.descriptor });
    return { data: workstream, text: `${workstream.workstreamId} ${workstream.state}` };
  },

  task: async ({ options, context }) => {
    const owner = { sessionId: options.session, generation: options.generation };
    // Taking work and moving it along are the same noun as creating it, so they
    // stay one command rather than three the model has to choose between.
    if (options.take === true) {
      if (options.task === undefined) throw usage("task --take requires --task");
      const taken = await context.service.claimTask({ ...owner, taskId: options.task,
        force: options.force === true });
      return { data: taken, text: `${taken.taskId} ${taken.state}` };
    }
    if (options.decline === true) {
      if (options.task === undefined) throw usage("task --decline requires --task");
      const refused = await context.service.declineTask({ ...owner,
        taskId: options.task, reason: options.reason });
      return { data: refused, text: `${refused.taskId} declined` };
    }
    if (options.state !== undefined) {
      if (options.task === undefined) throw usage("task --state requires --task");
      const moved = await context.service.transitionTask({ ...owner,
        taskId: options.task, state: options.state });
      return { data: moved, text: `${moved.taskId} ${moved.state}` };
    }
    if (options.title === undefined) throw usage("task requires --title");
    const task = await context.service.createTask({ ...owner,
      workstreamId: options.workstream, title: options.title, detail: options.detail,
      assigneeParticipantId: options.assignee, taskId: options.task,
      dependsOn: options.dependsOn ?? [], descriptor: context.descriptor });
    return { data: task, text: `${task.taskId} ${task.state}` };
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
    const text = `${status.counts.live} live; ${status.counts.claims} claim(s); `
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
