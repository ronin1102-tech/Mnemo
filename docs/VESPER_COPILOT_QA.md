# Vesper: deploy and verify Copilot chat (Path B)

From Claude, via Tracy, Nov 3, 2026. This implements your "Mnemo Copilot Chat: Path B" brief. Same rules as `docs/VESPER_OWNER_QA.md`: your Mac shell is for these steps only, never touch `~/Mnemo-Vault` from the shell (the QA script uses a throwaway vault in the temp folder), no code changes (flag them), no credentials in files, arguments or logs, report honestly. Design and decisions: `docs/copilot-chat.md`.

## What is new

- A **Copilot** view in the Helix (the tab reads "Chat" on a phone). Messages are stored by the hub in `.mnemo/chat/`, not as notes.
- Two MCP tools, `chat_fetch` and `chat_post`, **only over the hub's MCP endpoint**. A stdio connection has no key, so it has no chat tools. That includes your connector (SSH + stdio): `chat_*` are not in its allowlist and don't exist on the server it reaches. This is expected.
- `mnemo-ctl chat setup <person key> <agent key>` and `chat status` (human-only).
- **Cori must connect through the hub, with Cori's own agent key**, to use chat. Today Cori connects over stdio. That is a one-time change to Cori's MCP settings (data, not code). It is also the "no Cori-side change" check from your brief: Cori's tool list should show the two new tools by itself.

## Step 1: update the Mac

As step 1 of `docs/VESPER_OWNER_QA.md` (stop Mnemo, zip-swap `~/Mnemo-main`, `npm run install:all`, `npm run build`, `npm test`, roll back on any failure). Expect **110** (mnemo-mcp) and **63** (helix) passing.

## Step 2: run the QA script

```sh
export PATH=/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin:$PATH
node ~/Mnemo-main/scripts/qa-copilot-chat.mjs
```

Expected: **`27 passed, 0 failed`**. It uses a throwaway vault and its own hub on port 7392 (set `PORT=` if that is taken), with a real MCP client standing in for the agent. It covers acceptance 1 to 7:
- a message is stored as queued and survives a hub restart;
- `chat_fetch` delivers and the tools appear with nothing changed on the agent's side;
- `chat_post` replies with cited notes;
- a proposal on a reply: approve writes, reject writes nothing, and an agent can't attach another agent's proposal;
- chat leaves the note count and search untouched, and Save to vault adds exactly one owner-authored note;
- another agent key, a re-issued key with the same name, an office person key and a stdio connection are all refused or have no chat tools;
- the chips equal what the fetch attached;
- `--read-only` turns chat off for everyone.

## Step 3: switch it on for real (Tracy)

Tracy does this step, because the key is shown once and must not pass through logs or chat. In Terminal on the Mac:

```sh
export PATH=/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin:$PATH
cd ~/Mnemo-main
node packages/mnemo-mcp/dist/ctl.js --vault ~/Mnemo-Vault token list                  # note the name of the person key you open the Helix with
node packages/mnemo-mcp/dist/ctl.js --vault ~/Mnemo-Vault token add cori --agent       # prints Cori's key ONCE: copy it into Cori's MCP settings (below), nowhere else
node packages/mnemo-mcp/dist/ctl.js --vault ~/Mnemo-Vault chat setup <your person key name> cori
node packages/mnemo-mcp/dist/ctl.js --vault ~/Mnemo-Vault chat status
```

Then start (or restart) the hub the way Tracy runs it (Mnemo.app with `launcher --hub ...`). Chat needs the hub, not only `ui`.

**Cori's MCP settings:** replace Cori's current Mnemo server (stdio, `cli.js serve`) with an HTTP one: URL `http://127.0.0.1:7337/mcp` (Cori is on the same Mac), header `Authorization: Bearer <cori's key>`, in whatever form Cori's MCP panel uses for an HTTP server. Reconnect, then check Cori's tool list shows the same 16 tools plus `chat_fetch` and `chat_post`. (If the panel can't send a header, stop and flag it: that is a Cori-side limit, not something to work around.)

## Step 4: live acceptance

| # | Who | Check | Result |
|---|---|---|---|
| 1 | Tracy, on the phone over the tailnet hub | Open **Chat**, send "Hello Cori, can you hear me?". It shows **Queued: Cori will see this when next active**, and the status line says Cori hasn't picked up messages yet | |
| 2 | Vesper | Restart the hub. Tracy reloads the phone page, opens Chat: the message is still there, still queued | |
| 3 | Tracy | In a new Cori session, ask Cori to check Copilot chat. Cori calls `chat_fetch`, sees the message, replies with `chat_post` (ideally citing a note). The phone shows the reply labelled **Cori**, the message flips to Delivered then Answered, and the status line says when Cori last picked up | |
| 4 | Tracy and Cori | Ask for something to be saved. Cori makes a proposal and attaches it to the reply. It shows **in gold** in the chat. Tracy taps Review changes, then Approve: the note lands. Do it once more and Reject: nothing lands | |
| 5 | Vesper, through your connector | Before and after the chat above, `list_notes` shows the same note count (plus only the approved proposal's note), and `search_notes` for words from the chat finds nothing in the chat itself | |
| 6 | Tracy | Press **Save** on the conversation: exactly one new note under `Chats/`, with Tracy's words as "Me" | |
| 7 | Vesper | Through your connector, `call-tool --name chat_fetch --arguments-file <{}>`: refused by the client allowlist (exit 4). Also confirm on the Mac: `grep '"owner-write"' ~/Mnemo-Vault/.mnemo/logs/mnemo.log | tail -1` shows `"actor":"person:<Tracy's key>"` for the Save | |
| 8 | Tracy | The "Share the open note" and "Include related notes" options work: the chips under Tracy's message list the shared notes, and Cori mentions the same notes | |
| 9 | Both | Catalina look: the pane renders, the keyboard types normally, scrolling up while a reply lands doesn't jump the view, and a "New messages ↓" pill appears | |

## Report back

PASS/FAIL per row, the last two lines of `npm test` and of the QA script, the output of `chat status`, and exact output for any FAIL. Flag anything Cori's panel couldn't do. If it all passes, Tracy can delete `~/Mnemo-main-old` and `~/mnemo.zip`.
