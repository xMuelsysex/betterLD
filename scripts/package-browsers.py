#!/usr/bin/env python3
"""Create browser ZIPs from the fixed package using Python's standard library."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "dist" / "betterLD"
manifest = json.loads((PACKAGE / "manifest.json").read_text(encoding="utf-8"))
# 以当前源码清单为准，避免把固定目录中已撤回的旧文件装回归档。
files = [Path("betterld.config.js")]
files += sorted(path.relative_to(ROOT) for path in (ROOT / "src").rglob("*") if path.is_file())

for browser in ("chrome", "firefox"):
    browser_manifest = json.loads(json.dumps(manifest))
    if browser == "chrome":
        del browser_manifest["background"]["scripts"]
        del browser_manifest["browser_specific_settings"]
    else:
        del browser_manifest["background"]["service_worker"]

    output = ROOT / "dist" / f"betterLD-{browser}.zip"
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(browser_manifest, ensure_ascii=False, indent=2) + "\n",
        )
        for relative_path in files:
            archive.write(PACKAGE / relative_path, relative_path.as_posix())
    print(f"Packaged {browser}: {output.relative_to(ROOT)} (version {manifest['version']})")
