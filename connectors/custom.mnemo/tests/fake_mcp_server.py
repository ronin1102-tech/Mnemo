#!/usr/bin/env python3
"""A scriptable stdio MCP server for testing client.py. Behaviour comes from env vars:
FAKE_LOG (file: every message received, one JSON per line), FAKE_PROTOCOL (version to offer),
FAKE_PAGES (split 6 tools over N pages), FAKE_PING (send the client a ping before answering
tools/call), FAKE_RPC_ERROR (answer tools/call with a JSON-RPC error), FAKE_IS_ERROR (tool result
isError), FAKE_EXIT_ON_INIT (die without answering)."""
import json, os, sys

log = os.environ.get("FAKE_LOG")
tools = [{"name": n, "description": f"fake {n}", "inputSchema": {"type": "object"}} for n in
         ["search_notes", "read_note", "write_note", "delete_note", "future_tool", "list_notes"]]


def send(m):
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    msg = json.loads(line)
    if log:
        with open(log, "a") as f:
            f.write(json.dumps(msg) + "\n")
    m, mid = msg.get("method"), msg.get("id")
    if m == "initialize":
        if os.environ.get("FAKE_EXIT_ON_INIT"):
            sys.stderr.write("fake: going away\n")
            sys.exit(3)
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": os.environ.get("FAKE_PROTOCOL", msg["params"]["protocolVersion"]), "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "0"}}})
    elif m == "tools/list":
        pages = int(os.environ.get("FAKE_PAGES", "1"))
        per = -(-len(tools) // pages)
        start = int((msg.get("params") or {}).get("cursor") or 0)
        result = {"tools": tools[start:start + per]}
        if start + per < len(tools):
            result["nextCursor"] = str(start + per)
        send({"jsonrpc": "2.0", "id": mid, "result": result})
    elif m == "tools/call":
        if os.environ.get("FAKE_PING"):
            send({"jsonrpc": "2.0", "id": "srv-1", "method": "ping"})
            reply = json.loads(sys.stdin.readline())
            if log:
                with open(log, "a") as f:
                    f.write(json.dumps(reply) + "\n")
        if os.environ.get("FAKE_RPC_ERROR"):
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "bad params"}})
        else:
            send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": json.dumps(msg["params"])}], "isError": bool(os.environ.get("FAKE_IS_ERROR"))}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "nope"}})
