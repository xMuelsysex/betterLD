#!/usr/bin/env python3
"""Create store upload ZIPs from the fixed unpacked extension; Python stdlib only."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "dist" / "betterLD"
manifest = json.loads((PACKAGE / "manifest.json").read_text(encoding="utf-8"))
files = [PACKAGE / name for name in ("betterld.config.js", "LICENSE", "PRIVACY.md")]
files += sorted(path for path in (PACKAGE / "src").rglob("*") if path.is_file())

for browser in ("chrome", "firefox"):
    store_manifest = json.loads(json.dumps(manifest))
    if browser == "chrome":
        del store_manifest["background"]["scripts"]
        del store_manifest["browser_specific_settings"]
    else:
        del store_manifest["background"]["service_worker"]

    output = ROOT / "dist" / f"betterLD-{browser}.zip"
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(store_manifest, ensure_ascii=False, indent=2) + "\n",
        )
        for path in files:
            archive.write(path, path.relative_to(PACKAGE).as_posix())
    print(f"{browser}: {output.relative_to(ROOT)} (version {manifest['version']})")
