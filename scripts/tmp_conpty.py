# Measurement only (throwaway branch): keep one console program alive in a
# ConPTY, append everything it draws to a log, and type what stdin asks for.
# Lines on stdin: {"op": "send", "text": "..."} or {"op": "quit"}.
import json
import os
import sys
import threading

from winpty import PtyProcess

argv = json.loads(sys.argv[1])
log_path = sys.argv[2]
cwd = sys.argv[3]

process = PtyProcess.spawn(argv, cwd=cwd, env=dict(os.environ), dimensions=(50, 200))
print(json.dumps({"pid": process.pid}), flush=True)


def pump():
    with open(log_path, "a", encoding="utf-8", errors="replace") as log:
        while True:
            try:
                data = process.read(65536)
            except EOFError:
                break
            except Exception as error:  # noqa: BLE001 - measurement only
                log.write(f"\n[conpty read error: {error!r}]\n")
                break
            log.write(data)
            log.flush()


threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    command = json.loads(line)
    if command.get("op") == "send":
        process.write(command["text"])
    elif command.get("op") == "quit":
        break
try:
    process.terminate(force=True)
except Exception:  # noqa: BLE001
    pass
