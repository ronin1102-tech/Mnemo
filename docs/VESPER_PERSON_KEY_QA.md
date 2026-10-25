# Vesper: deploy and verify person-key writes

From Claude, via Tracy, Oct 25, 2026. This implements your brief "Person-Key Write" (Tracy's decision). Same flow as PR #8, and the same rules as `docs/VESPER_OWNER_QA.md`:
- your Mac shell is for these commands only;
- never change `~/Mnemo-Vault` from the shell;
- no code changes (flag them instead);
- no credentials anywhere;
- report honestly.

## What changed

- **Person keys can write.** A person key that isn't read-only gets `canWrite: true` and the full editor in the Read tab (+ Note, + Request, Edit). It uses the same `PUT /api/note` as the Mac, with the same rules: byte for byte, atomic, 409 on conflicts.
- **Attribution.** A person-key write is logged as `owner-write` with `actor: "person:<key name>"` and `by.user: "<key name>"`. Local-session writes log as before.
- **Unchanged:**
  - Agent keys are refused on every Helix route, writing and approval included. They get **401**, as before: the bridge rejects anything but the local session key or a person key before reading the request. That's the same refusal the brief calls 403, and zero bytes change.
  - `Requests/` stays agent-proof.
  - `--read-only` mode means `canWrite: false` for everyone.
  - Read-only person keys can't write.
  - Revoking a key ends its writing on its next request.

## Before you start: check who already holds a person key

Every **existing** person key that isn't read-only gains write access with this change. On the Mac:

```sh
export PATH=/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin:$PATH
node ~/Mnemo-main/packages/mnemo-mcp/dist/ctl.js --vault ~/Mnemo-Vault token list
```

Show Tracy the `person` rows. For anyone who should only look and approve, Tracy decides; you don't do it on your own. The fix is to revoke their key and reissue it read-only:
- `token revoke <name>`
- `token add <name> --person --read-only`

## Step 1: update the Mac

Same as `docs/VESPER_OWNER_QA.md`, step 1: stop Mnemo, zip-swap `~/Mnemo-main`, `npm run install:all`, `npm run build`, `npm test`. Expect **98** (mnemo-mcp) and **51** (helix) to pass. Roll back on any failure.

## Step 2: run the extended QA script

```sh
export PATH=/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin:$PATH
bash ~/Mnemo-main/scripts/qa-owner-authorship.sh
```

Expected: **`50 passed, 0 failed`**. The old "person key: canWrite false" check is now "true".

New sections:
- **5. Person key writes:**
  - create, byte for byte;
  - edit with the right base, a stale base gets 409, creating over an existing note gets 409;
  - the log names `person:qa-person`;
  - a request created with the person key: agents are refused on it, an agent answer moves it to in-progress, and the file isn't rewritten.
- **6. Refusals:**
  - agent key: write refused with zero bytes changed, and the approval API refused;
  - read-only person key: `canWrite: false` and 403;
  - revoked person key: refused.
- **7. `--read-only` mode**, with and without a person key: `canWrite: false`, 403.

The connector is unchanged; there's no reinstall this time.

## Step 3: restart

- Restart the hub the way Tracy runs it (Mnemo.app, or `mnemo-ctl ... hub`).
- Have **Tracy** quit and reopen Cori. Don't restart Cori yourself.

## Step 4: Tracy's proof from the phone

1. **Tracy**, on the phone over the tailnet, opens the hub link with Tracy's person key: `http://onemoreizzysmbp.tail81e3a6.ts.net:7337/#token=<key>`. The header should show "signed in as <name>".
2. In the Read tab, Tracy taps **+ Note**:
   - title `Phone QA`
   - text `Written from my phone.`
   - **Create note**
3. Then **Edit**: add a line `Edited from my phone.` and tap **Save**.
4. **You**, from the connector: `read_note` with `{"path": "Phone QA.md"}`. The content should be exactly:
   ```
   # Phone QA

   Written from my phone.
   Edited from my phone.
   ```
   (Or whatever Tracy typed, character for character.)
5. **You**, on the Mac: confirm the audit entries, read-only:
   ```sh
   grep '"owner-write"' ~/Mnemo-Vault/.mnemo/logs/mnemo.log | tail -2
   ```
   Expect two lines: `"action":"create"` and `"action":"edit"`, both with `"path":"Phone QA.md"` and `"actor":"person:<Tracy's key name>"`.

## Report back

For each step, give PASS or FAIL, with:
- the `token list` person rows, and Tracy's decision on them;
- the last two lines of `npm test` and of the QA script;
- the `read_note` content;
- the two log lines.

Exact output for any FAIL.
