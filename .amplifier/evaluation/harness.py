#!/usr/bin/env python3
"""NanoClaw evaluation harness.

Drives the NanoClaw personal-assistant agent (as a Digital Twin Universe profile)
through amplifier-benchmark tasks and grades the results, reusing the building
blocks from the amplifier-evaluation library (AIUser, Extractor, Grader, DTU).

Unlike the stock library flow, the DTU profile here IS the agent: NanoClaw needs
a heavyweight profile (Docker-in-Incus, 16GiB, full provisioning), which the stock
agent-install model cannot supply. So this harness launches the NanoClaw profile
directly per task, seeds task inputs into NanoClaw's agent-group working directory,
drives it conversationally via AIUser, harvests its output into /workspace so the
task's own grader.yaml steps work unchanged, then extracts and grades.

One FRESH DTU per task (stale-deliverable guard). Output goes to a per-run tree;
nothing here is meant to be source controlled.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import secrets
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import yaml

from amplifier_evaluation.ai_user import AIUser
from amplifier_evaluation.extractor import Extractor
from amplifier_evaluation.grader import Grader
from amplifier_evaluation.harness.dtu import DTU, DTUError
from amplifier_evaluation.harness.loaders import load_task


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def cmd_stdout(result) -> str:
    """Return the command's real stdout.

    `amplifier-digital-twin exec ... -- <cmd>` returns a JSON envelope, and the
    DTU wrapper surfaces that whole envelope as `CommandResult.stdout`. Unwrap it
    to the inner `stdout` field when present, otherwise return the raw text.
    """
    raw = result.stdout
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return raw
    if isinstance(obj, dict) and "stdout" in obj:
        return obj["stdout"]
    return raw


@dataclass
class AgentDef:
    """The NanoClaw agent-under-test, read from agents/<id>/meta.yaml + sidecars."""

    id: str
    dir: Path
    profile_path: Path
    invocation_md: str
    data_yaml_path: Path
    drive_user: str
    nanoclaw_dir: str
    groups_dir: str
    launch_vars: dict[str, str]

    @classmethod
    def load(cls, agent_dir: Path) -> "AgentDef":
        agent_dir = agent_dir.resolve()
        meta = yaml.safe_load((agent_dir / "meta.yaml").read_text())
        profile_path = (agent_dir / meta["profile"]).resolve()
        if not profile_path.exists():
            raise FileNotFoundError(f"DTU profile not found: {profile_path}")
        invocation_md = (agent_dir / "invocation.md").read_text()
        data_yaml_path = agent_dir / "data.yaml"
        return cls(
            id=meta.get("name", agent_dir.name),
            dir=agent_dir,
            profile_path=profile_path,
            invocation_md=invocation_md,
            data_yaml_path=data_yaml_path,
            drive_user=meta.get("drive_user", "nano"),
            nanoclaw_dir=meta.get("nanoclaw_dir", "/home/nano/nanoclaw"),
            groups_dir=meta.get("groups_dir", "/home/nano/nanoclaw/groups"),
            launch_vars={
                str(k): str(v) for k, v in (meta.get("launch_vars") or {}).items()
            },
        )


def dtu_name(task_id: str) -> str:
    safe = re.sub(r"[^a-z0-9-]", "-", task_id.lower()).strip("-")
    return f"nc-eval-{safe}"[:48].strip("-") + "-" + secrets.token_hex(2)


async def wait_ready(dtu: DTU, agent: AgentDef, timeout_s: int) -> None:
    """Poll until the NanoClaw control sockets exist."""
    sock = f"{agent.nanoclaw_dir}/data/cli.sock"
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        r = await dtu.exec_cmd(
            ["bash", "-c", f"test -S {sock} && echo READY || echo NOT"],
            timeout_s=60,
        )
        if "READY" in cmd_stdout(r):
            return
        await asyncio.sleep(5)
    raise DTUError(f"NanoClaw not ready within {timeout_s}s (no {sock})")


async def discover_group_dir(dtu: DTU, agent: AgentDef) -> str:
    """Find NanoClaw's agent-group working directory at runtime."""
    r = await dtu.exec_cmd(
        ["bash", "-c", f"ls -1 {agent.groups_dir} 2>/dev/null"], timeout_s=60
    )
    names = [
        n.strip()
        for n in cmd_stdout(r).splitlines()
        if n.strip() and n.strip() != "global"
    ]
    if not names:
        raise DTUError(f"No agent-group folder under {agent.groups_dir}")
    # Prefer the cli-* group (the chat agent); else first.
    chosen = next((n for n in names if n.startswith("cli-")), names[0])
    return f"{agent.groups_dir}/{chosen}"


async def seed_workspace(dtu: DTU, task, group_dir: str, drive_user: str) -> list[str]:
    """Push task workspace inputs into NanoClaw's working directory."""
    seeded: list[str] = []
    wdir = task.workspace_dir
    if wdir.exists():
        for child in sorted(wdir.iterdir()):
            if child.is_file():
                await dtu.file_push(child, f"{group_dir}/")
                seeded.append(child.name)
            else:
                log(
                    f"  WARNING: skipping non-file workspace entry {child.name} "
                    f"(starter tasks have no directory fixtures)"
                )
    await dtu.exec_cmd(
        ["chown", "-R", f"{drive_user}:{drive_user}", group_dir], timeout_s=120
    )
    return seeded


async def harvest(dtu: DTU, group_dir: str) -> None:
    """Copy NanoClaw's output into /workspace so task grader.yaml steps work."""
    await dtu.exec_cmd(
        [
            "bash",
            "-c",
            f"mkdir -p /workspace && cp -a {group_dir}/. /workspace/ 2>/dev/null || true",
        ],
        timeout_s=120,
    )


async def run_task(
    agent: AgentDef,
    tasks_dir: Path,
    task_id: str,
    out_root: Path,
    ai_user: AIUser,
    extractor: Extractor,
    grader: Grader,
    launch_timeout_s: int,
    ready_timeout_s: int,
) -> dict:
    task = load_task(tasks_dir / task_id)
    tdir = out_root / task_id
    tdir.mkdir(parents=True, exist_ok=True)
    record: dict = {
        "task_id": task_id,
        "agent": agent.id,
        "profile": str(agent.profile_path),
        "launch_vars": agent.launch_vars,
        "started_at": now_iso(),
        "state": "running",
        "error": None,
    }
    t0 = time.monotonic()
    dtu: DTU | None = None
    try:
        vars_note = f" vars={agent.launch_vars}" if agent.launch_vars else ""
        log(
            f"[{task_id}] launching fresh DTU from {agent.profile_path.name}{vars_note} ..."
        )
        dtu = await DTU.launch(
            agent.profile_path,
            name=dtu_name(task_id),
            variables=agent.launch_vars or None,
            launch_timeout_s=launch_timeout_s,
        )
        record["dtu_id"] = dtu.id
        log(f"[{task_id}] DTU {dtu.id} up; waiting for NanoClaw readiness ...")
        await wait_ready(dtu, agent, ready_timeout_s)

        group_dir = await discover_group_dir(dtu, agent)
        record["group_dir"] = group_dir
        log(f"[{task_id}] agent working dir: {group_dir}")

        seeded = await seed_workspace(dtu, task, group_dir, agent.drive_user)
        record["seeded_files"] = seeded
        log(f"[{task_id}] seeded inputs: {seeded or '(none)'}")

        log(f"[{task_id}] driving NanoClaw via AIUser (timeout {task.timeout_s}s) ...")
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
            f"[{task_id}] AIUser concluded: "
            f"{record['ai_user']['verdict']} ({record['ai_user']['elapsed_s']}s)"
        )

        log(f"[{task_id}] harvesting {group_dir} -> /workspace ...")
        await harvest(dtu, group_dir)

        log(f"[{task_id}] extracting artifacts ...")
        await extractor.run(
            dtu_id=dtu.id,
            task_context=task.instructions,
            data_yaml_path=agent.data_yaml_path,
            output_dir=tdir / "extraction",
        )

        log(f"[{task_id}] grading via {task.grader_yaml_path.name} ...")
        grade = await grader.run(
            grader_yaml_path=task.grader_yaml_path,
            task_context=task.instructions,
            dtu_id=dtu.id,
            output_dir=tdir / "grader",
            grader_data_dir=task.grader_data_dir,
        )
        record["grader"] = {
            "overall_score": grade.overall_score,
            "evaluations": [
                {
                    "name": e.name,
                    "weight": e.weight,
                    "score": e.score,
                    "points_awarded": e.points_awarded,
                    "points_possible": e.points_possible,
                }
                for e in grade.evaluations
            ],
        }
        record["state"] = "completed"
        log(f"[{task_id}] DONE overall_score={grade.overall_score:.3f}")
    except Exception as exc:  # noqa: BLE001 - record any failure structurally
        record["state"] = "failed"
        record["error"] = f"{type(exc).__name__}: {exc}"
        log(f"[{task_id}] FAILED: {record['error']}")
    finally:
        if dtu is not None:
            log(f"[{task_id}] destroying DTU {dtu.id} ...")
            await dtu.destroy()
        record["finished_at"] = now_iso()
        record["elapsed_s"] = round(time.monotonic() - t0, 1)
        (tdir / "run.json").write_text(json.dumps(record, indent=2))
    return record


async def main_async(args: argparse.Namespace) -> int:
    agent = AgentDef.load(Path(args.agent_dir))
    # Optional profile override: run.sh points this at the slim golden-image TASK
    # profile so we reuse a pre-baked local Incus image instead of the heavyweight
    # ubuntu provisioning (which re-pulls from Docker Hub every task and hits the
    # anonymous rate limit). We override only the launch profile; everything else
    # (drive_user, nanoclaw paths, invocation, data.yaml) still comes from the
    # agent's meta.yaml, so the shared agents/<agent>/meta.yaml stays untouched.
    if args.profile:
        prof = Path(args.profile).resolve()
        if not prof.exists():
            log(f"FATAL: --profile not found: {prof}")
            return 2
        agent.profile_path = prof
        # The golden image already has provider config (INTERNAL_PROVIDER,
        # NANOCLAW_REPO/REF) baked into .env at bake time, so the slim task
        # profile needs no launch vars.
        agent.launch_vars = {}
    tasks_dir = Path(args.tasks_dir).resolve()
    task_ids = [t.strip() for t in args.task_ids.split(",") if t.strip()]
    out_root = Path(args.output).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    log(f"agent: {agent.id}  profile: {agent.profile_path}")
    log(f"tasks_dir: {tasks_dir}")
    log(f"tasks: {task_ids}")
    log(f"output: {out_root}")

    log("setting up eval infra (AIUser, Extractor, Grader) ...")
    ai_user, extractor, grader = AIUser(), Extractor(), Grader()
    await ai_user.setup()
    await extractor.setup()
    await grader.setup()
    log("eval infra ready.")

    max_parallel = max(1, args.max_parallel)
    log(f"running {len(task_ids)} task(s) with max_parallel={max_parallel}")
    sem = asyncio.Semaphore(max_parallel)

    async def guarded(task_id: str) -> dict:
        async with sem:
            return await run_task(
                agent,
                tasks_dir,
                task_id,
                out_root,
                ai_user,
                extractor,
                grader,
                args.launch_timeout,
                args.ready_timeout,
            )

    # run_task swallows its own exceptions and returns a record, so gather
    # never raises and one failing task does not cancel the others.
    results: list[dict] = list(await asyncio.gather(*(guarded(t) for t in task_ids)))

    summary = {
        "agent": agent.id,
        "profile": str(agent.profile_path),
        "tasks": task_ids,
        "generated_at": now_iso(),
        "results": [
            {
                "task_id": r["task_id"],
                "state": r["state"],
                "overall_score": (r.get("grader") or {}).get("overall_score"),
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
            f"  {row['task_id']}: {row['state']} "
            f"score={score_s} verdict={row['ai_user_verdict']}"
        )

    return 0 if all(r["state"] == "completed" for r in results) else 1


def main() -> int:
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="NanoClaw evaluation harness")
    p.add_argument("--agent-dir", default=str(here / "agents" / "nanoclaw-claude"))
    p.add_argument(
        "--tasks-dir", required=True, help="amplifier-benchmark tasks directory"
    )
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
    p.add_argument(
        "--max-parallel",
        type=int,
        default=1,
        help="number of tasks (each its own DTU) to run concurrently",
    )
    args = p.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
