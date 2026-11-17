#!/usr/bin/env bash
# Assemble the static web UI into webui/dist: the site files plus, when
# given, the bundled firmware and webui/dist/firmware/manifest.json.
#
# Usage: webui/build.sh [--programmer <dir>] [--tag-firmware <dir>] [--version <tag>] [--repo <url>]
#   --programmer    output dir of scripts/make-uf2.sh (pico-sws*.uf2)
#   --tag-firmware  output dir of scripts/fetch-tag-firmware.sh
# Without them the page still works: bundled options are disabled and
# user-chosen files can still be written.
#
# Serve locally with e.g.: python3 -m http.server -d webui/dist 8000
# and open http://localhost:8000 (Web Serial needs https or localhost).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/webui/dist"
progdir=""
tagdir=""
version="dev"
repo=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --programmer) progdir="$2"; shift 2 ;;
        --tag-firmware) tagdir="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        --repo) repo="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

rm -rf "$dist"
cp -r "$root/webui/site" "$dist"
mkdir -p "$dist/firmware"

if [[ -n $progdir ]]; then
    for f in pico-sws.uf2 pico-sws-rp2040.uf2 pico-sws-rp2350.uf2; do
        [[ -f $progdir/$f ]] || { echo "missing $progdir/$f" >&2; exit 1; }
        cp "$progdir/$f" "$dist/firmware/"
    done
fi
if [[ -n $tagdir ]]; then
    for f in floader.bin ATC_Paper.bin tag-firmware.json; do
        [[ -f $tagdir/$f ]] || { echo "missing $tagdir/$f" >&2; exit 1; }
    done
    cp "$tagdir/floader.bin" "$tagdir/ATC_Paper.bin" "$dist/firmware/"
fi

python3 - "$dist" "$version" "$repo" "$progdir" "$tagdir" <<'EOF'
import hashlib, json, sys
from pathlib import Path

dist, version, repo, progdir, tagdir = sys.argv[1:6]
fw = Path(dist) / "firmware"

def sha256(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

manifest = {"version": version, "repo": repo or None,
            "programmer": None, "floader": None, "tag_firmware": None}

if progdir:
    manifest["programmer"] = {
        "version": version,
        "uf2": "firmware/pico-sws.uf2",
        "uf2_rp2040": "firmware/pico-sws-rp2040.uf2",
        "uf2_rp2350": "firmware/pico-sws-rp2350.uf2",
    }

if tagdir:
    meta = json.loads((Path(tagdir) / "tag-firmware.json").read_text())
    for key in ("floader", "tag_firmware"):
        entry = dict(meta[key])
        path = fw / entry["file"]
        # The fetch script already checked the pinned hashes; make sure the
        # copied files are the ones it described.
        if sha256(path) != entry["sha256"] or path.stat().st_size != entry["size"]:
            sys.exit(f"{path.name} does not match tag-firmware.json")
        entry["file"] = f"firmware/{entry['file']}"
        manifest[key] = entry

(fw / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
print("manifest: " + ", ".join(f"{k}={'yes' if manifest[k] else 'no'}"
                                for k in ("programmer", "floader", "tag_firmware")))
EOF

echo "site assembled in webui/dist"
