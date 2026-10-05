// What `codex app-server proxy --sock <path>` does, for tests: relay this
// process's stdio bytes to the app-server control socket and back.
import net from "node:net";

const socketPath = process.argv[process.argv.indexOf("--sock") + 1];
const socket = net.createConnection(socketPath);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));
