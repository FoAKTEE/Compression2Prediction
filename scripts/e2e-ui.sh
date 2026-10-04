#!/usr/bin/env bash
# End-to-end UI check on live server data (node N10).
#
# Builds core, server, and frontend; starts the built API server on 5001 with
# a temporary C2P_DATA_DIR and `vite preview` on 4177 (its /api proxy points
# to 5001); drives the API with curl (project, bundled incident world and
# model, compile, baseline and extra_crew forecasts, a synthetic backtest);
# then takes headless screenshots of /process/<projectId>?step=1, 3, and 4
# (1280x2400), plus step 4 in full height for the synthetic backtest panel.
# Both servers are stopped on exit. No LLM is called (LLM_API_KEY is unset).
#
# Environment overrides:
#   E2E_SHOT_DIR  where the screenshots go (default: ${TMPDIR:-/tmp}/c2p-e2e-ui)
#   CHROME        headless Chromium binary (default: the Playwright headless shell)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT=5001
UI_PORT=4177
API="http://127.0.0.1:${API_PORT}/api"
UI="http://127.0.0.1:${UI_PORT}"
CHROME="${CHROME:-$HOME/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell}"
SHOT_DIR="${E2E_SHOT_DIR:-${TMPDIR:-/tmp}/c2p-e2e-ui}"
DATA_DIR="$(mktemp -d -t c2p-e2e-data-XXXXXX)"
WORK="$(mktemp -d -t c2p-e2e-work-XXXXXX)"
SERVER_PID=""
PREVIEW_PID=""

# Stop a process and everything it started (npx -> vite, node).
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "$PREVIEW_PID" "$SERVER_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$DATA_DIR" "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

log() { printf '[e2e-ui] %s\n' "$*"; }
fail() { printf '[e2e-ui] FAIL: %s\n' "$*" >&2; exit 1; }

# Read a field from a JSON file: json <file> <js expression over `d`>.
json() { node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = eval(process.argv[2]); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));' "$1" "$2"; }

# request <method> <path> <expected status> <out file> [curl args...]
request() {
  local method=$1 path=$2 expected=$3 out=$4
  shift 4
  local status
  status=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" "$@")
  [[ "$status" == "$expected" ]] || fail "$method $path answered $status (expected $expected): $(cat "$out")"
}

wait_for() {
  local url=$1 name=$2
  for _ in $(seq 1 150); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    sleep 0.2
  done
  fail "$name did not come up at $url"
}

for port in "$API_PORT" "$UI_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:${port}/"; then fail "port $port is already in use"; fi
done
[[ -x "$CHROME" ]] || fail "headless Chromium not found at $CHROME"
mkdir -p "$SHOT_DIR"

log "building core, server, and frontend"
(cd "$ROOT" && npm run build --silent) >"$WORK/build.log" 2>&1 || { cat "$WORK/build.log"; fail "build failed"; }

log "starting the API server on $API_PORT (data dir $DATA_DIR)"
(cd "$ROOT/packages/server" && exec env -u LLM_API_KEY C2P_DATA_DIR="$DATA_DIR" PORT="$API_PORT" HOST=127.0.0.1 node dist/main.js) >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
wait_for "$API/health" "API server"

log "starting vite preview on $UI_PORT"
(cd "$ROOT/frontend" && exec npx vite preview --port "$UI_PORT" --strictPort --host 127.0.0.1) >"$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
wait_for "$UI/" "vite preview"
curl -sf -o /dev/null "$UI/api/health" || fail "the preview proxy does not reach the API server"

log "creating a project and importing the bundled incident example"
printf '# Pump station outage\n\nThe repair crew was dispatched from the East depot.\n' >"$WORK/incident.md"
request POST /world/projects 201 "$WORK/project.json" \
  -F name="Pump station outage (e2e)" \
  -F prediction_question="Is the incident resolved within two hours?" \
  -F "files=@$WORK/incident.md;type=text/markdown"
PROJECT_ID=$(json "$WORK/project.json" d.project_id)
request GET /examples/incident 200 "$WORK/example.json"
json "$WORK/example.json" d.world >"$WORK/world.json"
json "$WORK/example.json" d.model >"$WORK/model.json"
request PUT "/world/projects/$PROJECT_ID/world" 200 "$WORK/world-res.json" -H 'content-type: application/json' --data-binary "@$WORK/world.json"
request PUT "/model/projects/$PROJECT_ID/model" 200 "$WORK/model-res.json" -H 'content-type: application/json' --data-binary "@$WORK/model.json"
request POST "/model/projects/$PROJECT_ID/compile" 200 "$WORK/compile.json" -H 'content-type: application/json' --data '{}'
[[ "$(json "$WORK/compile.json" d.ok)" == "true" ]] || fail "compile failed: $(cat "$WORK/compile.json")"

log "forecasting the baseline and the extra_crew intervention"
request POST "/forecast/projects/$PROJECT_ID/forecasts" 201 "$WORK/baseline.json" -H 'content-type: application/json' \
  --data '{"query_kind":"observational","target_entity_id":"ent_incident_001","target_variable":"incident_status","horizon_steps":2,"step_minutes":60,"interventions":[]}'
request POST "/forecast/projects/$PROJECT_ID/forecasts" 201 "$WORK/extra.json" -H 'content-type: application/json' \
  --data '{"scenario_id":"extra_crew","query_kind":"interventional","target_entity_id":"ent_incident_001","target_variable":"incident_status","horizon_steps":2,"step_minutes":60,"interventions":[{"kind":"hard","target_variable":"crew_capacity","value":"high","start_step":0,"end_step_exclusive":2}]}'
P_BASE=$(json "$WORK/extra.json" 'd.baseline.by_horizon[1].distribution.find(e => e.value === "resolved").probability')
P_EXTRA=$(json "$WORK/extra.json" 'd.intervention.by_horizon[1].distribution.find(e => e.value === "resolved").probability')
log "P(resolved at step 2): baseline $P_BASE, extra_crew $P_EXTRA"
node -e 'const [b, x] = process.argv.slice(1).map(Number); if (Math.abs(b - 0.25) > 1e-12 || Math.abs(x - 0.63) > 1e-12) process.exit(1);' "$P_BASE" "$P_EXTRA" \
  || fail "expected 0.25 and 0.63"

log "running a synthetic backtest (simulated data; a software-pipeline check)"
request POST "/forecast/projects/$PROJECT_ID/backtests" 201 "$WORK/backtest.json" -H 'content-type: application/json' \
  --data '{"episodes":200,"seed":1,"origins":4,"horizons":[1,2,3]}'
log "backtest gate: $(json "$WORK/backtest.json" '`${d.gate.candidate} vs ${d.gate.comparator}: accepted=${d.gate.accepted} (${d.gate.reason})`')"

request GET "/world/projects/$PROJECT_ID" 200 "$WORK/project-now.json"
[[ "$(json "$WORK/project-now.json" d.last_compile_ok)" == "true" ]] || fail "project does not show a successful compile"

log "taking screenshots"
SHOTS=()
for step in 1 3 4; do
  shot="$SHOT_DIR/n10-step${step}.png"
  rm -f "$shot"
  "$CHROME" --no-sandbox --hide-scrollbars --window-size=1280,2400 --virtual-time-budget=8000 \
    --screenshot="$shot" "$UI/process/$PROJECT_ID?step=$step" >"$WORK/chrome-step${step}.log" 2>&1 \
    || { cat "$WORK/chrome-step${step}.log"; fail "screenshot of step $step failed"; }
  [[ -s "$shot" ]] || fail "no screenshot written for step $step"
  SHOTS+=("$shot")
done
# Step 4 in full height: the synthetic backtest panel sits below the first 2400 px.
shot="$SHOT_DIR/n10-step4-full.png"
rm -f "$shot"
"$CHROME" --no-sandbox --hide-scrollbars --window-size=1280,5600 --virtual-time-budget=8000 \
  --screenshot="$shot" "$UI/process/$PROJECT_ID?step=4" >"$WORK/chrome-step4-full.log" 2>&1 \
  || { cat "$WORK/chrome-step4-full.log"; fail "full-height screenshot of step 4 failed"; }
[[ -s "$shot" ]] || fail "no full-height screenshot written for step 4"
SHOTS+=("$shot")

log "screenshots:"
for shot in "${SHOTS[@]}"; do printf '  %s\n' "$shot"; done
printf 'project_id=%s\n' "$PROJECT_ID"
