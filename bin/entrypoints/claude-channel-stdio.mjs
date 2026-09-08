// Workspace-free MCP fallback shared by composition and managed admission failure.
import { createInertChannel } from "@agents-can-communicate/adapter-claude-code/channel";

export function startInertChannel({ write = payload => process.stdout.write(JSON.stringify(payload) + "\n") } = {}) {
  const inert = createInertChannel({ write });
  pump(inert.handleLine, () => process.exit(0));
  return inert;
}

/** One line-delimited JSON pump, for the bound server and the unbound one alike. */
export function pump(handleLine, shutdown) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async chunk => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line !== "") await handleLine(line);
    }
  });
  process.stdin.on("end", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  // Keeps the child answerable for as long as Claude holds the transport open.
  process.stdin.resume();
}
