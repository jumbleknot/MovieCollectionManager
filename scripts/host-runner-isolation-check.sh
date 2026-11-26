#!/usr/bin/env bash
# Measure whether another project's CI left anything in MCM's runner user (item #1142).
#
#   bash scripts/host-runner-isolation-check.sh --since <ISO-8601 UTC> [--project BELAY]
#
# Run it ON the CI host AS the `ci` user (MCM's runner user), e.g.
#   ssh ci@<ci-host> 'bash -s -- --since 2026-12-01T10:00:00Z' < scripts/host-runner-isolation-check.sh
#
# `--since` is the moment the other project's runner moved to its own Unix user. Every check reads
# only what happened after it, so the result says "nothing since the switch", not "nothing ever".
# Read-only: it changes nothing on the host. Run it within a few hours of the other project's job:
# the daemon keeps only a bounded, recent event history for check 3, and loses it on restart.
#
# Each line is PASS or FAIL and names what it found. Exit 0 = all PASS, 1 = any FAIL, 2 = bad usage.
# Run it BEFORE the switch too, with a recent --since: it must FAIL there (the other project's tasks
# run on MCM's runner today), which shows the measurement can see what it is looking for.
#
# What it checks, and why each is the shared surface:
#   1. MCM's runner took no task from the other repo: the runner is registered instance-wide, so a
#      `runs-on: kvm` job from any repository lands on it and runs as `ci`.
#   2. The shared tool cache's Node has no global package beyond what setup-node ships (npm, corepack).
#      On 2026-11-25 a global pnpm put there by the other project broke MCM's main.
#   3. MCM's rootless daemon started no job container for a task MCM's runner did not take. Act names
#      a job container FORGEJO-ACTIONS-TASK-<task id>_…; today the other project's container jobs run here.
#   4. MCM's daemon holds no image named after the other project.
#   5. No runner process, systemd unit or runner dir of the other project under this user. (npm keeps
#      only its ten newest debug logs, so ~/.npm/_logs cannot prove anything after a day.)
#   6. No job-private dir under ~/.cache/act/*/tmp carries the other project's prefix.
set -uo pipefail

PROJECT=BELAY
SINCE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    # `shift 2` with one argument left fails WITHOUT shifting, which would loop for ever.
    --since | --project)
      [ "$#" -ge 2 ] || { echo "usage: $0 --since <YYYY-MM-DDTHH:MM[:SS]Z> [--project <name>]  ($1 needs a value)" >&2; exit 2; }
      if [ "$1" = --since ]; then SINCE=$2; else PROJECT=$2; fi
      shift 2 ;;
    -h | --help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "host-runner-isolation-check: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?Z$ ]] ||
  { echo "usage: $0 --since <YYYY-MM-DDTHH:MM[:SS]Z> [--project <name>]" >&2; exit 2; }
[ -n "$PROJECT" ] || { echo "host-runner-isolation-check: --project needs a value" >&2; exit 2; }

export DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}
lower=$(printf '%s' "$PROJECT" | tr '[:upper:]' '[:lower:]')
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }

echo "host-runner-isolation-check: user $(id -un), project $PROJECT, since $SINCE, daemon $DOCKER_HOST"

# 1. Tasks the MCM runner took from the other repo.
journal_since=$(date -u -d "$SINCE" '+%Y-%m-%d %H:%M:%S')
tasks=$(journalctl --user -u forgejo-runner --since "$journal_since" --no-pager -o cat 2>/dev/null |
  grep -i -o "task [0-9]* repo is [^ ]*/$PROJECT\b" | awk '{print $2}' | sort -u | tr '\n' ' ')
if [ -z "$tasks" ]; then pass "MCM's runner took no $PROJECT task"
else fail "MCM's runner ran $PROJECT task(s): $tasks"; fi

# 2. Global packages in the shared tool-cache Node.
extra=$(ls -1 "$HOME"/.cache/act/tool_cache/node/*/x64/lib/node_modules 2>/dev/null |
  grep -v -E '^(npm|corepack|/.*:|)$' | sort -u | tr '\n' ' ')
if [ -z "$extra" ]; then pass "tool-cache Node carries only npm/corepack"
else fail "tool-cache Node carries extra global package(s): $extra"; fi

# 3. Job containers on MCM's daemon that MCM's runner did not start. Act names each one
#    FORGEJO-ACTIONS-TASK-<task id>_…; a task id MCM's runner never logged belongs to another runner
#    using this daemon (today: the other project's container jobs, through its own runner).
mine=$(journalctl --user -u forgejo-runner --since "$journal_since" --no-pager -o cat 2>/dev/null |
  grep -o "task [0-9]* repo is " | awk '{print $2}' | sort -u)
foreign=$(timeout 30 docker events --since "$SINCE" --until "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --filter type=container --filter event=start --format '{{.Actor.Attributes.name}}' 2>/dev/null |
  sed -n -E 's/^FORGEJO-ACTIONS-TASK-([0-9]+)_.*/\1/p' | sort -u | comm -23 - <(printf '%s\n' "$mine") | tr '\n' ' ')
if [ -z "$foreign" ]; then pass "every job container on MCM's daemon belongs to a task MCM's runner ran"
else fail "MCM's daemon ran job container(s) for task(s) MCM's runner never took: $foreign"; fi

# 4. Images named after the other project.
imgs=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -i -- "$lower" | tr '\n' ' ')
if [ -z "$imgs" ]; then pass "MCM's daemon holds no image named *$lower*"
else fail "MCM's daemon holds $PROJECT image(s): $imgs"; fi

# 5. The other project's runner no longer runs as this user, and its files left this $HOME.
procs=$(pgrep -u "$(id -u)" -a -f "forgejo-runner" 2>/dev/null | grep -i -- "runner-$lower" | awk '{print $1}' | tr '\n' ' ')
units=$(ls "$HOME"/.config/systemd/user/*"$lower"* "$HOME/runner-$lower" 2>/dev/null | grep -v ':$' | tr '\n' ' ')
if [ -z "$procs" ] && [ -z "$units" ]; then pass "no $PROJECT runner process, unit or directory under $(id -un)"
else fail "$PROJECT runner still under $(id -un): pid(s) ${procs:-none}; file(s) ${units:-none}"; fi

# 6. The other project's job-private dirs under MCM's act workdirs.
dirs=$(find "$HOME"/.cache/act/*/tmp -maxdepth 1 -name "$lower-*" -newermt "$SINCE" 2>/dev/null | tr '\n' ' ')
if [ -z "$dirs" ]; then pass "no $lower-* job dir under ~/.cache/act/*/tmp since the switch"
else fail "$PROJECT job dir(s) under MCM's act workdirs: $dirs"; fi

if [ "$fails" -eq 0 ]; then echo "host-runner-isolation-check: ISOLATED (6/6 PASS)"; exit 0; fi
echo "host-runner-isolation-check: NOT ISOLATED ($fails FAIL)"
exit 1
