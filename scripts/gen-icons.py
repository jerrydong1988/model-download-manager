"""Compatibility entry point for the vector-first icon exporter.

Use npm run icons, or python scripts/gen-icons.py. No application compilation.
"""
from pathlib import Path
import subprocess


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    subprocess.run(["node", str(root / "scripts" / "gen-icons.mjs")], cwd=root, check=True)
