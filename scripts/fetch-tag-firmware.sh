#!/usr/bin/env bash
# Fetch pvvx's floader.bin and build the Stellar-L3N BLE firmware from pinned
# upstream commits, checking both against known SHA-256 hashes. Neither
# upstream has a licence file, so neither is committed to this repository:
# CI runs this script and bundles the results into the web UI.
#
#   floader.bin     pvvx/TlsrComProg825x, downloaded as-is
#   ATC_Paper.bin   reece15/stellar-L3N-etag (atc1441's ATC_TLSR_Paper ported
#                   to the Stellar-L3N), built from Firmware/ with the tc32
#                   toolchain that repository bundles (x86-64 Linux only)
#
# Usage: scripts/fetch-tag-firmware.sh <outdir> [--etag-src <git clone>] [--floader <file>]
#   --etag-src  build from a local clone of stellar-L3N-etag instead of
#               downloading it (it is cloned to a temp dir, never built in place)
#   --floader   take floader.bin from a local file instead of downloading it
# Writes <outdir>/floader.bin, <outdir>/ATC_Paper.bin and <outdir>/tag-firmware.json
# (provenance, hashes and credits; webui/build.sh puts it into the manifest).
set -euo pipefail

FLOADER_REPO=https://github.com/pvvx/TlsrComProg825x
FLOADER_COMMIT=2de91fe32d6a81786eabbef2ff5f82116d02176e
FLOADER_SHA256=d38e06e9283ad3db9dac883c07be0ea46d30ecd989073f422539de9430d11000

ETAG_REPO=https://github.com/reece15/stellar-L3N-etag
ETAG_COMMIT=f60f8a23c922139ad38f6aff7f25daedb4f7f05d
# The build is reproducible: two independent local builds and CI must all give this.
ETAG_SHA256=7ea78c29af863ae9af092934bf67093ccee7f275bb58e49cd5b21c24505559ee

out=""
etag_src=""
floader_src=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --etag-src) etag_src="$2"; shift 2 ;;
        --floader) floader_src="$2"; shift 2 ;;
        -*) echo "unknown argument: $1" >&2; exit 1 ;;
        *) out="$1"; shift ;;
    esac
done
[[ -n $out ]] || { echo "usage: fetch-tag-firmware.sh <outdir> [--etag-src DIR] [--floader FILE]" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

check() { # file expected-sha256
    local got
    got="$(sha256sum "$1" | cut -d' ' -f1)"
    if [[ $got != "$2" ]]; then
        echo "SHA-256 mismatch for $(basename "$1"):" >&2
        echo "  expected $2" >&2
        echo "  got      $got" >&2
        exit 1
    fi
}

# ---- floader.bin ---------------------------------------------------------------
if [[ -n $floader_src ]]; then
    cp "$floader_src" "$work/floader.bin"
else
    curl -sSfL -o "$work/floader.bin" \
        "https://raw.githubusercontent.com/pvvx/TlsrComProg825x/$FLOADER_COMMIT/floader.bin"
fi
check "$work/floader.bin" "$FLOADER_SHA256"
echo "floader.bin: SHA-256 OK"

# ---- ATC_Paper.bin ---------------------------------------------------------------
src="$work/stellar-L3N-etag"
if [[ -n $etag_src ]]; then
    git clone -q --no-checkout "$etag_src" "$src"
    git -C "$src" checkout -q "$ETAG_COMMIT"
else
    mkdir -p "$src"
    curl -sSfL "https://codeload.github.com/reece15/stellar-L3N-etag/tar.gz/$ETAG_COMMIT" \
        | tar xz -C "$src" --strip-components=1
fi
fw="$src/Firmware"
# Upstream commits a prebuilt ATC_Paper.bin (a different build); make our own.
rm -f "$fw/ATC_Paper.bin"
# The toolchain is committed without exec bits; the makefile's own chmod
# races its compile jobs, so do it up front.
chmod -R u+x "$fw/tc32_linux"
# The makefile runs `python` (to append the CRC32); provide it if only python3 exists.
mkdir -p "$work/bin"
command -v python >/dev/null || ln -s "$(command -v python3)" "$work/bin/python"
echo "building ATC_Paper.bin (stellar-L3N-etag $ETAG_COMMIT)..."
if ! (cd "$fw" && PATH="$work/bin:$PATH" make) > "$work/build.log" 2>&1; then
    tail -40 "$work/build.log" >&2
    echo "tag firmware build failed" >&2
    exit 1
fi
check "$fw/ATC_Paper.bin" "$ETAG_SHA256"
echo "ATC_Paper.bin: SHA-256 OK (reproduced)"

mkdir -p "$out"
cp "$work/floader.bin" "$fw/ATC_Paper.bin" "$out/"
size() { stat -c %s "$1"; }
cat > "$out/tag-firmware.json" <<JSON
{
  "floader": {
    "file": "floader.bin",
    "size": $(size "$out/floader.bin"),
    "sha256": "$FLOADER_SHA256",
    "source": "$FLOADER_REPO",
    "commit": "$FLOADER_COMMIT",
    "credits": [
      {"name": "pvvx", "url": "https://github.com/pvvx", "work": "floader (TlsrComProg825x)", "work_url": "$FLOADER_REPO"}
    ]
  },
  "tag_firmware": {
    "name": "ATC_Paper (stellar-L3N-etag)",
    "file": "ATC_Paper.bin",
    "address": 0,
    "size": $(size "$out/ATC_Paper.bin"),
    "sha256": "$ETAG_SHA256",
    "source": "$ETAG_REPO",
    "commit": "$ETAG_COMMIT",
    "credits": [
      {"name": "atc1441", "url": "https://github.com/atc1441", "work": "ATC_TLSR_Paper", "work_url": "https://github.com/atc1441/ATC_TLSR_Paper"},
      {"name": "reece15", "url": "https://github.com/reece15", "work": "Stellar-L3N port (stellar-L3N-etag)", "work_url": "$ETAG_REPO"}
    ]
  }
}
JSON
echo "wrote $out/{floader.bin,ATC_Paper.bin,tag-firmware.json}"
