#!/usr/bin/env bash
# Run the NanoClaw evaluation harness.
#
# Launches a fresh NanoClaw DTU per task, drives it via the amplifier-evaluation
# AIUser, harvests its output, and grades each task with the library Grader.
#
# Captured run output (keys, prompts, responses, paths) is NOT source controlled.
# It lands in the workspace at .amplifier/evaluation/nanoclaw/<UTC>/ (gitignored).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root of amplifier-app-nanoclaw (two levels up from .amplifier/evaluation).
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# Workspace root (the multi-repo parent). Override with WORKSPACE_ROOT if needed.
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd "$REPO_ROOT/.." && pwd)}"

# Where the amplifier-evaluation library + amplifier-benchmark live.
EVAL_BUNDLE="${EVAL_BUNDLE:-$WORKSPACE_ROOT/amplifier-bundle-evaluation}"
TASKS_DIR="${TASKS_DIR:-$EVAL_BUNDLE/amplifier-benchmark/tasks}"
# Starter set: easy / conversational benchmark tasks. Override with TASK_IDS.
TASK_IDS="${TASK_IDS:-arxiv_conclusion_extraction,pdf-hr-q2,cpsc_recall_monitor,chiptune_generator,ipo_tracker,news_research_tool,code-discrepancy-docs-knack,pixel_art_generator,code-discrepancy-docstrings-grasp,git_changelog_generator,energy_forecast_new_england,style_blender}"
# Which agent-under-test to run (a directory under agents/). Override with AGENT.
AGENT="${AGENT:-nanoclaw-claude}"
[ -d "$HERE/agents/$AGENT" ] || { echo "FATAL: agent dir not found: $HERE/agents/$AGENT"; exit 1; }

# Golden image (the fix for Docker Hub 429s + slow per-task provisioning):
# On the FIRST run for an agent, this script bakes a reusable LOCAL Incus image
# from dtu-profiles/<agent>-bake.yaml (full provisioning + a registry mirror so
# the FROM node:22-slim build never hits Docker Hub's rate limit), then
# `incus publish`es it as local:nanoclaw-golden-<agent>. Every task then launches
# from that image via the slim dtu-profiles/<agent>-task.yaml, which only restarts
# services -- no apt/pnpm/docker-build, no Docker Hub pulls. The image stays local
# (nothing is pushed anywhere). Re-bake by deleting it: `incus image delete <name>`.
# The image alias is shared with run-clawbench.sh, so a bake done by either line
# of work is reused by the other (both target the same nanoclaw source).
BAKE_PROFILE="$HERE/dtu-profiles/${AGENT}-bake.yaml"
TASK_PROFILE="$HERE/dtu-profiles/${AGENT}-task.yaml"
GOLDEN_IMAGE="${GOLDEN_IMAGE:-nanoclaw-golden-${AGENT#nanoclaw-}}"
[ -f "$BAKE_PROFILE" ] || { echo "FATAL: bake profile not found: $BAKE_PROFILE"; exit 1; }
[ -f "$TASK_PROFILE" ] || { echo "FATAL: task profile not found: $TASK_PROFILE"; exit 1; }

echo "== preflight =="
command -v amplifier-digital-twin >/dev/null || { echo "FATAL: amplifier-digital-twin not found"; exit 1; }
command -v incus >/dev/null || { echo "FATAL: incus not found"; exit 1; }

# Activate the eval bundle venv so `import amplifier_evaluation` works.
if [ -f "$EVAL_BUNDLE/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  . "$EVAL_BUNDLE/.venv/bin/activate"
fi
python3 -c "import amplifier_evaluation" 2>/dev/null \
  || { echo "FATAL: amplifier_evaluation not importable (set EVAL_BUNDLE to the bundle with a .venv)"; exit 1; }

# Load API keys if not already in the environment.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$HOME/.amplifier/keys.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$HOME/.amplifier/keys.env"; set +a
fi
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "FATAL: ANTHROPIC_API_KEY not set"; exit 1; }

[ -d "$TASKS_DIR" ] || { echo "FATAL: tasks dir not found: $TASKS_DIR"; exit 1; }

# ── Golden image: bake once, reuse forever ───────────────────────────────────
if incus image info "$GOLDEN_IMAGE" >/dev/null 2>&1; then
  echo "== golden image: reusing local:$GOLDEN_IMAGE =="
else
  echo "== golden image: baking local:$GOLDEN_IMAGE (one-time, ~10-15 min) =="
  BUILD="nc-golden-build-${AGENT}"
  incus delete --force "$BUILD" >/dev/null 2>&1 || true

  # Mirror the agent's launch_vars (e.g. INTERNAL_PROVIDER, NANOCLAW_REPO/REF)
  # from meta.yaml so the baked image clones + configures the same source the
  # eval would. claude has none (uses profile defaults).
  mapfile -t VARARGS < <(python3 - "$HERE/agents/$AGENT/meta.yaml" <<'PY'
import sys, yaml
m = yaml.safe_load(open(sys.argv[1])) or {}
for k, v in (m.get("launch_vars") or {}).items():
    print("--var"); print(f"{k}={v}")
PY
)

  # Optional MODEL env var → bake-time --var MODEL=X. Used to pin the
  # agent's model for fair-comparison runs (e.g. claude vs amplifier-agent
  # on claude-opus-4-8). When set:
  #   * claude bake writes ANTHROPIC_MODEL=$MODEL to .env (forwarded into
  #     the agent container by the host-side claude provider)
  #   * amplifier-agent bake configures the agent group with
  #     `--model anthropic:$MODEL` (parsed by the v0.6.0 colon-prefix
  #     parser into host_config.provider.config.default_model)
  # Unset → both agents use their default model selection.
  if [ -n "${MODEL:-}" ]; then
    echo "  pinning agent model to: $MODEL"
    VARARGS+=("--var" "MODEL=$MODEL")
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

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_DIR="${OUTPUT_DIR:-$WORKSPACE_ROOT/.amplifier/evaluation/nanoclaw/${RUN_ID}-${AGENT}}"
mkdir -p "$OUTPUT_DIR"

echo "== nanoclaw evaluation =="
echo "  agent     : $AGENT"
echo "  golden    : local:$GOLDEN_IMAGE (task profile: $(basename "$TASK_PROFILE"))"
echo "  tasks_dir : $TASKS_DIR"
echo "  task_ids  : $TASK_IDS"
echo "  output    : $OUTPUT_DIR"
echo

python3 "$HERE/harness.py" \
  --agent-dir "$HERE/agents/$AGENT" \
  --tasks-dir "$TASKS_DIR" \
  --profile "$TASK_PROFILE" \
  --task-ids "$TASK_IDS" \
  --max-parallel "${MAX_PARALLEL:-1}" \
  --output "$OUTPUT_DIR" 2>&1 | tee "$OUTPUT_DIR/harness.log"
