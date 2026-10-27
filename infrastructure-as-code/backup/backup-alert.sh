#!/usr/bin/env bash
# Put a prod backup problem in front of the operator: open — or comment on — ONE backlog item.
# Installed as ~/backup/backup-alert.sh (spec 084 FR-001/FR-002, research R1).
#
# The July–October outage wrote `Failed with result 'exit-code'` to the journal every night and
# nothing read it. The backlog is where the operator already looks. Every event lands on the same
# open item (matched by exact title), and only a human closes it.
#
#   backup-alert.sh failed <unit>        from homelab-backup-alert@.service (OnFailure=); a unit
#                                        that hit TimeoutStartSec is reported as `hung`
#   backup-alert.sh <reason> <file|->    reasons: stale staleness-unreadable shrink komodo-oversize recovered
#
# Needs ~/backup/forge-issue-token (mode 600, an issues-scoped token) and MCM_FORGE_URL in
# ~/backup/alert.env. The forge host is never committed (check-topology-scrub).
# Exit: 0 delivered (or nothing to do) · 2 usage · 3 not configured · 4 forge API call failed.
set -euo pipefail

REPO=jumbleknot/mcm
TITLE='Prod backup: failed or stale'
REASONS=' failed hung stale staleness-unreadable shrink komodo-oversize recovered '
BACKUP_DIR="$HOME/backup"
TOKEN_FILE="$BACKUP_DIR/forge-issue-token"

usage() { echo "usage: $0 <reason> <detail-file|-|unit>   reasons:$REASONS" >&2; exit 2; }
undelivered() { echo "alert NOT delivered: $1" >&2; exit "$2"; }

[ "$#" -eq 2 ] || usage
reason=$1
arg=$2
case "$REASONS" in *" $reason "*) ;; *) usage ;; esac

for tool in curl python3; do
  command -v "$tool" > /dev/null || undelivered "$tool is not installed" 3
done
if [ -f "$BACKUP_DIR/alert.env" ]; then
  # shellcheck source=/dev/null
  . "$BACKUP_DIR/alert.env"
fi
[ -n "${MCM_FORGE_URL:-}" ] || undelivered "MCM_FORGE_URL is not set (expected in $BACKUP_DIR/alert.env)" 3
[ -f "$TOKEN_FILE" ] || undelivered "token file $TOKEN_FILE is missing" 3
[ "$(stat -c %a "$TOKEN_FILE")" = 600 ] || undelivered "token file $TOKEN_FILE must be mode 600" 3

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# The token reaches curl through a header FILE: never argv, where `ps` and the journal can see it.
printf 'Authorization: token %s\n' "$(tr -d '\n' < "$TOKEN_FILE")" > "$WORK/auth"
API="$MCM_FORGE_URL/api/v1/repos/$REPO"

# api <url> [curl options…]
api() {
  local url=$1 rc
  shift
  curl -fsS -H @"$WORK/auth" -H 'Content-Type: application/json' "$@" "$url" || {
    rc=$?
    undelivered "forge API call failed (curl exit $rc)" 4
  }
}

if [ "$reason" = failed ]; then
  result=$(systemctl --user show -p Result "$arg" 2> /dev/null | sed -n 's/^Result=//p') || result=""
  if [ "$result" = timeout ]; then reason=hung; fi
  journalctl --user -u "$arg" -n 40 --no-pager > "$WORK/detail" 2>&1 || echo "(journal unavailable for $arg)" > "$WORK/detail"
elif [ "$arg" = - ]; then
  : > "$WORK/detail"
else
  head -n 40 "$arg" > "$WORK/detail"
fi

q=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$TITLE")
api "$API/issues?type=issues&state=open&q=$q&limit=50" > "$WORK/open.json"
number=$(python3 - "$WORK/open.json" "$TITLE" << 'PY'
import json, sys
for issue in json.load(open(sys.argv[1])):
    if issue.get("title") == sys.argv[2]:
        print(issue["number"])
        break
PY
)

if [ -z "$number" ] && [ "$reason" = recovered ]; then
  echo "backup recovered; no open alert item"
  exit 0
fi
if [ -z "$number" ]; then api "$API/labels?limit=50" > "$WORK/labels.json"; else echo '[]' > "$WORK/labels.json"; fi

# Redaction is for what a backup journal can carry: URI user-info, and lines naming a credential.
python3 - "$WORK" "$reason" "$(uname -n)" "$TITLE" "$number" << 'PY'
import datetime, json, re, sys
work, reason, host, title, number = sys.argv[1:6]
drop = re.compile(r"PASSWORD|PASSWD|SECRET|TOKEN|Authorization", re.I)
userinfo = re.compile(r"([a-z][a-z0-9+.-]*://)[^/@\s]+@", re.I)
raw = open(f"{work}/detail", errors="replace").read().splitlines()[-40:]
lines = [userinfo.sub(r"\1***@", l) for l in raw if not drop.search(l)]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
text = f"reason: {reason}\nhost: {host}\ntime: {now}\n"
if lines:
    text += "\n```\n" + "\n".join(lines) + "\n```\n"
text += "\nRunbook: docs/runbooks/Server-Setup-Runbook.md, section Backups.\n"
if number:
    payload = {"body": text}
else:
    wanted = {"type/bug", "priority/p1"}
    labels = [l["id"] for l in json.load(open(f"{work}/labels.json")) if l.get("name") in wanted]
    payload = {"title": title, "body": text, "labels": labels}
json.dump(payload, open(f"{work}/payload.json", "w"))
PY

if [ -n "$number" ]; then
  api "$API/issues/$number/comments" -X POST --data-binary @"$WORK/payload.json" > /dev/null
  echo "alert delivered: $reason, commented on item #$number"
else
  created=$(api "$API/issues" -X POST --data-binary @"$WORK/payload.json")
  echo "alert delivered: $reason, opened item #$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["number"])' "$created")"
fi
