# NanoClaw evaluation harness

Evaluates NanoClaw (the personal-assistant app in this repo) by driving it inside
a Digital Twin Universe and grading what it produces. There are two harnesses, one
per task source:

- `harness.py` / `run.sh` — [amplifier-benchmark](https://github.com/microsoft/amplifier-bundle-evaluation)
  tasks, graded with the library `Grader` (LLM rubric in `grader.yaml`).
- `clawbench_harness.py` / `run-clawbench.sh` — [Claw Bench](https://github.com/claw-bench/claw-bench)
  tasks, graded with Claw Bench's own pytest verifier. See "Claw Bench tasks" below.

Both reuse the same `amplifier-evaluation` building blocks (AIUser, DTU) and the
same DTU-profile-as-agent model; they differ only in where tasks come from and how
they are graded.

## amplifier-benchmark tasks (`run.sh`)

## What it does

NanoClaw is a conversational assistant that runs the agent inside a Docker
container, so it needs a heavyweight DTU profile (Docker-in-Incus, 16GiB). The
stock library model (generic task DTU + lightweight agent install) cannot express
that, so the **DTU profile is the agent**. Per task, the harness:

1. Launches a fresh NanoClaw DTU from the agent's slim task profile
   (`dtu-profiles/<agent>-task.yaml`), which boots a pre-baked local golden image.
2. Discovers NanoClaw's agent-group working dir (`groups/cli-with-dtu-user/`).
3. Seeds the task's `workspace/` inputs into that dir.
4. Drives NanoClaw one chat turn at a time via the library `AIUser`
   (`pnpm run chat`), polling the deliverable instead of trusting chat-return.
5. Harvests the working dir into `/workspace` so the task's own `grader.yaml`
   steps work unchanged.
6. Extracts artifacts (`Extractor`) and grades (`Grader`).
7. Destroys the DTU.

One fresh DTU per task (stale-deliverable guard).

The task profile boots a local golden image baked once from the agent's
`dtu-profiles/<agent>-bake.yaml` (full provisioning plus a registry mirror so the
`node:22-slim` build never hits Docker Hub rate limits). `run.sh` bakes it
automatically on first use; see Running.

## Layout

    agents/<agent>/           an agent under test (the DTU profile + how to drive it)
      meta.yaml               profile path, drive user, nanoclaw paths, launch vars
      invocation.md           how the AIUser should talk to NanoClaw
      data.yaml               what the Extractor should pull
    dtu-profiles/             self-contained DTU profiles, per agent:
      <agent>-bake.yaml       full provisioning, baked once into a local golden image
      <agent>-task.yaml       slim relaunch from the golden image (one per task)
    harness.py                the custom harness (launch -> drive -> harvest -> grade)
    run.sh                    preflight + golden-image bake + run wrapper

Two agents under test: `nanoclaw-claude` (default, Claude Agent SDK backend) and
`nanoclaw-amplifier-agent` (amplifier-agent backend, internal provider Anthropic).
Select with `AGENT=`.

Tasks are NOT vendored here; they are loaded from the amplifier-benchmark repo.

## Running

    bash run.sh

The first run for an agent bakes a reusable local golden image (one-time,
~10-15 min); later runs reuse it and start fast. Re-bake by deleting it:
`incus image delete nanoclaw-golden-<agent>` (e.g. `nanoclaw-golden-claude`).

Default task set (easy / conversational benchmark tasks):
`arxiv_conclusion_extraction`, `pdf-hr-q2`, `cpsc_recall_monitor`,
`chiptune_generator`, `ipo_tracker`, `news_research_tool`,
`code-discrepancy-docs-knack`, `pixel_art_generator`,
`code-discrepancy-docstrings-grasp`, `git_changelog_generator`,
`energy_forecast_new_england`, `style_blender`. Override with `TASK_IDS`.

Overrides (environment variables):

    TASK_IDS=arxiv_conclusion_extraction bash run.sh      # one task (smoke test)
    AGENT=nanoclaw-amplifier-agent bash run.sh            # the amplifier-agent backend
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

## Claw Bench tasks (`run-clawbench.sh`)

[Claw Bench](https://github.com/claw-bench/claw-bench) is an off-the-shelf agent
benchmark. Its tasks are NOT vendored here: the only thing committed is an
answer-free reference per task under `tasks-clawbench/<id>.yaml` (source repo, the
`main` ref it tracks, and the task path). The task content (instructions, input
fixtures, the pytest verifier, expected outputs, and the oracle solution) is
fetched fresh at run time and never committed.

Per task, `clawbench_harness.py`:

1. Clones Claw Bench (tracking `main`) into a gitignored cache outside this repo,
   and builds an isolated grading venv with Claw Bench's own verifier installed.
2. Builds the agent-facing instruction from the fetched `instruction.md` and seeds
   inputs by running the task's `environment/setup.sh`, exactly as the benchmark does.
3. Launches a fresh NanoClaw DTU, seeds inputs, drives it via `AIUser`, and pulls
   NanoClaw's agent-group dir back to the host.
4. Grades with Claw Bench's own `verify_task` (pytest + weighted
   `@pytest.mark.weight(n)` markers), so the score matches upstream. The verifier
   runs against the directory where NanoClaw actually wrote its deliverable, which
   is located on the host by anchoring on the seeded input files (NanoClaw's nesting
   depth varies run to run, so a fixed path would miss the output).

### Running

    bash run-clawbench.sh                                   # default: file-001-csv-to-markdown
    TASK_IDS=file-001-csv-to-markdown bash run-clawbench.sh # pick task refs by name

Same prerequisites as `run.sh`, plus `git` and `uv` (for the clone and grading venv).

### Output

Same location and per-task files as above (`run.json`, `ai_user.json`,
`grader.json`, `summary.json`, `harness.log`), under a `<UTC>-<agent>-clawbench`
run dir. `grader.json` holds the weighted score and per-check pass/fail; the task's
`workspace/` subdir holds the pulled deliverable. The fetched Claw Bench clone and
grading venv live in `.amplifier/evaluation/.clawbench-cache/` in the workspace root
(gitignored), never in this repo.
