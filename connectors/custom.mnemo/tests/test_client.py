#!/usr/bin/env python3
"""Tests for custom.mnemo. Standard library only:   python3 -m unittest discover -s tests -v

The "real server" tests launch the actual Mnemo MCP server locally (the same server command, on a
fixture vault holding hello.md and this-is-the-beginning.md). They need two env vars, otherwise
they are skipped:
    MNEMO_NODE=/path/to/node20   MNEMO_CLI=/path/to/Mnemo-main/packages/mnemo-mcp/dist/cli.js
Set MNEMO_VAULT to run them against an existing vault instead of the fixture (read-only calls)."""
import base64, json, os, socket, subprocess, sys, tempfile, threading, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CLIENT = os.path.join(ROOT, "bin", "client.py")
PROXY = os.path.join(ROOT, "bin", "muse_proxy.py")
FAKE = os.path.join(HERE, "fake_mcp_server.py")
sys.path.insert(0, os.path.join(ROOT, "bin"))
import client  # noqa: E402


def lines(path):
    with open(path) as f:
        return f.read().splitlines()


def write_json(obj):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f)
    return path


def run(config, *args, env=None):
    cfg = write_json(config)
    e = dict(os.environ)
    e.update(env or {})
    p = subprocess.run([sys.executable, CLIENT, "--config", cfg, *args], capture_output=True, text=True, env=e, timeout=90)
    return p.returncode, p.stdout, p.stderr


def fake_config(phase=1):
    return {"phase": phase, "transport": "local", "server_command": [sys.executable, FAKE]}


class Allowlist(unittest.TestCase):
    def test_phase1_refuses_a_write_tool_before_launching_anything(self):
        log = tempfile.mktemp()
        code, out, err = run(fake_config(1), "call-tool", "--name", "write_note", "--arguments-file", write_json({"path": "x.md", "content": "y"}), env={"FAKE_LOG": log})
        self.assertEqual(code, client.EXIT_REFUSED)
        self.assertIn('"refused": "write_note"', err)
        self.assertFalse(os.path.exists(log), "the server must not even be started for a refused tool")

    def test_phase1_allows_daily_note(self):
        code, out, err = run(fake_config(1), "call-tool", "--name", "daily_note", "--arguments-file", write_json({}))
        self.assertEqual(code, client.EXIT_OK, err)
        self.assertEqual(json.loads(out)["tool"], "daily_note")

    def test_allowlists_are_exactly_the_build_packet(self):
        reads = {"search_notes", "read_note", "list_recent", "list_notes", "get_backlinks", "get_neighbors", "find_similar", "get_tags", "list_proposals", "daily_note", "list_requests"}
        writes = {"write_note", "append_note", "patch_note", "move_note", "delete_note"}
        self.assertEqual(set(client.PHASE_1), reads)
        self.assertEqual(set(client.PHASE_2), reads | writes)

    def test_phase1_refuses_unknown_tools(self):
        for name in ["future_tool", "approve", "approve_proposal", ""]:
            code, _, _ = run(fake_config(1), "call-tool", "--name", name, "--arguments-file", write_json({}))
            self.assertEqual(code, client.EXIT_REFUSED, name)

    def test_phase2_allows_writes_but_still_refuses_unknown_tools(self):
        code, out, _ = run(fake_config(2), "call-tool", "--name", "write_note", "--arguments-file", write_json({"path": "x.md", "content": "y"}))
        self.assertEqual(code, client.EXIT_OK)
        self.assertEqual(json.loads(out)["tool"], "write_note")
        code, _, _ = run(fake_config(2), "call-tool", "--name", "future_tool", "--arguments-file", write_json({}))
        self.assertEqual(code, client.EXIT_REFUSED)

    def test_phase_must_be_exactly_1_or_2(self):
        for bad in [0, 3, "2", True, None]:
            cfg = fake_config(1)
            cfg["phase"] = bad
            code, _, err = run(cfg, "list-tools")
            self.assertEqual(code, client.EXIT_CONFIG, repr(bad))


class Protocol(unittest.TestCase):
    def test_handshake_initialized_and_full_pagination(self):
        log = tempfile.mktemp()
        code, out, _ = run(fake_config(), "list-tools", env={"FAKE_PAGES": "3", "FAKE_LOG": log})
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["count"], 6)
        self.assertEqual(data["protocolVersion"], "2025-11-25")
        allowed = {t["name"]: t["allowed"] for t in data["tools"]}
        self.assertEqual(allowed, {"search_notes": True, "read_note": True, "write_note": False, "delete_note": False, "future_tool": False, "list_notes": True})
        sent = [json.loads(l) for l in lines(log)]
        methods = [m.get("method") for m in sent]
        self.assertEqual(methods[:2], ["initialize", "notifications/initialized"])
        self.assertEqual(methods.count("tools/list"), 3)
        self.assertEqual(sent[0]["params"]["protocolVersion"], "2025-11-25")

    def test_accepts_the_older_supported_versions_and_refuses_others(self):
        for v in ["2025-06-18", "2025-03-26"]:
            self.assertEqual(run(fake_config(), "list-tools", env={"FAKE_PROTOCOL": v})[0], 0, v)
        code, _, err = run(fake_config(), "list-tools", env={"FAKE_PROTOCOL": "2024-11-05"})
        self.assertEqual(code, client.EXIT_TRANSPORT)
        self.assertIn("2024-11-05", err)

    def test_answers_server_ping_mid_call(self):
        log = tempfile.mktemp()
        code, _, _ = run(fake_config(), "call-tool", "--name", "search_notes", "--arguments-file", write_json({"query": "x"}), env={"FAKE_PING": "1", "FAKE_LOG": log})
        self.assertEqual(code, 0)
        replies = [json.loads(l) for l in lines(log) if '"srv-1"' in l]
        self.assertEqual(replies[0], {"jsonrpc": "2.0", "id": "srv-1", "result": {}})

    def test_iserror_exits_1_and_rpc_error_exits_2_and_neither_retries(self):
        for env, want in [({"FAKE_IS_ERROR": "1"}, client.EXIT_TOOL_ERROR), ({"FAKE_RPC_ERROR": "1"}, client.EXIT_RPC_ERROR)]:
            log = tempfile.mktemp()
            code, _, _ = run(fake_config(), "call-tool", "--name", "read_note", "--arguments-file", write_json({"path": "a.md"}), env=dict(env, FAKE_LOG=log))
            self.assertEqual(code, want)
            calls = [l for l in lines(log) if '"tools/call"' in l]
            self.assertEqual(len(calls), 1, "a failed call must not be retried")

    def test_server_dying_is_a_clean_transport_failure(self):
        code, _, err = run(fake_config(), "list-tools", env={"FAKE_EXIT_ON_INIT": "1"})
        self.assertEqual(code, client.EXIT_TRANSPORT)
        self.assertIn("closed the connection", err)
        self.assertIn("fake: going away", err)

    def test_bad_arguments_file(self):
        self.assertEqual(run(fake_config(), "call-tool", "--name", "read_note", "--arguments-file", "/nonexistent.json")[0], client.EXIT_USAGE)
        self.assertEqual(run(fake_config(), "call-tool", "--name", "read_note", "--arguments-file", write_json([1, 2]))[0], client.EXIT_USAGE)
        self.assertEqual(run(fake_config(), "call-tool", "--name", "read_note")[0], client.EXIT_USAGE)


class SshRoute(unittest.TestCase):
    CFG = json.load(open(os.path.join(ROOT, "config.json")))

    def test_shipped_config_is_phase_1_and_valid(self):
        cfg = client.load_config(os.path.join(ROOT, "config.json"))
        self.assertEqual(cfg["phase"], 1)
        self.assertEqual(cfg["ssh"]["host"], "100.103.16.78")

    def test_ssh_argv_is_batch_mode_via_the_proxy_helper_and_carries_no_credential(self):
        secret = "s3cr3t-proxy-pass"
        os.environ["HTTPS_PROXY"] = f"http://muse-user:{secret}@proxy.internal:8080"
        try:
            argv = client.build_ssh_argv(self.CFG)
        finally:
            del os.environ["HTTPS_PROXY"]
        joined = " ".join(argv)
        self.assertNotIn(secret, joined)
        self.assertNotIn("muse-user", joined)
        self.assertIn("BatchMode=yes", argv)
        self.assertTrue(any(a.startswith("ProxyCommand=") and "muse_proxy.py" in a and "--proxy-port 3130" in a and a.endswith("%h %p") for a in argv))
        self.assertEqual(argv[-2], "onemoretimetrizzy@100.103.16.78")
        self.assertEqual(argv[-1], "/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin/node /Users/onemoretimetrizzy/Mnemo-main/packages/mnemo-mcp/dist/cli.js --vault /Users/onemoretimetrizzy/Mnemo-Vault serve")

    def test_remote_command_is_shell_quoted(self):
        cfg = json.loads(json.dumps(self.CFG))
        cfg["server_command"] = ["/opt/node", "/a b/cli.js", "--vault", "/it's here", "serve"]
        self.assertEqual(client.build_ssh_argv(cfg)[-1], "/opt/node '/a b/cli.js' --vault '/it'\"'\"'s here' serve")

    def test_no_proxy_env_means_nothing_is_attempted(self):
        env = {k: "" for k in ("HTTPS_PROXY", "https_proxy")}
        code, _, err = run(self.CFG, "list-tools", env=env)
        self.assertEqual(code, client.EXIT_TRANSPORT)
        self.assertIn("HTTPS_PROXY is not set", err)

    def test_only_tailnet_hosts_are_accepted(self):
        for host in ["8.8.8.8", "192.168.1.5", "example.com", "100.128.0.1", "evil.ts.net.example.com", "OneMoreizzysMBP.lan"]:
            cfg = json.loads(json.dumps(self.CFG))
            cfg["ssh"]["host"] = host
            self.assertEqual(run(cfg, "list-tools")[0], client.EXIT_CONFIG, host)
        for host in ["100.103.16.78", "onemoreizzysmbp.tail81e3a6.ts.net", "fd7a:115c:a1e0::ab01:10ca"]:
            self.assertTrue(client.is_tailnet_host(host), host)

    def test_server_command_must_be_absolute(self):
        cfg = json.loads(json.dumps(self.CFG))
        cfg["server_command"][0] = "node"
        self.assertEqual(run(cfg, "list-tools")[0], client.EXIT_CONFIG)


class MuseProxyHelper(unittest.TestCase):
    """Fake CONNECT proxy -> echo server, to check the tunnel, the auth header and secrecy."""

    def start(self, reply=b"HTTP/1.1 200 Connection established\r\n\r\n"):
        self.seen = {}
        echo = socket.socket()
        echo.bind(("127.0.0.1", 0))
        echo.listen(1)
        self.echo_port = echo.getsockname()[1]

        def echo_loop():
            c, _ = echo.accept()
            while True:
                d = c.recv(4096)
                if not d:
                    break
                c.sendall(d)
            c.close()

        proxy = socket.socket()
        proxy.bind(("127.0.0.1", 0))
        proxy.listen(1)
        self.proxy_port = proxy.getsockname()[1]

        def proxy_loop():
            c, _ = proxy.accept()
            head = b""
            while b"\r\n\r\n" not in head:
                head += c.recv(4096)
            self.seen["head"] = head.decode()
            c.sendall(reply)
            if not reply.startswith(b"HTTP/1.1 200"):
                c.close()
                return
            up = socket.create_connection(("127.0.0.1", self.echo_port))

            def pump(a, b):
                while True:
                    d = a.recv(4096)
                    if not d:
                        break
                    b.sendall(d)
                try:
                    b.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

            threading.Thread(target=pump, args=(up, c), daemon=True).start()
            pump(c, up)

        threading.Thread(target=echo_loop, daemon=True).start()
        threading.Thread(target=proxy_loop, daemon=True).start()

    def helper(self, data, env_proxy):
        env = dict(os.environ, HTTPS_PROXY=env_proxy)
        return subprocess.run([sys.executable, PROXY, "--proxy-port", str(self.proxy_port), "100.103.16.78", "22"], input=data, capture_output=True, env=env, timeout=30)

    def test_tunnels_with_basic_auth_built_at_runtime(self):
        self.start()
        p = self.helper(b"SSH-2.0-test\r\nhello", "http://muse%40user:p%3Ass@127.0.0.1:9")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, b"SSH-2.0-test\r\nhello")
        head = self.seen["head"]
        self.assertTrue(head.startswith("CONNECT 100.103.16.78:22 HTTP/1.1\r\n"))
        token = base64.b64encode(b"muse@user:p:ss").decode()
        self.assertIn(f"Proxy-Authorization: Basic {token}\r\n", head)

    def test_refusal_reports_the_status_but_never_the_credential(self):
        self.start(reply=b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
        p = self.helper(b"x", "http://muse:topsecret@127.0.0.1:9")
        self.assertEqual(p.returncode, 1)
        msg = p.stderr.decode()
        self.assertIn("407", msg)
        self.assertNotIn("topsecret", msg)
        self.assertNotIn("muse:", msg)

    def test_unreachable_proxy_and_missing_env_fail_clean(self):
        free = socket.socket()
        free.bind(("127.0.0.1", 0))
        port = free.getsockname()[1]
        free.close()
        env = dict(os.environ, HTTPS_PROXY="http://u:secretpw@127.0.0.1:9")
        p = subprocess.run([sys.executable, PROXY, "--proxy-port", str(port), "100.103.16.78", "22"], capture_output=True, env=env, timeout=30)
        self.assertEqual(p.returncode, 1)
        self.assertIn(b"cannot reach the Muse proxy", p.stderr)
        self.assertNotIn(b"secretpw", p.stderr)
        env = {k: v for k, v in os.environ.items() if k.lower() != "https_proxy"}
        p = subprocess.run([sys.executable, PROXY, "100.103.16.78", "22"], capture_output=True, env=env, timeout=30)
        self.assertEqual(p.returncode, 1)
        self.assertIn(b"HTTPS_PROXY is not set", p.stderr)


@unittest.skipUnless(os.environ.get("MNEMO_NODE") and os.environ.get("MNEMO_CLI"), "set MNEMO_NODE and MNEMO_CLI to test against the real Mnemo server")
class RealMnemoServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vault = os.environ.get("MNEMO_VAULT")
        if not cls.vault:
            cls.vault = tempfile.mkdtemp()
            with open(os.path.join(cls.vault, "hello.md"), "w") as f:
                f.write("# Hello\nMnemo is connected.\n")
            with open(os.path.join(cls.vault, "this-is-the-beginning.md"), "w") as f:
                f.write("# This is the beginning\nThe first note in the vault.\n")
        cls.cfg = {"phase": 1, "transport": "local", "server_command": [os.environ["MNEMO_NODE"], os.environ["MNEMO_CLI"], "--vault", cls.vault, "serve"]}

    def test_list_tools_returns_the_full_tool_list(self):
        code, out, err = run(self.cfg, "list-tools")
        self.assertEqual(code, 0, err)
        data = json.loads(out)
        names = sorted(t["name"] for t in data["tools"])
        self.assertEqual(data["count"], 16)
        self.assertEqual(names, sorted(client.PHASE_2))  # exactly the 16 tools the two phases cover
        self.assertEqual(data["protocolVersion"], "2025-11-25")
        self.assertEqual(sorted(t["name"] for t in data["tools"] if t["allowed"]), sorted(client.PHASE_1))

    def test_read_note_hello(self):
        code, out, err = run(self.cfg, "call-tool", "--name", "read_note", "--arguments-file", write_json({"path": "hello.md"}))
        self.assertEqual(code, 0, err)
        content = json.loads(json.loads(out)["result"]["content"][0]["text"])["content"]
        self.assertIn("Hello", content)

    def test_search_finds_beginning(self):
        code, out, err = run(self.cfg, "call-tool", "--name", "search_notes", "--arguments-file", write_json({"query": "Beginning"}))
        self.assertEqual(code, 0, err)
        hits = json.loads(json.loads(out)["result"]["content"][0]["text"])
        self.assertIn("this-is-the-beginning.md", [h["path"] for h in hits])

    def test_daily_note_is_a_phase1_read(self):
        code, out, err = run(self.cfg, "call-tool", "--name", "daily_note", "--arguments-file", write_json({"date": "2026-10-24"}))
        self.assertEqual(code, 0, err)
        data = json.loads(json.loads(out)["result"]["content"][0]["text"])
        self.assertEqual(set(data), {"path", "exists", "content"})

    def test_missing_note_is_iserror_exit_1(self):
        code, out, _ = run(self.cfg, "call-tool", "--name", "read_note", "--arguments-file", write_json({"path": "no-such-note.md"}))
        self.assertEqual(code, client.EXIT_TOOL_ERROR)
        self.assertTrue(json.loads(out)["isError"])

    def test_phase2_tool_refused_under_phase1(self):
        code, _, err = run(self.cfg, "call-tool", "--name", "append_note", "--arguments-file", write_json({"path": "hello.md", "content": "x"}))
        self.assertEqual(code, client.EXIT_REFUSED)
        self.assertIn('"refused": "append_note"', err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
