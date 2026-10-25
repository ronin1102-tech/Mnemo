#!/bin/bash
# Mnemo owner-authorship QA (PR #8). Runs on the Mac against a THROWAWAY vault in /tmp.
# It never reads or writes ~/Mnemo-Vault. Prints PASS/FAIL per check and exits non-zero on any FAIL.
NODE_BIN="${NODE_BIN:-/Users/onemoretimetrizzy/.nvm/versions/node/v20.20.2/bin}"
MNEMO="${MNEMO:-$HOME/Mnemo-main}"
PORT="${PORT:-7391}"
export PATH="$NODE_BIN:$PATH"
DIST="$MNEMO/packages/mnemo-mcp/dist"
CTL="node $DIST/ctl.js"
V="$(mktemp -d /tmp/mnemo-qa.XXXXXX)"
OUT="$V.out"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1 (expected: $3, got: $2)"; fail=$((fail+1)); fi; }
start_ui() {
  $CTL --vault "$V" "$@" ui --port "$PORT" --no-open > "$V.ui.log" 2>&1 &
  UI_PID=$!; TOKEN=""
  for _ in $(seq 1 40); do TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$V.ui.log" | head -1 | cut -d= -f2); [ -n "$TOKEN" ] && break; sleep 0.5; done
  [ -n "$TOKEN" ] || { echo "FAIL  could not start mnemo-ctl ui:"; cat "$V.ui.log"; exit 1; }
}
stop_ui() { kill "$UI_PID" 2>/dev/null; wait "$UI_PID" 2>/dev/null; }
# api METHOD PATH [JSON-BODY] [KEY]  -> prints the HTTP status, body in $OUT
api() { curl -s -o "$OUT" -w '%{http_code}' -X "$1" -H "X-Mnemo-Token: ${4:-$TOKEN}" -H "Content-Type: application/json" ${3:+--data-binary "$3"} "http://127.0.0.1:$PORT$2"; }
# field NAME: read one (dotted) field of the last response
field() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],d);console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$OUT" "$1"; }
body() { node -e 'console.log(JSON.stringify({path:process.argv[1],content:require("fs").readFileSync(process.argv[2],"utf8"),base:process.argv[3]==="null"?null:process.argv[3]}))' "$1" "$2" "$3"; }
hash() { api GET "/api/note?path=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1")" >/dev/null; field hash; }
gate() { node --input-type=module -e "import { ProposalStore } from 'file://$DIST/proposals.js'; import { Vault } from 'file://$DIST/vault.js'; const s = new ProposalStore(new Vault(process.argv[1])); const [op, ...a] = process.argv.slice(2); try { const p = s[op](...a); console.log(p.id); } catch (e) { console.log('REFUSED: ' + e.message); }" "$V" "$@"; }

echo "Mnemo owner-authorship QA · $(node -v) · vault $V"
printf '# Hello\nMnemo is connected.\n' > "$V/hello.md"
start_ui

# 1. owner write lands byte-for-byte, atomically; index sees it without a restart
printf -- '---\nmood: kept as typed\n---\n# Owner note\nTabs\there, unicode \342\234\223, CRLF\r\nend\n' > "$V.typed"
check "owner create returns 200"           "$(api PUT /api/note "$(body 'Projects/Owner note.md' "$V.typed" null)")" 200
check "file on disk is byte-for-byte"      "$(cmp -s "$V.typed" "$V/Projects/Owner note.md" && echo same || echo different)" same
check "no temp files left behind"          "$(ls -a "$V/Projects" | grep -c mnemo-tmp)" 0
api GET /api/graph >/dev/null
check "index shows it, no restart"         "$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(d.nodes.some(n=>n.path==="Projects/Owner note.md"))' "$OUT")" true
check "graph says this Helix can write"    "$(field canWrite)" true
printf '# Owner note\nedited\n' > "$V.edit"
check "owner edit returns 200"             "$(api PUT /api/note "$(body 'Projects/Owner note.md' "$V.edit" "$(hash 'Projects/Owner note.md')")")" 200
check "edit is on disk"                    "$(cmp -s "$V.edit" "$V/Projects/Owner note.md" && echo same || echo different)" same
check "write logged as owner-write"        "$(grep -c '"event":"owner-write"' "$V/.mnemo/logs/mnemo.log")" 2

# 2. never silently overwrite
OLD=$(hash 'Projects/Owner note.md'); printf 'changed by another editor\n' > "$V/Projects/Owner note.md"
printf 'mine\n' > "$V.mine"
check "stale save is refused (409)"        "$(api PUT /api/note "$(body 'Projects/Owner note.md' "$V.mine" "$OLD")")" 409
check "disk version untouched"             "$(cat "$V/Projects/Owner note.md")" "changed by another editor"
check "create over an existing note: 409"  "$(api PUT /api/note "$(body 'hello.md' "$V.mine" null)")" 409
for bad in "../escape.md" ".mnemo/x.md" ".hidden/x.md" "x.txt"; do
  check "bad path refused: $bad"           "$(api PUT /api/note "$(body "$bad" "$V.mine" null)")" 400
done

# 3. an agent proposal on a note the owner then edits goes stale; owner's bytes stay
PID=$(gate proposeWrite hello.md "agent version" qa-agent)
printf '# Hello\nowner wins\n' > "$V.own"
check "owner edits the proposed note"      "$(api PUT /api/note "$(body hello.md "$V.own" "$(hash hello.md)")")" 200
$CTL --vault "$V" approve "$PID" > "$V.approve" 2>&1
check "approve halts as stale"             "$(grep -c stale "$V.approve")" 1
check "owner's bytes intact"               "$(cmp -s "$V.own" "$V/hello.md" && echo same || echo different)" same

# 4. requests: readable, unchangeable by agents, answered through the gate
printf '# Summarise hello\nPlease write a one-line summary of [[hello]] as Summary.md.\n' > "$V.req"
check "owner creates a request"            "$(api PUT /api/note "$(body 'Requests/Summarise hello.md' "$V.req" null)")" 200
for op in "proposeWrite Requests/Summarise\ hello.md hijack qa-agent" "proposeWrite requests/new.md x qa-agent" "proposeDelete Requests/Summarise\ hello.md qa-agent"; do
  eval "set -- $op"
  check "agent refused: $1 $2"             "$(gate "$@" | cut -c1-8)" "REFUSED:"
done
api GET /api/graph >/dev/null
check "request status: open"               "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).requests[0].status)' "$OUT")" open
AID=$(gate proposeWrite Summary.md $'# Summary\nHello says Mnemo is connected.\n' qa-agent 'Requests/Summarise hello.md')
api GET /api/graph >/dev/null
check "answer recorded on the proposal"    "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).proposals.find(p=>p.id===process.argv[2]).request)' "$OUT" "$AID")" "Requests/Summarise hello.md"
check "request status: in-progress"        "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).requests[0].status)' "$OUT")" in-progress
check "nothing written before approval"    "$([ -e "$V/Summary.md" ] && echo exists || echo absent)" absent
$CTL --vault "$V" approve "$AID" > /dev/null 2>&1
api GET /api/graph >/dev/null
check "request status: addressed"          "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).requests[0].status)' "$OUT")" addressed
check "request file never rewritten"       "$(cmp -s "$V.req" "$V/Requests/Summarise hello.md" && echo same || echo different)" same
check "mnemo-ctl show names the request"   "$($CTL --vault "$V" show "$AID" | grep -c 'answers request: Requests/Summarise hello.md')" 1

# 5. person keys and read-only mode cannot write
KEY=$($CTL --vault "$V" token add qa-person --person 2>/dev/null | grep -o 'mn_p_[A-Za-z0-9_-]*')
check "person key: canWrite false"         "$(api GET /api/graph "" "$KEY" >/dev/null; field canWrite)" false
check "person key: write refused (403)"    "$(api PUT /api/note "$(body 'p.md' "$V.mine" null)" "$KEY")" 403
stop_ui
start_ui --read-only
check "read-only: canWrite false"          "$(api GET /api/graph >/dev/null; field canWrite)" false
check "read-only: write refused (403)"     "$(api PUT /api/note "$(body 'r.md' "$V.mine" null)")" 403
stop_ui

echo "----"
echo "$pass passed, $fail failed"
rm -rf "$V" "$V".*
[ "$fail" -eq 0 ]
