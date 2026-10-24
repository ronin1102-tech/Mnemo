# custom.mnemo — Vesper ↔ Mnemo connector

Connects Vesper (Muse, on the Hatch VM) to Tracy's Mnemo vault as an MCP client, using the same
server command Cori uses. Each command starts a fresh server process on the Mac over SSH, does
one thing, prints JSON, and exits. Cori's process and this one point at the same vault.

```
VM: client.py ──ssh (BatchMode, key login)──► Mac 100.103.16.78 ──► node …/mnemo-mcp/dist/cli.js --vault …/Mnemo-Vault serve
         └─ ProxyCommand: bin/muse_proxy.py → HTTP CONNECT to the Muse Tailscale proxy (HTTPS_PROXY host, port 3130)
```

Only the Python 3 standard library and the system `ssh` are needed.

## Contents

| Path | What it is |
|---|---|
| `bin/client.py` | The MCP client. It has two commands: `list-tools` and `call-tool`. |
| `bin/muse_proxy.py` | The SSH `ProxyCommand` helper. It opens the HTTP CONNECT tunnel through the Muse proxy. |
| `config.json` | Phase, SSH target, server command and timeouts. It holds no credentials. |
| `tests/` | `unittest` suite and a fake MCP server, used for testing only. |

## Setup (on the VM)

1. Copy this folder to `~/workspace/custom-connectors/custom.mnemo/`.
2. Make sure `ssh` and `python3` (3.8 or newer) are on PATH. The VM's key must be at `~/.ssh/id_ed25519`
   (this key is already authorized on the Mac).
3. `HTTPS_PROXY` must be set in the environment, as it already is on the VM. The helper reads it
   only at runtime.
4. Run a smoke test:
   `python3 bin/client.py list-tools`
   You should see 15 tools. The 10 Phase-1 tools show `"allowed": true`.

`config.json` already matches the verified environment, so nothing in it needs editing for
Phase 1. To use a different config file, pass `--config <path>` or set the `CUSTOM_MNEMO_CONFIG` env var.

## Commands

```sh
python3 bin/client.py list-tools
python3 bin/client.py call-tool --name <tool> --arguments-file <path-to-json>
```

- **`list-tools`** runs `initialize` and then `notifications/initialized`. It follows the `tools/list`
  `nextCursor` to the last page and prints:
  `{protocolVersion, server, phase, count, tools: [ {...server tool..., "allowed": bool} ]}`.
- **`call-tool`** checks the allowlist first. A refused tool never launches SSH. The arguments
  file must contain a JSON object. The command makes exactly one `tools/call` and prints
  `{tool, isError, result}`, where `result` is the server's response unchanged.

Examples:

```sh
echo '{"path":"hello.md"}'      > /tmp/a.json && python3 bin/client.py call-tool --name read_note    --arguments-file /tmp/a.json
echo '{"query":"Beginning"}'    > /tmp/s.json && python3 bin/client.py call-tool --name search_notes --arguments-file /tmp/s.json
```

The client offers protocol `2025-11-25` and accepts a server answer of `2025-11-25`, `2025-06-18` or
`2025-03-26`. Any other version is treated as a connection failure (exit 3).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | The tool ran but the result has `isError: true`. The JSON is still printed on stdout. |
| 2 | JSON-RPC error from the server, such as bad params. |
| 3 | Connection or transport failure: proxy, Tailscale, SSH, the Mac, the server dying, a timeout, or an unsupported protocol version. |
| 4 | Refused by the allowlist. Nothing was launched. |
| 5 | Configuration error, such as a bad `phase`, a non-tailnet host, a relative server path or a missing key file. |
| 64 | Usage error, such as a bad arguments or a missing or invalid arguments file. |

Errors go to stderr as a single line prefixed with `custom.mnemo:`. A refusal prints
`{"refused": <tool>, "phase": N, "reason": …, "allowed": [...]}`.

## Allowed operations

The allowlist is enforced in the client before any call. Tools that are not in the active
list are refused, and that includes any tool the server adds in the future.

| Phase | Tools |
|---|---|
| **1 (default, shipped)** | `search_notes`, `read_note`, `list_recent`, `list_notes`, `get_backlinks`, `get_neighbors`, `find_similar`, `get_tags`, `list_proposals`, `daily_note` |
| **2** | All of Phase 1, plus `write_note`, `append_note`, `patch_note`, `move_note`, `delete_note` |

**How to switch to Phase 2:** do this only after Phase-1 QA, and only on Tracy's explicit word.
Change `"phase": 1` to `"phase": 2` in `config.json`. The value must be exactly the number 1 or 2;
anything else is a configuration error. There is no CLI flag or env var that changes the phase.

**Writes are proposals.** Even in Phase 2, every write tool only creates a pending proposal on the
server. A human approves or rejects it in Helix or `mnemo-ctl`. This connector has no approve or
reject tool and no bypass, and none may be added. You can track proposals with
`list_proposals`.

`daily_note` is a Phase-1 read. It is a pure lookup that returns `{path, exists, content}` and
creates nothing; to create a daily note in Phase 2, use `write_note`, which makes a proposal.
This was verified live on the Catalina pass, Oct 24.

## Failure recovery

The client never retries. After a failure, read the reason, fix the cause, and run the command
again yourself.

| Symptom (stderr) | Likely cause | What to do |
|---|---|---|
| `HTTPS_PROXY is not set` | The VM environment is missing the proxy var. | Restore the Muse environment. The client refuses to use any other route. |
| `muse_proxy: cannot reach the Muse proxy …` | The proxy host is down or port 3130 is blocked. | Check the Muse Tailscale proxy. |
| `muse_proxy: proxy refused CONNECT: HTTP/1.1 407 …` / `403` / `502` | The proxy credential was rejected, or the tailnet peer is unreachable. | Check that the Tailscale device "muse" is enrolled and the Mac is online. |
| `ssh … Permission denied (publickey)` | The key is not authorized, or the wrong key was used. | Check `~/.ssh/id_ed25519`. The Mac's `authorized_keys` must contain its public key. |
| `ssh … Connection timed out` / `closed the connection` | The Mac is asleep or offline, or Remote Login is off. | Wake the Mac and check `sudo launchctl list | grep ssh` on the Mac. |
| `Host key verification failed` | First connection, or the Mac's host key changed. | Verify the key out of band, then add it to the VM's `~/.ssh/known_hosts`. |
| `server closed the connection` plus a stderr tail mentioning `node` or `cli.js` | A path in `server_command` is wrong, or Mnemo was moved or rebuilt. | Run the server command on the Mac to check it. Paths must be absolute because a non-interactive SSH shell has no nvm PATH. |
| `timed out waiting for …` | The Mac is slow on the first index of a large vault, or the network is stalling. | Raise `timeouts.initialize_seconds` or `call_seconds` in `config.json`. |
| exit 4 `refused` | The tool is not allowed in this phase. | This is the intended behavior. Do not work around it. |

## Security notes

- **No credentials anywhere.** `config.json`, the docs and the code contain no secret. The proxy
  credential is read from `HTTPS_PROXY` inside `muse_proxy.py` at runtime. It is used only in
  the `Proxy-Authorization` header sent to the proxy. It is never printed, logged, or passed
  as an argument; the SSH `ProxyCommand` line contains only the script path, the port, `%h` and `%p`.
  Proxy errors report only the HTTP status line.
- **No public route.** `ssh.host` must be a Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`
  or `*.ts.net`). Otherwise the client exits 5 without connecting. The Mac's LAN name
  (`OneMoreizzysMBP.lan`) is deliberately not accepted; use the tailnet IP `100.103.16.78`. The client uses no HTTP
  transport, Funnel, Serve or public URL.
- **SSH options:** `BatchMode=yes` (no password prompts), `IdentitiesOnly=yes`, `ConnectTimeout`,
  keepalives, and `LogLevel=ERROR`.
- **Server output is data.** Tool descriptions and results are printed as JSON and never
  interpreted as instructions. The same applies to anything a note contains.
- The client answers server `ping` requests and rejects every other server-initiated request
  (`-32601`).

## Tests

```sh
python3 -m unittest discover -s tests -v
# also against the real Mnemo server, launched locally on a fixture vault:
MNEMO_NODE=/path/to/node20 MNEMO_CLI=/path/to/Mnemo-main/packages/mnemo-mcp/dist/cli.js python3 -m unittest discover -s tests -v
# set MNEMO_VAULT=/Users/onemoretimetrizzy/Mnemo-Vault to run the real-server tests against the real vault (read-only)
```

The suite covers the following:
- the allowlist in both phases, including refusing before launch and refusing unknown tools
- the handshake, protocol negotiation, pagination, ping, `isError` and JSON-RPC errors, and that nothing is retried
- clean transport failures
- the SSH argv shape and shell quoting
- the tailnet-only host check
- `muse_proxy.py` against a fake CONNECT proxy: the tunnel, Basic-auth encoding, and that the credential never appears in errors

It also includes the real-server checks from the task: `list-tools` returns 15 tools, `read_note`
returns `hello.md`, `search_notes` finds "Beginning", and a Phase-2 tool is refused under Phase 1.
