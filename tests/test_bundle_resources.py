"""The release bundle ships every Python package folder (tauri.conf.json `bundle.resources`). Phase 6d's
`story/` was left out once, so the Story Editor would have failed in a release build."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_every_python_package_folder_is_bundled() -> None:
    resources = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["bundle"][
        "resources"
    ]
    bundled = {Path(source).parent for source in resources if source.endswith("*.py")}
    package_root = ROOT / "src-python"
    folders = {
        Path("..") / path.parent.relative_to(ROOT)
        for path in package_root.rglob("*.py")
        if "__pycache__" not in path.parts and path.parent != package_root
    }
    missing = sorted(str(f) for f in folders - bundled)
    assert not missing, f"Add these to tauri.conf.json bundle.resources: {missing}"
