# Vesper: install and QA the owner-authorship build (PR #8)

From Claude, via Tracy. Oct 25, 2026. Tracy has authorized you to run these commands on the Mac over your SSH access.

**What changed:** Tracy can now write notes, and **requests** for agents, inside Mnemo. Requests are notes in `Requests/`. Agents can read them but no agent tool can change them. You answer a request with ordinary proposals that carry `"request": "<its path>"`. The design is in `docs/owner-authorship.md`.

## Rules for this session

- Your shell access to the Mac is for the install and QA commands below.
- **Never create, edit, move or delete anything in `~/Mnemo-Vault` from the shell.** Every vault change goes through your connector (as proposals) or through Tracy. The QA script uses a throwaway vault in `/tmp`.
- Don't modify Mnemo's code or Cori's. If something needs a code change, stop and flag it.
- No credentials in files, arguments or logs.
- Don't restart Cori yourself. Step 1 tells Tracy when to.
- Report honestly: give PASS/FAIL with the exact output for any FAIL.

## Step 1: update Mnemo on the Mac (SSH)

Non-interactive SSH shells don't load nvm, so put Node 20 on PATH first:

```sh
export PATH=/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin:$PATH
node -v                                   # must print v20.20.2
cd ~
node ~/Mnemo-main/packages/mnemo-mcp/dist/ctl.js --vault ~/Mnemo-Vault stop   # stop the background Mnemo, if running
rm -rf Mnemo-main-old mnemo.zip
curl -fL -o mnemo.zip https://github.com/ronin1102-tech/Mnemo/archive/refs/heads/main.zip
mv Mnemo-main Mnemo-main-old
unzip -q mnemo.zip
cd Mnemo-main
npm run install:all
npm run build
npm test                                  # expect: 97 pass (mnemo-mcp), then 51 pass (helix)
```

**If any step fails**, roll back and report:

```sh
cd ~ && rm -rf Mnemo-main && mv Mnemo-main-old Mnemo-main
```

Then tell Tracy to:
1. Quit and reopen Cori, so it picks up `list_requests`. Cori should then show **16 tools**.
2. Open Mnemo.app.

Keep `~/Mnemo-main-old` until QA passes.

## Step 2: run the automated QA on the Mac (SSH)

```sh
export PATH=/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin:$PATH
bash ~/Mnemo-main/scripts/qa-owner-authorship.sh
```

Expected: `50 passed, 0 failed` (33 when first written; 50 since person keys can write). The script runs on a throwaway vault in `/tmp`, on port 7391, and deletes it at the end. It never touches `~/Mnemo-Vault`. It covers every server-side item in the QA gate:

- **Owner writes:** saves land byte for byte and atomically; the index picks them up without a restart; each save is logged as `owner-write`.
- **Conflicts:** a stale save gets 409 and the disk version is untouched; creating over an existing note gets 409; bad paths are refused.
- **Stale proposals:** an agent proposal on a note Tracy then edits goes stale, and Tracy's bytes stay.
- **Requests:** agents can't write, delete or create anything in `Requests/`; the status moves open → in-progress → addressed; the request file is never rewritten; `mnemo-ctl show` names the request.
- **Person keys write** (Oct 25 change): byte for byte, 409 on conflicts, logged as `person:<name>`, revocable.
- **No writing elsewhere:** agent keys get 401 with zero bytes changed; read-only person keys and `--read-only` mode get `canWrite: false` and 403.

## Step 3: update your connector (on your VM)

The new connector adds `list_requests` to Phase 1. Your current `config.json` (with Tracy's Phase 2 setting) is kept.

```sh
cd ~/workspace/custom-connectors
cp custom.mnemo/config.json /tmp/custom.mnemo.config.json.bak
ssh -T -i ~/.ssh/id_ed25519 -o BatchMode=yes -o IdentitiesOnly=yes \
  -o "ProxyCommand=python3 $HOME/workspace/custom-connectors/custom.mnemo/bin/muse_proxy.py --proxy-port 3130 %h %p" \
  onemoretimetrizzy@100.103.16.78 'cat ~/Mnemo-main/connectors/custom.mnemo.tar.gz' > /tmp/custom.mnemo.tar.gz
tar -tzf /tmp/custom.mnemo.tar.gz          # inspect before extracting
mv custom.mnemo custom.mnemo.prev
tar -xzf /tmp/custom.mnemo.tar.gz
cp /tmp/custom.mnemo.config.json.bak custom.mnemo/config.json
diff -r custom.mnemo.prev custom.mnemo     # review: allowlist (+ list_requests), CONNECTOR.md, tests. No other code changes.
cd custom.mnemo
python3 -m unittest discover -s tests      # expect: 27 tests OK (6 skipped)
python3 bin/client.py list-tools           # expect: count 16; list_requests "allowed": true
```

## Step 4: live crew-inbox test on the real vault (Tracy and you)

1. **Tracy**, in Mnemo.app: open the Read tab and click **+ Request**.
   - Title: `QA: summarise hello`
   - Text: `Write a one-line summary of [[hello]] as a new note QA/Summary.md.`
   - Click **Send request**. It should show "Open: no agent has answered yet".
2. **You**, through the connector:
   - `call-tool --name list_requests` with arguments `{}`. Expect the request, with status `open`.
   - `read_note` it, and keep its content for step 6.
3. **You**: prove that you can't write to `Requests/`.
   - Call `write_note` with `{"path": "Requests/QA summarise hello.md", "content": "x"}`.
   - Expect exit 1 (`isError`) and a message about the owner's requests.
   - `list_proposals` with `{"status": "pending"}` should show no new proposal.
4. **You** (Phase 2): answer the request.
   - Call `write_note` with `{"path": "QA/Summary.md", "content": "# Summary\n<your one line>\n", "request": "Requests/QA summarise hello.md"}`.
   - Then `list_requests`: expect `in-progress`.
   - Check that `QA/Summary.md` does not exist yet (`read_note` returns isError).
5. **Tracy**, in Mnemo: on the request page, the answer shows "waiting for your approval" in gold. Click **Review changes**, then **Approve**.
6. **You**:
   - `list_requests` should show `addressed`.
   - `read_note QA/Summary.md` should match exactly what you proposed.
   - `read_note` the request again: its content should be byte-identical to step 2.
7. **Tracy** closes it: on the request page, click **Edit**, add these lines at the very top, then press ⌘S:
   ```
   ---
   status: done
   ---
   ```
   **You**: `list_requests` should show `closed`.

## Step 5: Tracy's hands-on checks (Catalina, Firefox)

This is the hardware pass for the editor. Tracy, in Mnemo.app in Firefox:

| Check | Result |
|---|---|
| Read tab shows **+ Note**, **+ Request**, **Edit** | |
| **+ Note**: type a title, a folder and some text; **Preview** renders it; **Create note** saves it and shows it | |
| **Edit**, change a line, ⌘S: saved, and the reader shows the change | |
| Type something in Edit, then click the Helix tab: Mnemo asks "Discard your unsaved changes?" | |
| Esc in the editor cancels (asking first if there are unsaved changes) | |
| Optional conflict: open a note in **Edit**, change the same note in TextEdit and save it, then press Save in Mnemo. Mnemo shows the "changed on disk" choice and nothing is overwritten until Tracy picks | |
| Typing feels normal: no lag, accents and emoji are fine | |

Tracy can delete the QA notes in Finder afterwards (`QA/`, and `Requests/QA summarise hello.md`).

## Report back

For each step, give PASS or FAIL. Include:
- the last two lines of `npm test` and of the QA script
- the `list-tools` count
- the request status you saw at each stage of step 4
- Tracy's table from step 5

For any FAIL, include the exact output, and whether you rolled back. Once everything passes, Tracy can delete `~/Mnemo-main-old` and `~/mnemo.zip`, and you can delete `custom.mnemo.prev`.
