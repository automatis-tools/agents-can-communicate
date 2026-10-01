# Keeps one interactive program in a terminal for a test: a ConPTY on Windows
# (pywinpty), a pseudo-terminal elsewhere. Everything the program draws is
# appended to a log; stdin takes {"op": "send", "text": ...} or {"op": "quit"}.
# The first stdout line is {"pid": <the program's pid>}.
import json
import os
import sys
import threading

argv = json.loads(sys.argv[1])
log_path = sys.argv[2]
cwd = sys.argv[3]

if os.name == "nt":
    from winpty import PtyProcess

    child = PtyProcess.spawn(argv, cwd=cwd, env=dict(os.environ), dimensions=(50, 200))
    pid = child.pid

    def read():
        return child.read(65536)

    def write(text):
        child.write(text)

    def stop():
        child.terminate(force=True)
else:
    import pty
    import signal

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(argv[0], argv, dict(os.environ))

    def read():
        data = os.read(fd, 65536)
        if not data:
            raise EOFError
        return data.decode("utf-8", "replace")

    def write(text):
        os.write(fd, text.encode("utf-8"))

    def stop():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

print(json.dumps({"pid": pid}), flush=True)


def pump():
    with open(log_path, "a", encoding="utf-8", errors="replace") as log:
        while True:
            try:
                data = read()
            except (EOFError, OSError):
                break
            log.write(data)
            log.flush()


threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    command = json.loads(line)
    if command.get("op") == "send":
        write(command["text"])
    elif command.get("op") == "quit":
        break
stop()
