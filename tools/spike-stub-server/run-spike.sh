#!/usr/bin/env bash
# SPIKE-1 (08 §1): runs real Nx workspaces against the stub server and prints
# one line per experiment. Throwaway tooling; see README.md for the results.
#
#   tools/spike-stub-server/run-spike.sh [work dir] [nx versions...]
#
# Needs Node.js 24, npm and curl. SPIKE_HANG=1 adds the slow no-timeout test.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-$(mktemp -d)}
shift || true
VERSIONS=${*:-21.0.0 24.0.1}
P1=4510
P2=4511

mkdir -p "$WORK"
: >"$WORK/primary.log"
: >"$WORK/secondary.log"
PORT=$P1 LABEL=primary LOG_FILE="$WORK/primary.log" node "$HERE/src/server.ts" &
S1=$!
PORT=$P2 LABEL=secondary LOG_FILE="$WORK/secondary.log" node "$HERE/src/server.ts" &
S2=$!
trap 'kill $S1 $S2 2>/dev/null' EXIT
sleep 1

export NX_DAEMON=false NX_NO_CLOUD=true NX_TUI=false CI=true
unset NX_SELF_HOSTED_REMOTE_CACHE_SERVER NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN

scenario() {
  curl -sS -X POST -d "$1" "http://127.0.0.1:$P1/__scenario"
  curl -sS -X POST -d '{}' "http://127.0.0.1:$P2/__scenario"
}
mark() { for s in primary secondary; do echo "{\"mark\":\"$v:$1\"}" >>"$WORK/$s.log"; done; }
since() { awk -v m="{\"mark\":\"$v:$1\"}" 'f && /"mark"/{exit} f; $0==m{f=1}' "$WORK/${2:-primary}.log"; }
fresh() { echo "$RANDOM$RANDOM$RANDOM" >libs/a/input.txt; rm -rf .nx libs/a/dist libs/a/dist-slow; }
nxrun() {
  npx nx "$@" --output-style=static 2>&1 | sed 's/\x1b\[[0-9;]*m//g' |
    grep -E '^ *NX  |Unauthorized|Misconfigured|Failed to' | grep -v Successfully | head -2 | tr '\n' ' '
  echo "exit=${PIPESTATUS[0]}"
}
requests() {
  since "$1" "${2:-primary}" | node -e '
    const s = require("fs").readFileSync(0, "utf8").trim();
    if (!s) { console.log("(none)"); process.exit(); }
    console.log(s.split("\n").map((l) => { const j = JSON.parse(l);
      return `${j.method} ${j.path.replace(/\/v1\/cache\/(\d+)/, "/v1/cache/<$1>")} auth=${j.authorization ?? "-"} body=${j.bodyBytes}`;
    }).join(" | "));'
}

for v in $VERSIONS; do
  ws="$WORK/nx-$v"
  if [ ! -d "$ws/node_modules/nx" ]; then
    rm -rf "$ws" && mkdir -p "$ws" && cp -r "$HERE/fixture/." "$ws/"
    sed "s/__NX_VERSION__/$v/" "$ws/package.json.tmpl" >"$ws/package.json" && rm "$ws/package.json.tmpl"
    (cd "$ws" && git init -q && npm install --no-audit --no-fund --loglevel=error >/dev/null)
  fi
  cd "$ws" || exit 1
  echo "### nx $v"

  export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=t1
  for prefix in /workspace-a /workspace-a/; do
    export NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:$P1$prefix"
    scenario '{}'; mark "cq3$prefix"; fresh
    echo "CQ-3/CQ-6 server=$prefix :: $(nxrun build a) :: $(requests "cq3$prefix")"
  done

  export NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:$P1/ws"
  for c in "get 200-garbage" "get 204" "get 400" "get 401" "get 403" "get 409" "get 429" "get 500" "get 503" "get 504" \
    "put 201" "put 204" "put 400" "put 401" "put 403" "put 404" "put 409" "put 411" "put 413" "put 429" "put 500" "put 503"; do
    set -- $c
    status=${2%%-*}
    scenario "{\"$1\":{\"mode\":\"status\",\"status\":$status,\"body\":\"message from stub\",\"contentType\":\"text/plain\"}}"
    fresh
    echo "CQ-1/CQ-5 $1 $2 :: $(nxrun build a)"
  done

  export NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:4599/ws"
  fresh; echo "CQ-5 connection refused :: $(nxrun build a)"

  export NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:$P1/ws"
  scenario '{"get":{"mode":"status","status":404,"delayMs":35000}}'; fresh
  start=$(date +%s); echo "CQ-7 GET answered after 35 s :: $(nxrun build a) after $(($(date +%s) - start)) s"
  if [ "${SPIKE_HANG:-0}" = 1 ]; then
    scenario '{"get":{"mode":"hang"}}'; fresh
    start=$(date +%s); out=$(timeout 300 bash -c "npx nx build a --output-style=static >/dev/null 2>&1; echo exit=\$?")
    echo "CQ-7 GET never answered :: ${out:-still waiting} after $(($(date +%s) - start)) s"
  fi

  for target in "same http://127.0.0.1:$P1/__redirected" "cross http://localhost:$P2/__redirected"; do
    set -- $target
    for m in get put; do
      for st in 307 308; do
        scenario "{\"$m\":{\"mode\":\"redirect\",\"status\":$st,\"redirectTo\":\"$2\"}}"; mark "cq2-$1-$m-$st"; fresh
        echo "CQ-2 $m $st $1-origin :: $(nxrun build a) :: primary: $(requests "cq2-$1-$m-$st") :: secondary: $(requests "cq2-$1-$m-$st" secondary)"
      done
    done
  done

  unset NX_SELF_HOSTED_REMOTE_CACHE_SERVER NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN
  for daemon in false true; do
    for iso in false true; do
      npx nx daemon --stop >/dev/null 2>&1
      fresh
      if [ $daemon = true ]; then
        (AWS_PROFILE=daemon-start SPIKE_SET_SERVER="http://127.0.0.1:$P1/daemon-start" SPIKE_SET_TOKEN=daemon-start-token \
          NX_DAEMON=true NX_ISOLATE_PLUGINS=$iso npx nx daemon --start >/dev/null 2>&1)
      fi
      scenario '{}'; mark "hook-$daemon-$iso"
      out=$(AWS_PROFILE=shell NX_DAEMON=$daemon NX_ISOLATE_PLUGINS=$iso SPIKE_SET_SERVER="http://127.0.0.1:$P1/shell" \
        SPIKE_SET_TOKEN=shell-token nxrun build a)
      echo "PC-5/CQ-8/CQ-10 daemon=$daemon isolation=$iso :: $out :: $(requests "hook-$daemon-$iso")"
    done
  done
  npx nx daemon --stop >/dev/null 2>&1

  for daemon in false true; do
    fresh
    if [ $daemon = true ]; then (SPIKE_SET_SERVER= NX_DAEMON=true npx nx daemon --start >/dev/null 2>&1); fi
    scenario '{}'; mark "cq9-$daemon"
    out=$(NX_DAEMON=$daemon SPIKE_SET_SERVER= NX_SELF_HOSTED_REMOTE_CACHE_SERVER="http://127.0.0.1:$P1/shell" \
      NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=t1 nxrun build a)
    echo "CQ-9 hook sets server to '' daemon=$daemon :: $out :: $(requests "cq9-$daemon")"
    npx nx daemon --stop >/dev/null 2>&1
  done

  scenario '{}'; mark cq4; fresh
  out=$(NX_ISOLATE_PLUGINS=false SPIKE_SLOW_SECONDS=3 SPIKE_ROTATE_TOKEN_AFTER_MS=1500 \
    SPIKE_SET_SERVER="http://127.0.0.1:$P1/ws" SPIKE_SET_TOKEN=first-token nxrun run-many -t build slow -p a --parallel=1)
  echo "CQ-4 token changed 1.5 s into the run :: $out :: $(requests cq4)"
  cd "$WORK" || exit 1
done
