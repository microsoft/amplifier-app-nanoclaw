#!/usr/bin/env python3
"""Grade a harvested workspace with claw-bench's OWN verifier.

This is a thin entrypoint meant to be run by the claw-bench grading venv's python
(the one with `claw_bench` + pytest + pytest-json-report installed). It calls
`claw_bench.core.verifier.verify_task` unchanged, so grading is identical to the
benchmark: it runs `verifier/test_output.py` with pytest and computes the weighted
score from the task's `@pytest.mark.weight(n)` markers.

Emits a single JSON object on stdout for the harness to read.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Grade a workspace with claw-bench's verifier"
    )
    ap.add_argument(
        "--task-dir", required=True, help="claw-bench task dir (in the clone)"
    )
    ap.add_argument(
        "--workspace", required=True, help="host dir with the agent's output files"
    )
    args = ap.parse_args()

    from claw_bench.core.verifier import verify_task

    result = verify_task(Path(args.task_dir), Path(args.workspace))
    print(
        json.dumps(
            {
                "passed": result.passed,
                "checks_total": result.checks_total,
                "checks_passed": result.checks_passed,
                "weighted_score": result.weighted_score,
                "details": result.details,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
