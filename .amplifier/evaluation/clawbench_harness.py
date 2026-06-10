#!/usr/bin/env python3
"""NanoClaw evaluation harness for Claw Bench tasks.

Claw Bench (https://github.com/claw-bench/claw-bench) tasks are NOT vendored into
this repo. Only an answer-free reference (tasks-clawbench/<id>.yaml) is committed.
At run time we drive NanoClaw against a task fetched fresh from the benchmark and
grade it with the benchmark's OWN verifier, so the score matches upstream exactly.

Pipeline per task (one FRESH DTU each, like harness.py):
  1. Load the committed answer-free reference (source repo, ref, task path).
  2. From the already-fetched claw-bench clone, build the agent-facing instruction
     and seed inputs (running the task's environment/setup.sh, as the benchmark does).
  3. Launch the NanoClaw DTU, seed inputs, drive it via AIUser, harvest its output.
  4. Pull the harvested workspace to the host and grade with claw-bench's verifier
     (run by a dedicated grading venv via grade_clawbench.py) -> weighted score.

The DTU lifecycle / seed / drive / harvest steps reuse harness.py unchanged. Only
task loading and grading differ (claw-bench pytest verifier vs the library grader),
so this lives in a sibling harness rather than branching the benchmark one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import yaml

from amplifier_evaluation.ai_user import AIUser
from amplifier_evaluation.harness.dtu import DTU

# Reuse the benchmark harness's DTU plumbing verbatim.
from harness import (
    AgentDef,
    discover_group_dir,
    dtu_name,
    log,
    now_iso,
    seed_workspace,
    wait_ready,
)


@dataclass
class ClawTask:
    """A Claw Bench task resolved against a local clone.

    Duck-typed to what harness.seed_workspace / AIUser.run need: `instructions`,
    `timeout_s`, and `workspace_dir` (a host dir of seed input files).
    """

    id: str
    instructions: str
    timeout_s: int
    workspace_dir: Path  # host dir of seed inputs to push into the agent
    task_dir: Path  # the claw-bench task dir inside the clone (for grading)


def locate_workdir(pulled_root: Path, seeded_names: list[str]) -> Path:
    """Find, on the host, the directory where NanoClaw actually worked.

    NanoClaw's deliverable lands at a nondeterministic nesting depth: sometimes the
    agent-group root, sometimes a nested container subdir. Pointing the verifier at
    the wrong level makes it miss the output entirely. The reliable anchor is the
    seeded input files - the agent reads and writes where its inputs are. So pick
    the deepest directory in the pulled tree that contains all seeded inputs; if
    there are no seeded inputs (or none match), fall back to the deepest directory
    that contains any regular file, else the pulled root.
    """
    all_dirs = [pulled_root, *[p for p in pulled_root.rglob("*") if p.is_dir()]]

    def _depth(p: Path) -> int:
        return len(p.parts)

    with_inputs: list[Path] = []
    deepest_with_files: Path | None = None
    for d in all_dirs:
        names = {f.name for f in d.iterdir() if f.is_file()}
        if names and (
            deepest_with_files is None or _depth(d) > _depth(deepest_with_files)
        ):
            deepest_with_files = d
        if seeded_names and all(n in names for n in seeded_names):
            with_inputs.append(d)
    if with_inputs:
        return max(with_inputs, key=_depth)
    return deepest_with_files or pulled_root


def _rewrite_instruction(instruction_md: str) -> str:
    """Make instruction paths match where NanoClaw actually works.

    Claw Bench instructions reference inputs/outputs under `workspace/` (the
    benchmark rewrites that to an absolute path). NanoClaw instead works in its
    agent-group directory and we seed inputs there flat, so drop the `workspace/`
    prefix: `workspace/sample.csv` -> `sample.csv`, written to the cwd.
    """
    return instruction_md.replace("workspace/", "")


def build_claw_task(ref_path: Path, clone_root: Path, scratch_dir: Path) -> ClawTask:
    """Resolve a committed task reference into a runnable ClawTask.

    Seeds inputs exactly as the benchmark does: run environment/setup.sh against a
    fresh workspace if present, else copy environment/data/*.
    """
    ref = yaml.safe_load(ref_path.read_text())
    task_path = ref["task_path"]
    task_dir = (clone_root / task_path).resolve()
    if not task_dir.is_dir():
        raise FileNotFoundError(
            f"claw-bench task not found in clone: {task_dir} "
            f"(ref {ref_path.name}, repo {ref.get('source_repo')}@{ref.get('ref')})"
        )

    instruction_path = task_dir / "instruction.md"
    if not instruction_path.is_file():
        raise FileNotFoundError(f"instruction.md missing: {instruction_path}")
    instructions = _rewrite_instruction(instruction_path.read_text())

    # Build the seed-input set the same way claw-bench's runner does.
    seed_dir = scratch_dir / "seed"
    if seed_dir.exists():
        shutil.rmtree(seed_dir)
    seed_dir.mkdir(parents=True, exist_ok=True)

    setup_sh = task_dir / "environment" / "setup.sh"
    data_dir = task_dir / "environment" / "data"
    if setup_sh.is_file():
        subprocess.run(
            ["bash", str(setup_sh), str(seed_dir.resolve())],
            cwd=str(task_dir),
            capture_output=True,
            timeout=60,
        )
    elif data_dir.is_dir():
        for f in sorted(data_dir.iterdir()):
            if f.is_file():
                shutil.copy2(f, seed_dir / f.name)

    task_id = str(ref.get("id", ref_path.stem))
    timeout_s = int(ref.get("drive_timeout_s", 1200))
    return ClawTask(
        id=task_id,
        instructions=instructions,
        timeout_s=timeout_s,
        workspace_dir=seed_dir,
        task_dir=task_dir,
    )


def grade(
    claw_python: Path, grader_script: Path, task_dir: Path, workspace: Path
) -> dict:
    """Grade a harvested workspace with claw-bench's own verifier.

    Runs grade_clawbench.py with the grading venv's python (which has claw_bench +
    pytest + pytest-json-report), so scoring is identical to the benchmark.
    """
    proc = subprocess.run(
        [
            str(claw_python),
            str(grader_script),
            "--task-dir",
            str(task_dir),
            "--workspace",
            str(workspace),
        ],
        capture_output=True,
        text=True,
        timeout=360,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"grading failed (exit {proc.returncode}): "
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    # The grader prints one JSON object on its last stdout line.
    last = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    return json.loads(last)


async def run_task(
    agent: AgentDef,
    ref_path: Path,
    clone_root: Path,
    out_root: Path,
    ai_user: AIUser,
    claw_python: Path,
    grader_script: Path,
    launch_timeout_s: int,
    ready_timeout_s: int,
) -> dict:
    task = build_claw_task(ref_path, clone_root, out_root / ref_path.stem)
    tdir = out_root / task.id
    tdir.mkdir(parents=True, exist_ok=True)
    record: dict = {
        "task_id": task.id,
        "agent": agent.id,
        "profile": str(agent.profile_path),
        "source": "claw-bench",
        "task_path": str(task.task_dir.relative_to(clone_root)),
        "started_at": now_iso(),
        "state": "running",
        "error": None,
    }
    t0 = time.monotonic()
    dtu: DTU | None = None
    try:
        log(f"[{task.id}] launching fresh DTU from {agent.profile_path.name} ...")
        dtu = await DTU.launch(
            agent.profile_path,
            name=dtu_name(task.id),
            variables=agent.launch_vars or None,
            launch_timeout_s=launch_timeout_s,
        )
        record["dtu_id"] = dtu.id
        log(f"[{task.id}] DTU {dtu.id} up; waiting for NanoClaw readiness ...")
        await wait_ready(dtu, agent, ready_timeout_s)

        group_dir = await discover_group_dir(dtu, agent)
        record["group_dir"] = group_dir
        log(f"[{task.id}] agent group dir: {group_dir}")

        seeded = await seed_workspace(dtu, task, group_dir, agent.drive_user)
        record["seeded_files"] = seeded
        log(f"[{task.id}] seeded inputs: {seeded or '(none)'}")

        log(f"[{task.id}] driving NanoClaw via AIUser (timeout {task.timeout_s}s) ...")
        interaction = await asyncio.wait_for(
            ai_user.run(
                scenario=task.instructions,
                dtu_id=dtu.id,
                invocation_guide=agent.invocation_md,
                workspace_dir=group_dir,
            ),
            timeout=task.timeout_s,
        )
        conclude = interaction.conclude
        record["ai_user"] = {
            "verdict": conclude.verdict if conclude else None,
            "summary": conclude.summary if conclude else None,
            "elapsed_s": round(interaction.elapsed_s, 1),
        }
        (tdir / "ai_user.json").write_text(json.dumps(record["ai_user"], indent=2))
        log(
            f"[{task.id}] AIUser concluded: "
            f"{record['ai_user']['verdict']} ({record['ai_user']['elapsed_s']}s)"
        )

        # Pull NanoClaw's whole agent-group dir to the host, then locate the actual
        # working dir within it (its nesting depth varies run to run). claw-bench's
        # verifier runs locally against that dir.
        host_ws = tdir / "workspace"
        if host_ws.exists():
            shutil.rmtree(host_ws)
        log(f"[{task.id}] pulling {group_dir} -> {host_ws} ...")
        await dtu.file_pull(group_dir, host_ws)

        grade_dir = locate_workdir(host_ws, seeded)
        record["grade_dir"] = str(grade_dir)
        log(f"[{task.id}] grading dir (located by seeded inputs): {grade_dir}")

        log(f"[{task.id}] grading with claw-bench verifier ...")
        grade_result = grade(claw_python, grader_script, task.task_dir, grade_dir)
        (tdir / "grader.json").write_text(json.dumps(grade_result, indent=2))
        record["grader"] = grade_result
        # Normalize to the same key the benchmark harness reports.
        score = grade_result.get("weighted_score")
        if score is None:
            total = grade_result.get("checks_total") or 0
            score = (grade_result.get("checks_passed", 0) / total) if total else 0.0
        record["overall_score"] = score
        record["state"] = "completed"
        log(
            f"[{task.id}] DONE overall_score={score:.3f} "
            f"({grade_result.get('checks_passed')}/{grade_result.get('checks_total')} checks)"
        )
    except Exception as exc:  # noqa: BLE001 - record any failure structurally
        record["state"] = "failed"
        record["error"] = f"{type(exc).__name__}: {exc}"
        log(f"[{task.id}] FAILED: {record['error']}")
    finally:
        if dtu is not None:
            log(f"[{task.id}] destroying DTU {dtu.id} ...")
            await dtu.destroy()
        record["finished_at"] = now_iso()
        record["elapsed_s"] = round(time.monotonic() - t0, 1)
        (tdir / "run.json").write_text(json.dumps(record, indent=2))
    return record


async def main_async(args: argparse.Namespace) -> int:
    agent = AgentDef.load(Path(args.agent_dir))
    # Optional profile override: run-clawbench.sh points this at the slim
    # golden-image TASK profile so we reuse a pre-baked image instead of the
    # heavyweight ubuntu provisioning. We override only the launch profile;
    # everything else (drive_user, nanoclaw paths, launch_vars, invocation,
    # data.yaml) still comes from the agent's meta.yaml. This keeps the shared
    # agents/<agent>/meta.yaml untouched (the benchmark harness still uses it).
    if args.profile:
        prof = Path(args.profile).resolve()
        if not prof.exists():
            log(f"FATAL: --profile not found: {prof}")
            return 2
        agent.profile_path = prof
        # The golden image already has provider config baked into .env at bake
        # time, so the slim task profile needs no launch vars.
        agent.launch_vars = {}
    refs_dir = Path(args.task_refs_dir).resolve()
    clone_root = Path(args.clone_root).resolve()
    # Do NOT resolve(): the grading venv's python is a symlink to the base
    # interpreter, and following it escapes the venv (claw_bench becomes
    # unimportable). Keep the path as given (run-clawbench.sh passes it absolute).
    claw_python = Path(args.claw_python)
    grader_script = Path(args.grader_script).resolve()
    task_ids = [t.strip() for t in args.task_ids.split(",") if t.strip()]
    out_root = Path(args.output).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    log(f"agent: {agent.id}  profile: {agent.profile_path}")
    log(f"task refs: {refs_dir}")
    log(f"claw clone: {clone_root}")
    log(f"tasks: {task_ids}")
    log(f"output: {out_root}")

    ref_paths: list[Path] = []
    for tid in task_ids:
        rp = refs_dir / f"{tid}.yaml"
        if not rp.is_file():
            log(f"FATAL: task reference not found: {rp}")
            return 2
        ref_paths.append(rp)

    log("setting up eval infra (AIUser) ...")
    ai_user = AIUser()
    await ai_user.setup()
    log("eval infra ready.")

    max_parallel = max(1, args.max_parallel)
    log(f"running {len(ref_paths)} task(s) with max_parallel={max_parallel}")
    sem = asyncio.Semaphore(max_parallel)

    async def guarded(ref_path: Path) -> dict:
        async with sem:
            return await run_task(
                agent,
                ref_path,
                clone_root,
                out_root,
                ai_user,
                claw_python,
                grader_script,
                args.launch_timeout,
                args.ready_timeout,
            )

    results: list[dict] = list(await asyncio.gather(*(guarded(r) for r in ref_paths)))

    summary = {
        "agent": agent.id,
        "profile": str(agent.profile_path),
        "source": "claw-bench",
        "tasks": task_ids,
        "generated_at": now_iso(),
        "results": [
            {
                "task_id": r["task_id"],
                "state": r["state"],
                "overall_score": r.get("overall_score"),
                "checks": (
                    f"{(r.get('grader') or {}).get('checks_passed')}/"
                    f"{(r.get('grader') or {}).get('checks_total')}"
                ),
                "ai_user_verdict": (r.get("ai_user") or {}).get("verdict"),
                "elapsed_s": r.get("elapsed_s"),
                "error": r.get("error"),
            }
            for r in results
        ],
    }
    (out_root / "summary.json").write_text(json.dumps(summary, indent=2))

    log("=== SUMMARY ===")
    for row in summary["results"]:
        score = row["overall_score"]
        score_s = f"{score:.3f}" if isinstance(score, (int, float)) else "n/a"
        log(
            f"  {row['task_id']}: {row['state']} score={score_s} "
            f"checks={row['checks']} verdict={row['ai_user_verdict']}"
        )

    return 0 if all(r["state"] == "completed" for r in results) else 1


def main() -> int:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="NanoClaw Claw Bench evaluation harness")
    p.add_argument("--agent-dir", default=str(here / "agents" / "nanoclaw-claude"))
    p.add_argument(
        "--task-refs-dir",
        default=str(here / "tasks-clawbench"),
        help="dir of committed answer-free task reference yamls",
    )
    p.add_argument(
        "--clone-root", required=True, help="path to the fetched claw-bench clone"
    )
    p.add_argument(
        "--claw-python", required=True, help="python of the claw-bench grading venv"
    )
    p.add_argument("--grader-script", default=str(here / "grade_clawbench.py"))
    p.add_argument(
        "--profile",
        default=None,
        help="override the agent's DTU profile (e.g. the slim golden-image task "
        "profile); when set, launch_vars are dropped since the golden image bakes them",
    )
    p.add_argument("--task-ids", required=True, help="comma-separated task ids to run")
    p.add_argument("--output", required=True, help="run output directory")
    p.add_argument("--launch-timeout", type=int, default=900)
    p.add_argument("--ready-timeout", type=int, default=240)
    p.add_argument("--max-parallel", type=int, default=1)
    args = p.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
