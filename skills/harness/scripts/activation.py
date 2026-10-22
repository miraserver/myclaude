#!/usr/bin/env python3
"""Explicit user-local authorization for the harness skill's init/run flow."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hooks"))
from _harness_common import activate_harness, deactivate_harness


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("activate", "deactivate"))
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "activate":
            activate_harness(args.root)
        else:
            deactivate_harness(args.root)
    except Exception as exc:
        print(f"harness activation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
