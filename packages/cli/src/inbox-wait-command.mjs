import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { positiveNumber } from "./args.mjs";

// `acc inbox --wait <seconds>` (#147): the ordinary first page, once a message
// for the caller is recorded after the wait starts or the time passes. Six
// hundred seconds is the longest a Claude Code shell command may run.
const MAX_SECONDS = 600;

const usage = message => { throw new AccError(EXIT.USAGE, message); };

export async function runInboxWait({ options, context }) {
  if (options.message !== undefined) usage("--wait cannot read one message; drop --message");
  if (options.cursor !== undefined) usage("--wait returns the first page; drop --cursor");
  const seconds = Number(options.wait);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    usage(`--wait must be a whole number of seconds from 1 to ${MAX_SECONDS}`);
  }
  const page = await context.service.waitForInbox({ sessionId: options.session,
    generation: options.generation, waitMs: seconds * 1000,
    limit: options.limit === undefined ? undefined : positiveNumber(options.limit, "limit") });
  const text = JSON.stringify(page, null, 2);
  return { data: page, text: page.wait.arrived ? text : `${text}\nno new message after ${seconds}s` };
}
