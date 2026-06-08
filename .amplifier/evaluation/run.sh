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
TASK_IDS="${TASK_IDS:-arxiv_conclusion_extraction,pdf-hr-q2,cpsc_recall_monitor}"
# Which agent-under-test to run (a directory under agents/). Override with AGENT.
AGENT="${AGENT:-nanoclaw-claude}"
[ -d "$HERE/agents/$AGENT" ] || { echo "FATAL: agent dir not found: $HERE/agents/$AGENT"; exit 1; }

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

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_DIR="${OUTPUT_DIR:-$WORKSPACE_ROOT/.amplifier/evaluation/nanoclaw/${RUN_ID}-${AGENT}}"
mkdir -p "$OUTPUT_DIR"

echo "== nanoclaw evaluation =="
echo "  agent     : $AGENT"
echo "  tasks_dir : $TASKS_DIR"
echo "  task_ids  : $TASK_IDS"
echo "  output    : $OUTPUT_DIR"
echo

python3 "$HERE/harness.py" \
  --agent-dir "$HERE/agents/$AGENT" \
  --tasks-dir "$TASKS_DIR" \
  --task-ids "$TASK_IDS" \
  --max-parallel "${MAX_PARALLEL:-1}" \
  --output "$OUTPUT_DIR" 2>&1 | tee "$OUTPUT_DIR/harness.log"
