import { readFile } from "node:fs/promises";

import { CommsError, EXIT } from "./errors.mjs";
import { validateAgentId } from "./schema.mjs";

function valueWithoutNul(value, name) {
  if (typeof value !== "string") throw new CommsError(`${name} must be a string`, EXIT.DATA);
  if (value.includes("\0")) throw new CommsError(`${name} must not contain a NUL byte`, EXIT.DATA);
  return value;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellOwnership(value) {
  return value.split(" --ownership ").map(shellQuote).join(" --ownership ");
}

export async function renderPrompt(input) {
  const templatePath = valueWithoutNul(input.templatePath, "template path");
  const agentId = validateAgentId(valueWithoutNul(input.agentId, "agent id"));
  const role = valueWithoutNul(input.role, "role");
  const task = valueWithoutNul(input.task, "task");
  const ownership = valueWithoutNul(input.ownership, "ownership");
  const template = await readFile(templatePath, "utf8");
  return template
    .replaceAll("<AGENT_ID_SHELL>", shellQuote(agentId))
    .replaceAll("<ROLE_SHELL>", shellQuote(role))
    .replaceAll("<TASK_SHELL>", shellQuote(task))
    .replaceAll("<OWNERSHIP_SHELL>", shellOwnership(ownership))
    .replaceAll("<AGENT_ID>", agentId)
    .replaceAll("<ROLE>", role)
    .replaceAll("<TASK>", task)
    .replaceAll("<OWNERSHIP>", ownership);
}
