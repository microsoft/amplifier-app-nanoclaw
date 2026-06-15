#!/usr/bin/env bash
# Run the NanoClaw evaluation harness against Claw Bench tasks.
#
# Claw Bench tasks are NOT vendored. This script fetches the benchmark fresh at
# run time (tracking main), sets up an isolated grading venv that runs the
# benchmark's OWN verifier, then launches a NanoClaw DTU per task, drives it via
# AIUser, harvests its output, and grades it exactly as upstream does.
#
# Golden image (the fix for Docker Hub 429s + slow per-task provisioning):
# On the FIRST run for an agent, this script bakes a reusable LOCAL Incus image
# from dtu-profiles/<agent>-bake.yaml (full provisioning + a registry mirror so
# the FROM node:22-slim build never hits Docker Hub's rate limit), then
# `incus publish`es it as local:nanoclaw-golden-<agent>. Every task then launches
# from that image via the slim dtu-profiles/<agent>-task.yaml, which only restarts
# services -- no apt/pnpm/docker-build, no Docker Hub pulls. The image stays local
# (nothing is pushed anywhere). Re-bake by deleting it: `incus image delete <name>`.
#
# Self-contained: the profiles under dtu-profiles/ are copies; this does NOT touch
# amplifier-app-nanoclaw/.amplifier/digital-twin-universe.
#
# The fetched clone, the grading venv, and all captured run output are gitignored
# and never source controlled.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd "$REPO_ROOT/.." && pwd)}"

# The amplifier-evaluation library (AIUser, DTU) lives here.
EVAL_BUNDLE="${EVAL_BUNDLE:-$WORKSPACE_ROOT/amplifier-bundle-evaluation}"

# Which committed task references to run (tasks-clawbench/<id>.yaml). Override TASK_IDS.
TASK_IDS="${TASK_IDS:-file-001-csv-to-markdown}"
AGENT="${AGENT:-nanoclaw-claude}"
[ -d "$HERE/agents/$AGENT" ] || { echo "FATAL: agent dir not found: $HERE/agents/$AGENT"; exit 1; }

# Self-contained DTU profiles for the golden-image workflow.
BAKE_PROFILE="$HERE/dtu-profiles/${AGENT}-bake.yaml"
TASK_PROFILE="$HERE/dtu-profiles/${AGENT}-task.yaml"
GOLDEN_IMAGE="${GOLDEN_IMAGE:-nanoclaw-golden-${AGENT#nanoclaw-}}"
[ -f "$BAKE_PROFILE" ] || { echo "FATAL: bake profile not found: $BAKE_PROFILE"; exit 1; }
[ -f "$TASK_PROFILE" ] || { echo "FATAL: task profile not found: $TASK_PROFILE"; exit 1; }

# Claw Bench source. Tracking a branch by default (re-fetched each run).
CLAW_REPO="${CLAW_REPO:-https://github.com/claw-bench/claw-bench.git}"
CLAW_REF="${CLAW_REF:-main}"

# Cache for the clone + grading venv, OUTSIDE the nanoclaw repo (never committed).
CACHE_DIR="${CACHE_DIR:-$WORKSPACE_ROOT/.amplifier/evaluation/.clawbench-cache}"
CLONE_DIR="$CACHE_DIR/claw-bench"
CLAW_VENV="$CACHE_DIR/grading-venv"

echo "== preflight =="
command -v amplifier-digital-twin >/dev/null || { echo "FATAL: amplifier-digital-twin not found"; exit 1; }
command -v incus >/dev/null || { echo "FATAL: incus not found"; exit 1; }
command -v git >/dev/null || { echo "FATAL: git not found"; exit 1; }
command -v uv >/dev/null || { echo "FATAL: uv not found"; exit 1; }

# Activate the eval bundle venv so the harness can `import amplifier_evaluation`.
if [ -f "$EVAL_BUNDLE/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  . "$EVAL_BUNDLE/.venv/bin/activate"
fi
python3 -c "import amplifier_evaluation" 2>/dev/null \
  || { echo "FATAL: amplifier_evaluation not importable (set EVAL_BUNDLE to the bundle with a .venv)"; exit 1; }

# Load API keys if not already present.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$HOME/.amplifier/keys.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$HOME/.amplifier/keys.env"; set +a
fi
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "FATAL: ANTHROPIC_API_KEY not set"; exit 1; }

# ── Golden image: bake once, reuse forever ──────────────────────────────────
if incus image info "$GOLDEN_IMAGE" >/dev/null 2>&1; then
  echo "== golden image: reusing local:$GOLDEN_IMAGE =="
else
  echo "== golden image: baking local:$GOLDEN_IMAGE (one-time, ~10-15 min) =="
  BUILD="nc-golden-build-${AGENT}"
  incus delete --force "$BUILD" >/dev/null 2>&1 || true

  # Mirror the agent's launch_vars (e.g. INTERNAL_PROVIDER, NANOCLAW_REPO/REF)
  # from meta.yaml so the baked image clones + configures the same source the
  # eval would. claude has none (uses profile defaults).
  #
  # Uses while-read instead of `mapfile -t` because macOS ships bash 3.2 by
  # default and `mapfile` is bash 4+. Mirrors the fix in run.sh.
  VARARGS=()
  while IFS= read -r line; do
    VARARGS+=("$line")
  done < <(python3 - "$HERE/agents/$AGENT/meta.yaml" <<'PY'
import sys, yaml
m = yaml.safe_load(open(sys.argv[1])) or {}
for k, v in (m.get("launch_vars") or {}).items():
    print("--var"); print(f"{k}={v}")
PY
)

  # Optional MODEL env var → bake-time --var MODEL=X. Mirrors run.sh so claude
  # vs amplifier-agent comparisons can pin both backends to the same underlying
  # model for fair scoring (e.g. MODEL=claude-opus-4-8). When set:
  #   * claude bake writes ANTHROPIC_MODEL=$MODEL to .env (forwarded into the
  #     agent container by the host-side claude provider)
  #   * amplifier-agent bake bakes AMPLIFIER_AGENT_MODEL=$INTERNAL_PROVIDER:$MODEL
  #     into .env (REQUIRED — amplifier-agent has no catalog-default fallback
  #     under the always-explicit model contract)
  # Unset → claude uses SDK default; amplifier-agent bake fails loudly.
  if [ -n "${MODEL:-}" ]; then
    echo "  pinning agent model to: $MODEL"
    VARARGS+=("--var" "MODEL=$MODEL")
  fi

  # Optional NANOCLAW_REF / NANOCLAW_REPO env vars → forwarded as --var so
  # the bake clones a specific branch instead of microsoft/main. Used when
  # validating uncommitted-to-main patches in a real eval. Mirrors run.sh.
  if [ -n "${NANOCLAW_REF:-}" ]; then
    echo "  overriding nanoclaw ref: $NANOCLAW_REF"
    VARARGS+=("--var" "NANOCLAW_REF=$NANOCLAW_REF")
  fi
  if [ -n "${NANOCLAW_REPO:-}" ]; then
    echo "  overriding nanoclaw repo: $NANOCLAW_REPO"
    VARARGS+=("--var" "NANOCLAW_REPO=$NANOCLAW_REPO")
  fi

  # Optional CONTAINER_LOGS env var → bake-time --var CONTAINER_LOGS=X.
  # When set to "enabled", the bake writes NANOCLAW_CONTAINER_LOGS=enabled
  # to /home/nano/nanoclaw/.env so nanoclaw's src/config.ts:51-52 turns on
  # per-instance agent container log persistence. Each spawned agent
  # container then writes its stdout+stderr to
  # logs/containers/<group>/<containerName>.log via inherited file
  # descriptor. Unset → no on-disk container logs (nanoclaw default).
  # Baked into the golden image so every relaunched task inherits it.
  if [ -n "${CONTAINER_LOGS:-}" ]; then
    echo "  enabling container log persistence: $CONTAINER_LOGS"
    VARARGS+=("--var" "CONTAINER_LOGS=$CONTAINER_LOGS")
  fi

  # Clean up the half-baked build container if anything below fails.
  bake_cleanup() { incus delete --force "$BUILD" >/dev/null 2>&1 || true; }
  trap bake_cleanup ERR

  echo "  launching build container $BUILD from $(basename "$BAKE_PROFILE") ${VARARGS[*]:-}"
  amplifier-digital-twin launch --name "$BUILD" "${VARARGS[@]}" "$BAKE_PROFILE"

  echo "  stopping $BUILD for a clean filesystem snapshot ..."
  incus stop "$BUILD"

  echo "  publishing local:$GOLDEN_IMAGE ..."
  incus publish "$BUILD" --alias "$GOLDEN_IMAGE"

  echo "  deleting build container $BUILD ..."
  incus delete --force "$BUILD"
  trap - ERR
  echo "  golden image ready: $(incus image info "$GOLDEN_IMAGE" | awk -F': ' '/Fingerprint/{print $2}' | head -c12)"
fi

echo "== fetch claw-bench ($CLAW_REF) =="
mkdir -p "$CACHE_DIR"
rm -rf "$CLONE_DIR"
git clone --depth 1 --branch "$CLAW_REF" "$CLAW_REPO" "$CLONE_DIR" >/dev/null 2>&1 \
  || { echo "FATAL: failed to clone $CLAW_REPO@$CLAW_REF"; exit 1; }
CLAW_SHA="$(git -C "$CLONE_DIR" rev-parse HEAD)"
echo "  cloned $CLAW_REPO@$CLAW_REF ($CLAW_SHA)"

echo "== grading venv (claw-bench's own verifier) =="
# Isolated venv with claw_bench + pytest + pytest-json-report so grading matches
# upstream exactly. Rebuilt against the fresh clone each run (uv caches wheels).
[ -d "$CLAW_VENV" ] || uv venv "$CLAW_VENV" >/dev/null 2>&1
# shellcheck disable=SC2086
uv pip install --python "$CLAW_VENV/bin/python" -q "$CLONE_DIR" \
  || { echo "FATAL: failed to install claw-bench into grading venv"; exit 1; }
"$CLAW_VENV/bin/python" -c "import claw_bench.core.verifier, pytest_jsonreport" \
  || { echo "FATAL: grading venv missing claw_bench or pytest-json-report"; exit 1; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_DIR="${OUTPUT_DIR:-$WORKSPACE_ROOT/.amplifier/evaluation/nanoclaw/${RUN_ID}-${AGENT}-clawbench}"
mkdir -p "$OUTPUT_DIR"

echo "== nanoclaw claw-bench evaluation =="
echo "  agent     : $AGENT"
echo "  golden    : local:$GOLDEN_IMAGE (task profile: $(basename "$TASK_PROFILE"))"
echo "  task_ids  : $TASK_IDS"
echo "  claw_ref  : $CLAW_REF ($CLAW_SHA)"
echo "  output    : $OUTPUT_DIR"
echo

python3 "$HERE/clawbench_harness.py" \
  --agent-dir "$HERE/agents/$AGENT" \
  --profile "$TASK_PROFILE" \
  --task-refs-dir "$HERE/tasks-clawbench" \
  --clone-root "$CLONE_DIR" \
  --claw-python "$CLAW_VENV/bin/python" \
  --grader-script "$HERE/grade_clawbench.py" \
  --task-ids "$TASK_IDS" \
  --max-parallel "${MAX_PARALLEL:-1}" \
  --output "$OUTPUT_DIR" 2>&1 | tee "$OUTPUT_DIR/harness.log"
