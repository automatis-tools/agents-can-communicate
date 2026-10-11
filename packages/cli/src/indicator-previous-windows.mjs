import { spawn } from "node:child_process";

// A detached cmd.exe loses its standard handles. Keep the owned Node launcher
// detached, and let a normal hidden shell inherit its original stdin/stdout.
const child = spawn(process.argv[2], { shell: true, windowsHide: true, stdio: "inherit" });
child.once("spawn", () => process.send?.("started", () => {}));
child.once("error", () => process.exit(0));
child.once("exit", () => process.exit(0));
