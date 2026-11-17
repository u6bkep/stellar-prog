#!/usr/bin/env bash
# Convert the built programmer firmware ELFs to UF2s and merge a combined
# RP2040+RP2350 image. A combined UF2 is a plain concatenation: each block
# carries its family ID and each bootrom ignores foreign-family blocks; the
# web UI filters by family the same way when it writes over PICOBOOT.
#
# Usage: scripts/make-uf2.sh <outdir>
# Expects both release builds to exist (see .github/workflows/release.yml)
# and picotool on PATH. Honours CARGO_TARGET_DIR like cargo does.
set -euo pipefail

out="${1:?usage: make-uf2.sh <outdir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
target="${CARGO_TARGET_DIR:-$root/firmware/target}"
elf2040="$target/thumbv6m-none-eabi/release/pico-sws"
elf2350="$target/thumbv8m.main-none-eabihf/release/pico-sws"

for f in "$elf2040" "$elf2350"; do
    [[ -f $f ]] || { echo "missing $f: build the firmware first" >&2; exit 1; }
done

mkdir -p "$out"
picotool uf2 convert --quiet -t elf "$elf2040" "$out/pico-sws-rp2040.uf2"
picotool uf2 convert --quiet -t elf "$elf2350" "$out/pico-sws-rp2350.uf2"
cat "$out/pico-sws-rp2040.uf2" "$out/pico-sws-rp2350.uf2" > "$out/pico-sws.uf2"

# Check that picotool sees both families in the combined image.
info="$(picotool info -t uf2 "$out/pico-sws.uf2")"
for fam in "'rp2040'" "'rp2350-arm-s'"; do
    grep -q "family ID $fam" <<<"$info" \
        || { echo "combined UF2 is missing family $fam" >&2; exit 1; }
done
echo "wrote $out/{pico-sws-rp2040,pico-sws-rp2350,pico-sws}.uf2"
