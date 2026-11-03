# Copilot chat (Path B: store-and-forward through the hub)

Scope: Vesper's "Mnemo Copilot Chat" brief of Nov 2, 2026 (Tracy chose Path B). A **Copilot** view in the Helix where Tracy talks to Cori with the vault in the room. Cori's codebase is not touched.

## How it works

1. Tracy writes a message in **Copilot**. The hub stores it, state **queued**. The pane says so plainly ("Queued: Cori will see this when next active"). There is no "typing" and no presence: the status line says when Cori last picked up messages.
2. Cori's MCP connection to the hub has two new tools: **`chat_fetch`** (returns queued messages, marks them delivered) and **`chat_post`** (a reply, optionally citing notes and carrying one proposal).
3. The reply lands in the pane, labelled as Cori. Cited notes are tappable chips. A proposal shows inline in gold with the normal Review / Approve / Reject; approving writes the note, rejecting writes nothing.
4. **Save** files the conversation as a note (`Chats/<title> <date>.md`), written with Tracy's own key through the normal note write ("Save to vault": Tracy's own authorship, logged as `person:<key>`).

Chat never writes the vault. The chat messages are not notes: they never appear in search, the graph or the helix.

## Switching it on (once)

```sh
# 1. a key for the agent (shown once; paste it into the agent's own MCP settings, nowhere else)
mnemo-ctl --vault ~/Mnemo-Vault token add cori --agent
# 2. seat the two of them. <your person key> is the key you open the Helix with on your phone.
mnemo-ctl --vault ~/Mnemo-Vault chat setup <your person key name> cori
mnemo-ctl --vault ~/Mnemo-Vault chat status      # who is in, what is waiting, when the agent last picked up
```

**The agent must connect through the hub, with its own key.** The chat tools exist only over the hub's MCP endpoint (`http://<mac>:7337/mcp`, header `Authorization: Bearer <cori's key>`). A stdio connection (`cli.js serve`, which is how Cori and Vesper connect today) has no key, so there is no identity to check, and so no chat tools. The hub must be running (`launcher --hub ...`, ideally `--at-login`).

## Who is in the channel

Exactly two seats, set by the human with `chat setup` and pinned to each key's **name and creation time** (so revoking a key and issuing another with the same name inherits nothing):

| Seat | Who |
|---|---|
| Owner | The Helix on the vault's own computer (loopback session), and the one person key named in `chat setup`. Not read-only keys. Other person keys, such as the office ones, get 403 and see an explanation instead of a chat. |
| Agent | The one agent key named in `chat setup`. Every other agent key is refused by `chat_fetch` / `chat_post` (checked on every call), and agent keys never reach the Helix API at all. |

Nobody else (Vesper, Silky, future keys) reads it without a separate decision. `--read-only` means no chat for anyone: the pane is off and the tools aren't registered.

## Decisions and interpretations (Claude, for Tracy to confirm)

- **Store format:** one JSON file per conversation in `.mnemo/chat/` (not JSONL), plus `channel.json` for the two seats and when the agent last picked up. A file per conversation makes "delete one conversation" a plain file delete and each update an atomic rename. It is Mnemo's own data folder: the indexer, graph and every agent read tool skip `.mnemo/`. Files are mode 0600. It sits inside the vault *folder* like the proposals and keys do, so a backup of the folder includes it.
- **The Helix on this computer counts as the owner** as well as the named person key, because that is Tracy at the Mac. Say if you'd rather it needed the person key too.
- **Context** on a sent message is the note open in the Helix (if you leave "Share the open note" ticked) and up to 3 notes that best match the message words, by full-text search (not the link graph). The list is stored with the message, shown as chips, and is exactly what `chat_fetch` returns (with the start of each note; the agent can `read_note` the rest).
- **"New reply" marker:** the pane's tab badge (a dot, per device) is enough for v1; the proposal inbox is unchanged.
- **Retention:** keep forever; the owner deletes a conversation with **Delete**.
- **Limits:** 20,000 characters a message, 2,000 messages a conversation, 500 conversations.
- **Phone:** on narrow screens the tabs sit in their own row and the tab reads "Chat". Enter makes a new line on a touch screen (use Send); on a computer, Enter sends and Shift+Enter makes a new line.

## Non-goals (v1, unchanged)

Live or streaming replies (Path A), voice, attachments, images, a third participant, push notifications, any change to Cori.

## QA gate

| Check | Covered by |
|---|---|
| Message persists across a hub restart as queued | `scripts/qa-copilot-chat.mjs` (1), `packages/mnemo-mcp/test/chat.test.ts` |
| `chat_fetch` returns and delivers; the tools appear with no agent-side change | same (2) |
| `chat_post` reply shown, labelled, cited notes tappable | same (3) + browser run |
| A proposal on a reply: approve writes, reject writes nothing | same (4) |
| Chatting leaves note count and search unchanged; Save to vault adds exactly one owner-authored note | same (5) |
| Another agent key is refused | same (6) |
| Chips equal the fetch's attachments | same (7) |
| Catalina hub + bridge on the 2012 MBP; phone proof over the tailnet | manual: `docs/VESPER_COPILOT_QA.md` |
