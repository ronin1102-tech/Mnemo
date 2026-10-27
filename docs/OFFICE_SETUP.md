# Mnemo for the office: one vault, many machines (over Tailscale)

One Mac holds the vault and runs the **hub**. Every other machine on your tailnet joins it:
**agents** through MCP (search, read, propose), **people** through the Helix in a browser (see, review, approve).
Office machines install nothing from this repo: an agent needs only an MCP client, a person only a browser.

```
 office machine (agent) ──MCP over HTTP──┐                       ┌── vault (plain .md files)
 office machine (person) ──browser──────┼──► Tailscale ──► Mac: mnemo-ctl hub ─┤
 this Mac (you) ─────────── browser ────┘                       └── .mnemo/ (index, proposals, keys)
```

**What does not change:** agents can only *propose*. Nothing lands until a person approves it in the Helix or with `mnemo-ctl approve`, and stale proposals still halt.

## Security model (read once)
| Guard | What it means |
|---|---|
| Listens only on loopback + your Tailscale address | `--bind` refuses `0.0.0.0`, Wi-Fi/LAN and public addresses. Only tailnet devices can reach it, over Tailscale's encrypted tunnel. |
| One key per machine or person | `mnemo-ctl token add <name> --agent` or `--person`. Shown once; only a hash is stored (`.mnemo/tokens.json`, mode 600). Revoke any time; takes effect on the next request. |
| Agent keys can't approve | An agent key works only on `/mcp`. It is refused by the approval API, so an agent can never approve its own proposal. |
| Person keys can't use MCP | A person key works only on the Helix. |
| Read-only keys | `--read-only` on `token add`: an agent gets no write tools; a person can look but not approve or write. |
| Person keys write | A person key that isn't read-only can also write notes and requests in the Helix (Read tab), directly like on the Mac, logged as `person:<name>`. Give full person keys only to people you'd let edit your vault; use `--person --read-only` for everyone else. |
| Audit | Every proposal records the key name (`office-thinkcentre (claude-code)`); every settlement records who (`helix (tracy)`, or `mnemo-ctl (<user>)`). `mnemo-ctl show <id>`. |
| Host / Origin checks | Requests must be addressed to this Mac's own names (defeats DNS rebinding); cross-origin calls are refused. |
| Recommended | In the Tailscale admin console, add an ACL so only the office machines can reach the Mac on the hub port. |

## On the Mac (the hub)
Your Mac's tailnet address: **`100.103.16.78`**, MagicDNS name **`onemoreizzysmbp.tail81e3a6.ts.net`** (Tailscale app → this machine).

```
cd Mnemo-main
# 1. one key per machine and per person (each key prints once: copy it to that machine)
node packages/mnemo-mcp/dist/ctl.js --vault ~/Vault token add office-thinkcentre --agent
node packages/mnemo-mcp/dist/ctl.js --vault ~/Vault token add tracy --person
node packages/mnemo-mcp/dist/ctl.js --vault ~/Vault token list

# 2. start the hub on the tailnet
node packages/mnemo-mcp/dist/ctl.js --vault ~/Vault hub --bind 100.103.16.78 --allow-host onemoreizzysmbp.tail81e3a6.ts.net
```
It prints the addresses to use and opens the Helix on this Mac. Leave the Terminal window open (Ctrl+C stops it).
`--port 7337` is the default; `--read-only` starts a hub where nobody can approve.

**If `--bind` fails** ("this computer doesn't have that address"): Tailscale isn't connected, or its address changed; check the Tailscale app. Alternative that avoids binding at all: run the hub without `--bind`, and let Tailscale forward to it with `tailscale serve` (see Tailscale's docs for your version), keeping `--allow-host onemoreizzysmbp.tail81e3a6.ts.net`.

### Make it a double-click app, and start it at login (recommended for the office)
```
node packages/mnemo-mcp/dist/ctl.js --vault ~/Vault launcher --hub --bind 100.103.16.78 --allow-host onemoreizzysmbp.tail81e3a6.ts.net --at-login
```
- **Mnemo.app** (in your home folder's Applications): double-click to open the Helix; it starts the hub in the background if it isn't running. No Terminal window to keep open.
- **--at-login**: the hub also starts whenever you log in, and macOS restarts it if it stops unexpectedly (for example if it started before Tailscale connected; it retries every 15 s). Log: `.mnemo/logs/login.log` in the vault.
- Stop it: `... --vault ~/Vault stop`. Remove the app and the login entry: `... launcher --remove`.
- The Mac still needs to be awake and logged in for office machines to reach it.

## On an office machine: an agent
Point any MCP client that supports HTTP ("Streamable HTTP") transport at:
```
URL:     http://onemoreizzysmbp.tail81e3a6.ts.net:7337/mcp      (or http://100.103.16.78:7337/mcp)
Header:  Authorization: Bearer <that machine's agent key>
```
Examples (check your client's docs for the exact flag names):
- Claude Code: `claude mcp add --transport http mnemo http://onemoreizzysmbp.tail81e3a6.ts.net:7337/mcp --header "Authorization: Bearer <key>"`
- A client that only speaks stdio: run a local stdio-to-HTTP proxy such as `mcp-remote`, passing the URL and the same header (it may need an "allow plain http" option, since Tailscale already encrypts the link).

The agent then has the same tools as on the Mac: `search_notes`, `read_note`, `get_neighbors`, `find_similar`, `write_note` / `append_note` / … (proposals only).

## On an office machine: a person
Open in any modern browser on the tailnet:
```
http://onemoreizzysmbp.tail81e3a6.ts.net:7337/#token=<that person's key>
```
The header shows **signed in as <name>**. Notes with a pending proposal pulse gold; **◆ proposals** lists them; **Review changes** shows the exact diff; **Approve** / **Reject** settle it, recorded under that person's name. With a full (not read-only) person key, the **Read** tab's **+ Note**, **+ Request** and **Edit** work too, logged under that name. The key is removed from the address bar on load. You can also open the bare address (a bookmark, a typed address, a new tab): the page shows **"This vault is locked. Enter your key."**. Paste the key (or the whole link) and press **Unlock**. A wrong key gets a plain error and another try; nothing is stored until it works.

By default the key is held for that browser tab only. Tick **Remember this device** to keep it across browser restarts; leave it off on a shared computer. **Lock** (top bar) forgets the key on that device. Browsers keep keys per address, so the tailnet IP and the MagicDNS name each ask once: bookmark the MagicDNS name and use it every time. If a key is revoked while the page is open, the entry screen appears (anything you were typing stays on the page).

## Day to day
| Task | Command (on the Mac) |
|---|---|
| Add a machine or person | `token add <name> --agent` / `--person` (then copy the key over) |
| Remove one | `token revoke <name>` (immediate) |
| See who proposed and who approved | `list`, then `show <id>` |
| Approve from the Mac's terminal | `approve <id>` (same as the Helix button) |

## Verified so far
In this repo's tests and an end-to-end rehearsal (Chromium, Node 20, the Mac's MagicDNS name mapped locally): an agent key proposed over MCP and was recorded by name; a person key opened the Helix by the tailnet name, reviewed the diff and approved; the note landed byte-for-byte; agent keys were refused by the approval API; revoked, wrong, missing and cross-kind keys were refused; foreign Host names and `0.0.0.0` were refused; oversized requests got a clean 413 and the hub kept serving.
**Not yet verified:** a real second machine on your tailnet, and binding to the Tailscale address on Catalina. Those are the first things to try.
