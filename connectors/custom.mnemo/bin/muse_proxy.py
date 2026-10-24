#!/usr/bin/env python3
"""SSH ProxyCommand: tunnel to a tailnet host through the Muse Tailscale proxy (HTTP CONNECT).

    ProxyCommand=python3 muse_proxy.py --proxy-port 3130 %h %p

The proxy's host and credential are read from HTTPS_PROXY (or https_proxy) at runtime; the port
is replaced with --proxy-port. The credential is only ever placed in the Proxy-Authorization
header of the CONNECT request: it is never printed, logged, written to disk, or put in argv.
Standard library only.
"""
from __future__ import annotations

import base64
import os
import socket
import sys
import threading
from urllib.parse import unquote, urlsplit

MAX_HEADER = 16 * 1024


def fail(msg: str) -> "None":
    sys.stderr.write(f"muse_proxy: {msg}\n")
    sys.exit(1)


def parse_args(argv):
    port, rest, i = 3130, [], 0
    while i < len(argv):
        if argv[i] == "--proxy-port":
            port = int(argv[i + 1])
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    if len(rest) != 2:
        fail("usage: muse_proxy.py [--proxy-port N] <host> <port>")
    return port, rest[0], int(rest[1])


def main(argv=None):
    proxy_port, host, port = parse_args(sys.argv[1:] if argv is None else argv)
    env = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if not env:
        fail("HTTPS_PROXY is not set; refusing to connect any other way")
    u = urlsplit(env if "://" in env else "http://" + env)
    if not u.hostname:
        fail("HTTPS_PROXY has no host")
    target = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}"]
    if u.username is not None:
        token = base64.b64encode(f"{unquote(u.username)}:{unquote(u.password or '')}".encode("utf-8")).decode("ascii")
        lines.append(f"Proxy-Authorization: Basic {token}")
    request = ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8")
    proxy_host = u.hostname
    del env, u  # nothing below needs the credential

    try:
        sock = socket.create_connection((proxy_host, proxy_port), timeout=15)
    except OSError as e:
        fail(f"cannot reach the Muse proxy on port {proxy_port}: {e.strerror or e}")
    sock.sendall(request)
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(4096)
        if not chunk:
            fail("the proxy closed the connection during CONNECT")
        head += chunk
        if len(head) > MAX_HEADER:
            fail("the proxy's reply was too long")
    header, _, extra = head.partition(b"\r\n\r\n")
    status = header.split(b"\r\n", 1)[0].decode("latin-1")
    parts = status.split(" ", 2)
    if len(parts) < 2 or parts[1] != "200":
        fail(f"the proxy refused the tunnel to {target}: {status}")
    sock.settimeout(None)

    out = sys.stdout.buffer
    if extra:
        out.write(extra)
        out.flush()

    def upstream():
        try:
            while True:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                sock.sendall(data)
        except OSError:
            pass
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=upstream, daemon=True).start()
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            out.write(data)
            out.flush()
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
