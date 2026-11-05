"""The release bundle ships every Python package folder (tauri.conf.json `bundle.resources`). Phase 6d's
`story/` was left out once, so the Story Editor would have failed in a release build."""

import json
import re
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


def _listed_files(rust_file: str, constant: str) -> list[str]:
    """The paths in a `pub const <constant>: &[&str] = &[...]` list in src-tauri/src/<rust_file>."""
    source = (ROOT / "src-tauri" / "src" / rust_file).read_text(encoding="utf-8")
    match = re.search(rf"const {constant}: &\[&str\] = &\[(.*?)\];", source, re.DOTALL)
    assert match, f"{constant} isn't in {rust_file}"
    return re.findall(r'"([^"]+)"', match.group(1))


def test_every_editor_panel_file_is_bundled() -> None:
    """The installers copy only their listed files from the bundle (premiere_panel.rs, resolve_plugin.rs), so
    each must be a resource, or Install fails in a release build."""
    resources = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["bundle"][
        "resources"
    ]
    wanted = {
        f"../src-premiere-panel/{f}": f"premiere-panel/{f}"
        for f in _listed_files("premiere_panel.rs", "PANEL_FILES")
    }
    wanted |= {
        f"../src-resolve-plugin/{f}": f"resolve-plugin/{f}"
        for f in _listed_files("resolve_plugin.rs", "PLUGIN_FILES")
    }
    missing = sorted(source for source, target in wanted.items() if resources.get(source) != target)
    assert not missing, f"Add these to tauri.conf.json bundle.resources: {missing}"
