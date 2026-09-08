"""Test-only stdlib PTY driver. Terminal bytes remain in memory, never in evidence.

The JSON control channel exposes only process IDs and known UI states. Every
child is owned by this process and reaped on EOF, exception, or explicit close.
"""
import atexit
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

if sys.argv[1:] == ["--probe"]:
    probe_master, probe_slave = pty.openpty()
    os.close(probe_master)
    os.close(probe_slave)
    print("pty-ok", flush=True)
    raise SystemExit(0)

clients = {}
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
osc = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)")


def emit(value):
    print(json.dumps(value), flush=True)


def drain(client):
    try:
        chunk = os.read(client["master"], 65536).decode(errors="replace")
    except OSError:
        return
    if "\x1b[6n" in chunk:
        os.write(client["master"], b"\x1b[1;1R")
    client["screen"] = (client["screen"] + chunk)[-100000:]


def close(role):
    client = clients.pop(role, None)
    if client is None:
        return None
    process = client["process"]
    if process.poll() is None:
        try:
            os.write(client["master"], b"\x03")
            time.sleep(0.15)
            os.write(client["master"], b"\x03")
            process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    os.close(client["master"])
    return process.returncode


def cleanup():
    for role in list(clients):
        close(role)


atexit.register(cleanup)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))


def handle(command):
    action = command["action"]
    role = command.get("role")
    if action == "launch":
        if role in clients:
            raise ValueError("role already running")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 160, 0, 0))
        try:
            process = subprocess.Popen(command["argv"], cwd=command["cwd"],
                                       env=command["env"], stdin=slave, stdout=slave,
                                       stderr=slave, start_new_session=True)
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        clients[role] = {"process": process, "master": master, "screen": ""}
        return {"pid": process.pid}
    if action == "close":
        return {"exit": close(role)}
    if action == "shutdown":
        cleanup()
        return {"cleaned": True}
    client = clients[role]
    if action == "send":
        client["screen"] = ""
        os.write(client["master"], command["text"].encode())
        return {"sent": True}
    if action == "status":
        text = ansi.sub("", osc.sub("", client["screen"]))
        cwd_compact = re.sub(r"\s+", "", text)
        archive_compact = re.sub(r"\s+", "", text)
        return {"pid": client["process"].pid, "exit": client["process"].poll(),
                "projectTrust": "Yes, continue" in text or "Do you trust" in text,
                "hookTrust": bool(re.search(r"trust\s*all", text, re.I)) or ("Hooks" in text and "Trust" in text and "Continue" in text),
                "signIn": "Sign in with ChatGPT" in text,
                "working": "Working" in text or "Thinking" in text,
                "modelError": "not supported" in text or "model not found" in text,
                "rateLimited": "usage limit" in text.lower() or "rate limit" in text.lower(),
                "limitDialog": [token for token in ["reached", "hit your usage limit", "usage limit", "rate limit", "reset", "try again at", "usage_limit_reached", "credits", "upgrade", "Upgrade", "Press", "temporarily unavailable", "try again", "Try again", "Switch", "switch", "Enter", "Esc", "continue", "Continue", "dismiss", "Dismiss", "tab", "status", "footer", "? for shortcuts", "Tip:", "Tip", "tokens", "Context", "100%", "›", "❯", "❱", "help", "select", "Press", "Press enter", "ctrl", "esc"] if token in text],
                "connectionError": "Reconnecting" in text or "stream disconnected" in text,
                "unsupportedCd": "Unrecognized command '/cd'" in text,
                "cwdSelection": all(phrase in cwd_compact for phrase in [
                    "Chooseworkingdirectoryto",
                    "Usesessiondirectory(",
                    "Usecurrentdirectory("
                ]),
                "archiveConfirmation": all(phrase in archive_compact for phrase in [
                    "Archivethissession?",
                    "No,don'tarchive",
                    "Yes,archiveandexit"
                ]),
                "cdBlock": next((code for phrase, code in [
                    ("This directory is not trusted; run Codex there.", "destination-untrusted"),
                    ("This task cannot be safely replaced.", "unsafe-replacement"),
                    ("MCP inventory is still loading.", "inventory-loading"),
                    ("Cannot change: another agent is running.", "another-agent-running"),
                    ("Permission profile has different settings.", "permission-settings"),
                    ("Permission profile cannot be preserved by /cd.", "permission-preservation"),
                    ("Conversation history is not saved.", "history-unpersisted"),
                    ("Active background terminals block /cd.", "background-terminals"),
                    ("Requested directory or permissions not applied.", "transition-refused")
                ] if phrase in text), None),
                "directoryChanged": "Working directory changed to:" in text,
                "invalidArgs": "unexpected argument" in text,
                "updatePrompt": "Update now" in text,
                "ready": "gpt-" in text and "context left" in text,
                "terminalBytes": len(client["screen"]),
                "tokens": [token for token in ["trust", "Trust", "Continue", "continue", "hooks", "Hooks",
                          "folder", "directory", "gpt-", "context", "left", "Sign", "Select", "Enter",
                          "Welcome", "Would", "Loading", "Update", "permissions", "version", "Session"] if token in text]}
    raise ValueError("unknown control action")


pending = b""
while True:
    readers = [sys.stdin.fileno()] + [client["master"] for client in clients.values()]
    ready, _, _ = select.select(readers, [], [], 0.2)
    for client in list(clients.values()):
        if client["master"] in ready:
            drain(client)
    if sys.stdin.fileno() in ready:
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            break
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            command = json.loads(line)
            try:
                emit({"id": command["id"], "result": handle(command)})
            except Exception as error:
                emit({"id": command["id"], "error": type(error).__name__})
