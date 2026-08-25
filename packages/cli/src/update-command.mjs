import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { platformPaths } from "./platform-paths.mjs";
import { checkingIsOff, fetchLatest, isNewer, writeCachedCheck } from "./update-check.mjs";

const execFileAsync = promisify(execFile);

/**
 * The two commands an upgrade takes, and why it is two.
 *
 * `npm install -g` replaces this CLI and the hook runtime, because the shim a
 * client runs points into the npm directory rather than at a copy. It does not
 * touch what was written into the client: its hook wiring, and the skills the
 * agents read. Measured after an upgrade - the client still had `0.1.0` while
 * `acc --version` said `0.1.1`, and nothing said so.
 */
export const upgradeSteps = version => [
  ["npm", ["install", "--global", `agents-can-communicate@${version}`]],
  ["acc", ["install"]],
];

const spell = ([command, argv]) => `  ${command} ${argv.join(" ")}`;

export async function runUpdateCommand({ options, runtime }) {
  const env = runtime.env ?? {};
  const { data: dataHome } = platformPaths({ platform: runtime.platform, env });
  const running = typeof runtime.version === "function" ? await runtime.version() : null;

  // Off means off, and it says so rather than reporting that nothing is newer -
  // which is a different fact, and one this run did not establish.
  if (checkingIsOff(env)) {
    return { data: { checked: false, running, latest: null },
      text: "update checking is off (ACC_NO_UPDATE_CHECK); nothing was asked" };
  }

  const latest = await fetchLatest({ get: runtime.fetch });
  await writeCachedCheck(dataHome, { latest, checkedAt: runtime.clock.now() },
    { writeFile, mkdir });

  if (!isNewer(latest, running)) {
    return { data: { checked: true, running, latest, newer: false },
      text: `acc ${running} is the latest` };
  }

  const steps = upgradeSteps(latest);
  const data = { checked: true, running, latest, newer: true,
    steps: steps.map(([command, argv]) => [command, ...argv].join(" ")) };

  if (options.apply !== true) {
    return { data, text: [`acc ${latest} is available; you have ${running}`, "",
      ...steps.map(spell), "", "or run: acc update --apply"].join("\n") };
  }

  const spawn = runtime.spawn ?? ((command, argv) => execFileAsync(command, argv, { env }));
  const done = [];
  for (const [command, argv] of steps) {
    try {
      await spawn(command, argv);
      done.push([command, ...argv].join(" "));
    } catch (error) {
      // Named rather than swallowed, and the rest of the commands are printed:
      // a global install refused for want of permission is the ordinary case,
      // and the person can finish it by hand from here.
      return { data: { ...data, applied: done, failed: [command, ...argv].join(" ") },
        text: [`${command} failed: ${error.message}`, "", "finish it with:",
          ...steps.slice(done.length).map(spell)].join("\n"),
        error: undefined };
    }
  }
  return { data: { ...data, applied: done }, text: `updated to ${latest}` };
}
