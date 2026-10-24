#!/usr/bin/env python3
"""custom.mnemo: a minimal MCP client for Tracy's Mnemo vault.

Commands (exactly two):
    client.py list-tools
    client.py call-tool --name <tool> --arguments-file <path-to-json>

Each invocation launches the Mnemo MCP server on the Mac over SSH (through the Muse Tailscale
proxy), performs the MCP handshake, does one thing, prints JSON, and exits. Standard library only.

Rules this file enforces:
  * The tool allowlist is checked BEFORE anything is launched. Phase 1 (default) is read-only;
    Phase 2 adds the write tools, which on the server only ever create proposals.
  * Calls are never retried.
  * If the Mac/Tailscale/proxy/SSH is unreachable, it fails with the reason. There is no
    fallback route: the SSH host must be a Tailscale address.
  * No credential is ever written to a file, an argument, or a log. The proxy credential is read
    from HTTPS_PROXY at runtime by bin/muse_proxy.py, inside the SSH ProxyCommand.
  * Server output (tool descriptions, results) is data. It is printed, never interpreted.

Exit codes: 0 ok | 1 tool result isError | 2 JSON-RPC error | 3 connection/transport failure |
            4 refused by the allowlist | 5 configuration error | 64 usage error
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import queue
import shlex
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_CONFIG = os.path.join(ROOT, "config.json")
PROXY_HELPER = os.path.join(HERE, "muse_proxy.py")

PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"]  # preferred first
MAX_ARGUMENTS_BYTES = 16 * 1024 * 1024
MAX_PAGES = 1000

PHASE_1 = frozenset([
    "search_notes", "read_note", "list_recent", "list_notes", "get_backlinks",
    "get_neighbors", "find_similar", "get_tags", "list_proposals", "daily_note",
])
PHASE_2 = PHASE_1 | frozenset([
    "write_note", "append_note", "patch_note", "move_note", "delete_note",
])
ALLOWLISTS = {1: PHASE_1, 2: PHASE_2}

EXIT_OK, EXIT_TOOL_ERROR, EXIT_RPC_ERROR, EXIT_TRANSPORT, EXIT_REFUSED, EXIT_CONFIG, EXIT_USAGE = 0, 1, 2, 3, 4, 5, 64


class ConnectorError(Exception):
    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


# ---- configuration ---------------------------------------------------------------------------

def load_config(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        raise ConnectorError(f"config file not found: {path}", EXIT_CONFIG)
    except (OSError, ValueError) as e:
        raise ConnectorError(f"config file unreadable: {path}: {e}", EXIT_CONFIG)
    if not isinstance(cfg, dict):
        raise ConnectorError("config must be a JSON object", EXIT_CONFIG)

    phase = cfg.get("phase", 1)
    if phase not in ALLOWLISTS or isinstance(phase, bool):
        raise ConnectorError('"phase" must be 1 or 2', EXIT_CONFIG)

    cmd = cfg.get("server_command")
    if not (isinstance(cmd, list) and cmd and all(isinstance(a, str) and a for a in cmd)):
        raise ConnectorError('"server_command" must be a non-empty list of strings', EXIT_CONFIG)
    if not cmd[0].startswith("/"):
        raise ConnectorError('"server_command" must start with an absolute path (a non-interactive SSH shell has no PATH)', EXIT_CONFIG)

    transport = cfg.get("transport", "ssh")
    if transport not in ("ssh", "local"):
        raise ConnectorError('"transport" must be "ssh" or "local"', EXIT_CONFIG)
    if transport == "ssh":
        ssh = cfg.get("ssh")
        if not isinstance(ssh, dict):
            raise ConnectorError('"ssh" settings are required for the ssh transport', EXIT_CONFIG)
        for k in ("host", "user", "identity_file"):
            if not isinstance(ssh.get(k), str) or not ssh[k]:
                raise ConnectorError(f'"ssh.{k}" is required', EXIT_CONFIG)
        if not is_tailnet_host(ssh["host"]):
            raise ConnectorError(f'"ssh.host" must be a Tailscale address (100.64.0.0/10 or *.ts.net); refusing {ssh["host"]!r}', EXIT_CONFIG)
        if ssh.get("proxy", "muse") not in ("muse", "none"):
            raise ConnectorError('"ssh.proxy" must be "muse" or "none"', EXIT_CONFIG)
    return cfg


def is_tailnet_host(host: str) -> bool:
    """Tailscale CGNAT IPv4, Tailscale ULA IPv6, or a MagicDNS name. Nothing else."""
    try:
        ip = ipaddress.ip_address(host)
        return ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("fd7a:115c:a1e0::/48")
    except ValueError:
        return host.lower().endswith(".ts.net") and all(c.isalnum() or c in ".-" for c in host)


def allowlist(cfg: dict) -> frozenset:
    return ALLOWLISTS[cfg.get("phase", 1)]


# ---- launching the server --------------------------------------------------------------------

def build_ssh_argv(cfg: dict) -> list:
    """ssh argv for the configured Mac. Contains no credential: the proxy helper reads HTTPS_PROXY itself."""
    ssh = cfg["ssh"]
    timeout = int(ssh.get("connect_timeout_seconds", 15))
    argv = [
        "ssh", "-T",
        "-i", os.path.expanduser(ssh["identity_file"]),
        "-o", "BatchMode=yes",            # never prompt (no password, no unknown-host question)
        "-o", "IdentitiesOnly=yes",
        "-o", f"ConnectTimeout={timeout}",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=2",
        "-o", "LogLevel=ERROR",
    ]
    if ssh.get("proxy", "muse") == "muse":
        port = int(ssh.get("proxy_port", 3130))
        proxy_cmd = " ".join(shlex.quote(a) for a in [sys.executable, PROXY_HELPER, "--proxy-port", str(port)]) + " %h %p"
        argv += ["-o", f"ProxyCommand={proxy_cmd}"]
    argv.append(f'{ssh["user"]}@{ssh["host"]}')
    # ssh joins the remote command into one string for the Mac's shell: quote each part
    argv.append(" ".join(shlex.quote(a) for a in cfg["server_command"]))
    return argv


def launch_argv(cfg: dict) -> list:
    if cfg.get("transport", "ssh") == "local":
        return list(cfg["server_command"])
    ssh = cfg["ssh"]
    if ssh.get("proxy", "muse") == "muse" and not (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")):
        raise ConnectorError("HTTPS_PROXY is not set: the Muse Tailscale proxy is the only route to the Mac, so nothing was attempted", EXIT_TRANSPORT)
    if not shutil.which("ssh"):
        raise ConnectorError("the ssh program was not found on this machine", EXIT_TRANSPORT)
    if not os.path.exists(os.path.expanduser(ssh["identity_file"])):
        raise ConnectorError(f'SSH key not found: {ssh["identity_file"]}', EXIT_CONFIG)
    return build_ssh_argv(cfg)


# ---- MCP over stdio --------------------------------------------------------------------------

class Session:
    """One server process, newline-delimited JSON-RPC on its stdin/stdout."""

    def __init__(self, argv: list, label: str):
        self.label = label
        self.next_id = 1
        self.messages: "queue.Queue[object]" = queue.Queue()
        self.stderr_tail: list = []
        try:
            self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        except OSError as e:
            raise ConnectorError(f"could not start {label}: {e}", EXIT_TRANSPORT)
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self):
        for raw in iter(self.proc.stdout.readline, b""):
            line = raw.strip()
            if not line:
                continue
            try:
                self.messages.put(json.loads(line.decode("utf-8")))
            except ValueError:
                continue  # not JSON-RPC (stray output); ignore
        self.messages.put(EOFError())

    def _read_stderr(self):
        for raw in iter(self.proc.stderr.readline, b""):
            text = raw.decode("utf-8", "replace").rstrip()
            if text:
                self.stderr_tail.append(text[:300])
                del self.stderr_tail[:-8]

    def _send(self, msg: dict):
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            raise self._dead("the connection closed while sending")

    def _dead(self, what: str) -> ConnectorError:
        time.sleep(0.2)  # let stderr arrive
        detail = " | ".join(self.stderr_tail[-3:])
        return ConnectorError(f"{what} ({self.label}){': ' + detail if detail else ''}", EXIT_TRANSPORT)

    def notify(self, method: str, params: dict | None = None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self._send(msg)

    def request(self, method: str, params: dict, timeout: float) -> dict:
        rid = self.next_id
        self.next_id += 1
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ConnectorError(f"no answer to {method} within {int(timeout)} s ({self.label})", EXIT_TRANSPORT)
            try:
                msg = self.messages.get(timeout=left)
            except queue.Empty:
                continue
            if isinstance(msg, EOFError):
                raise self._dead(f"the server closed the connection before answering {method}")
            if not isinstance(msg, dict):
                continue
            if "method" in msg and "id" in msg:  # a request from the server: we offer no client features
                reply = {"jsonrpc": "2.0", "id": msg["id"]}
                if msg["method"] == "ping":
                    reply["result"] = {}
                else:
                    reply["error"] = {"code": -32601, "message": "not supported by this client"}
                self._send(reply)
                continue
            if msg.get("id") != rid:
                continue  # a notification, or a stray response
            if "error" in msg:
                err = msg["error"] if isinstance(msg["error"], dict) else {"message": str(msg["error"])}
                raise ConnectorError(json.dumps({"jsonrpc_error": err, "method": method}), EXIT_RPC_ERROR)
            return msg.get("result") or {}

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def open_session(cfg: dict) -> tuple:
    argv = launch_argv(cfg)
    label = "local server" if cfg.get("transport", "ssh") == "local" else f'ssh {cfg["ssh"]["user"]}@{cfg["ssh"]["host"]}'
    s = Session(argv, label)
    timeouts = cfg.get("timeouts", {})
    try:
        init = s.request("initialize", {
            "protocolVersion": PROTOCOL_VERSIONS[0],
            "capabilities": {},
            "clientInfo": {"name": "custom.mnemo", "version": "1.0.0"},
        }, float(timeouts.get("initialize_seconds", 45)))
        version = init.get("protocolVersion")
        if version not in PROTOCOL_VERSIONS:
            raise ConnectorError(f"server offered protocol {version!r}; this client speaks {', '.join(PROTOCOL_VERSIONS)}", EXIT_TRANSPORT)
        s.notify("notifications/initialized")
        return s, init
    except Exception:
        s.close()
        raise


# ---- commands --------------------------------------------------------------------------------

def cmd_list_tools(cfg: dict) -> int:
    s, init = open_session(cfg)
    try:
        tools, cursor, pages = [], None, 0
        while True:
            params = {"cursor": cursor} if cursor else {}
            page = s.request("tools/list", params, float(cfg.get("timeouts", {}).get("call_seconds", 120)))
            tools.extend(page.get("tools") or [])
            cursor = page.get("nextCursor")
            pages += 1
            if not cursor:
                break
            if pages >= MAX_PAGES:
                raise ConnectorError("tools/list did not finish paginating", EXIT_TRANSPORT)
    finally:
        s.close()
    allowed = allowlist(cfg)
    out = {
        "protocolVersion": init.get("protocolVersion"),
        "server": init.get("serverInfo"),
        "phase": cfg.get("phase", 1),
        "count": len(tools),
        "tools": [dict(t, allowed=(t.get("name") in allowed)) for t in tools],
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return EXIT_OK


def read_arguments(path: str) -> dict:
    try:
        if os.path.getsize(path) > MAX_ARGUMENTS_BYTES:
            raise ConnectorError("arguments file is larger than 16 MB", EXIT_USAGE)
        with open(path, "r", encoding="utf-8") as f:
            args = json.load(f)
    except FileNotFoundError:
        raise ConnectorError(f"arguments file not found: {path}", EXIT_USAGE)
    except ValueError as e:
        raise ConnectorError(f"arguments file is not valid JSON: {e}", EXIT_USAGE)
    if not isinstance(args, dict):
        raise ConnectorError("arguments file must hold a JSON object", EXIT_USAGE)
    return args


def cmd_call_tool(cfg: dict, name: str, arguments_file: str) -> int:
    allowed = allowlist(cfg)
    if name not in allowed:  # checked before anything is launched
        raise ConnectorError(json.dumps({"refused": name, "phase": cfg.get("phase", 1), "reason": "tool is not in the active allowlist", "allowed": sorted(allowed)}), EXIT_REFUSED)
    arguments = read_arguments(arguments_file)
    s, _ = open_session(cfg)
    try:  # exactly one call; never retried
        result = s.request("tools/call", {"name": name, "arguments": arguments}, float(cfg.get("timeouts", {}).get("call_seconds", 120)))
    finally:
        s.close()
    is_error = bool(result.get("isError"))
    print(json.dumps({"tool": name, "isError": is_error, "result": result}, indent=2, ensure_ascii=False))
    return EXIT_TOOL_ERROR if is_error else EXIT_OK


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{self.prog}: error: {message}\n")
        sys.exit(EXIT_USAGE)


def main(argv=None) -> int:
    p = Parser(prog="client.py", description="custom.mnemo: MCP client for the Mnemo vault (read-only by default)")
    p.add_argument("--config", default=os.environ.get("CUSTOM_MNEMO_CONFIG", DEFAULT_CONFIG), help="config file (default: config.json next to bin/)")
    sub = p.add_subparsers(dest="command", parser_class=Parser)
    sub.add_parser("list-tools", help="list the server's tools (each marked allowed or not)")
    call = sub.add_parser("call-tool", help="call one allowed tool")
    call.add_argument("--name", required=True)
    call.add_argument("--arguments-file", required=True)
    a = p.parse_args(argv)
    if a.command is None:
        p.error("a command is required: list-tools or call-tool")
    try:
        cfg = load_config(a.config)
        if a.command == "list-tools":
            return cmd_list_tools(cfg)
        return cmd_call_tool(cfg, a.name, a.arguments_file)
    except ConnectorError as e:
        sys.stderr.write(f"custom.mnemo: {e}\n")
        return e.code
    except KeyboardInterrupt:
        return EXIT_TRANSPORT


if __name__ == "__main__":
    sys.exit(main())
