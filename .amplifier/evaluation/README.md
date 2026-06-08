# NanoClaw evaluation harness

Evaluates NanoClaw (the personal-assistant app in this repo) against
[amplifier-benchmark](https://github.com/microsoft/amplifier-bundle-evaluation)
tasks, reusing the `amplifier-evaluation` library building blocks (AIUser,
Extractor, Grader, DTU).

## What it does

NanoClaw is a conversational assistant that runs the agent inside a Docker
container, so it needs a heavyweight DTU profile (Docker-in-Incus, 16GiB). The
stock library model (generic task DTU + lightweight agent install) cannot express
that, so the **DTU profile is the agent**. Per task, the harness:

1. Launches a fresh DTU from `../digital-twin-universe/profiles/nanoclaw-claude.yaml`.
2. Discovers NanoClaw's agent-group working dir (`groups/cli-with-dtu-user/`).
3. Seeds the task's `workspace/` inputs into that dir.
4. Drives NanoClaw one chat turn at a time via the library `AIUser`
   (`pnpm run chat`), polling the deliverable instead of trusting chat-return.
5. Harvests the working dir into `/workspace` so the task's own `grader.yaml`
   steps work unchanged.
6. Extracts artifacts (`Extractor`) and grades (`Grader`).
7. Destroys the DTU.

One fresh DTU per task (stale-deliverable guard).

## Layout

    agents/nanoclaw-claude/   the agent under test (the DTU profile + how to drive it)
      meta.yaml               profile path, drive user, nanoclaw paths
      invocation.md           how the AIUser should talk to NanoClaw
      data.yaml               what the Extractor should pull
    harness.py                the custom harness (launch -> drive -> harvest -> grade)
    run.sh                    preflight + run wrapper

Tasks are NOT vendored here; they are loaded from the amplifier-benchmark repo.

## Running

    bash run.sh

Starter set (easy / conversational benchmark tasks):
`arxiv_conclusion_extraction`, `pdf-hr-q2`, `cpsc_recall_monitor`.

Overrides (environment variables):

    TASK_IDS=arxiv_conclusion_extraction bash run.sh      # one task (smoke test)
    EVAL_BUNDLE=/path/to/amplifier-bundle-evaluation bash run.sh
    TASKS_DIR=/path/to/amplifier-benchmark/tasks bash run.sh

Requires `amplifier-digital-twin`, `incus`, the `amplifier-bundle-evaluation`
venv (for `import amplifier_evaluation`), and `ANTHROPIC_API_KEY`
(read from `~/.amplifier/keys.env` if unset).

## Output

Run output goes to `.amplifier/evaluation/nanoclaw/<UTC>/` in the workspace root
(gitignored), not into this repo. Each task gets `run.json`, `ai_user.json`,
`extraction/`, and `grader/`; the run root gets `summary.json` and `harness.log`.
This output can contain keys, prompts, and responses, so it must not be source
controlled.
