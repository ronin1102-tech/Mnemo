# Vesper: deploy and verify the front-door (key entry) fix

From Claude, via Tracy, Oct 27, 2026. This implements your "Front Door (Key Entry) Fix Brief". It changes only the Helix page (static files): no server, MCP, key-system or proposal-path change. Same rules as `docs/VESPER_OWNER_QA.md`: Mac shell only for these steps, never touch `~/Mnemo-Vault` from the shell, no code changes (flag them), no credentials in files/args/logs, report honestly.

## What changed

- No key, or a 401: the page shows an entry screen, "This vault is locked. Enter your key.", never a blank page. Pasting the whole `...#token=KEY` link also works.
- A wrong key gets a plain error and another try, and is never stored. The right key loads the vault without a reload.
- **Remember this device** is a checkbox, **default OFF**. Off: the key stays in `sessionStorage`, as before. On: also kept in `localStorage`, across restarts.
- `#token=` links work as before, and the fragment is stripped from the address bar immediately.
- A key revoked while the page is open brings the entry screen back (a half-written note stays on the page, and saves after re-entry).
- **Lock** (top bar) forgets the key on that device.
- Invariants, checked in a browser here: the key is never in any request URL or server log, and it goes only to the hub's own origin. Nothing new on the network.
- **Per-address (flag, not improvised):** the IP origin and the MagicDNS origin keep separate storage, so each asks once. The entry screen says so and recommends the MagicDNS name. A cleaner fix would be the hub redirecting the IP address to the MagicDNS name. That changes server behaviour, so it isn't done; Tracy's call.

## Step 1: update the Mac

Same as step 1 of `docs/VESPER_OWNER_QA.md` (stop Mnemo, zip-swap `~/Mnemo-main`, `npm run install:all`, `npm run build`, `npm test`, rollback on failure). Expect **98** (mnemo-mcp) and **52** (helix) passing. Restart the hub the way Tracy runs it. Tracy quits and reopens Cori.

## Step 2: acceptance, on the Mac's own browser (Firefox), with Tracy

Use a fresh private window or profile where "fresh" is asked.

| # | Check | Result |
|---|---|---|
| 1 | Fresh profile, open `http://<MagicDNS name>:7337/` with no `#token`: entry screen, not a blank page | |
| 2a | Type a wrong key: plain error, still on the entry screen | |
| 2b | Paste the right person key (a trailing newline is fine): the vault loads without a reload | |
| 3a | Reload the page: still in | |
| 3b | Quit Firefox, reopen, same address: entry screen again (remember-me was off) | |
| 3c | Unlock with **Remember this device** ticked, quit and reopen Firefox: straight in | |
| 3d | Press **Lock**: entry screen, and a restart no longer gets in | |
| 4 | Open `http://<MagicDNS name>:7337/#token=<key>`: lands in the vault, and the address bar has no `token` afterwards | |
| 5 | Open the same hub by its tailnet IP: it asks for the key once (expected: separate origin) | |

## Step 3: Tracy's phone

Open the hub the way Tracy actually opens it, with both addresses Tracy uses and no link from anyone. Expect the entry screen, a working unlock, and (if Tracy ticks it) straight in next time.

## Report back

PASS/FAIL per row, the last lines of `npm test`, and exact output for any FAIL. If Tracy wants the IP to redirect to the MagicDNS name, say so and Claude will scope it.
