# stellar-prog

A programmer for Hanshow Stellar-L3N e-ink shelf tags (2.9" black/white/red, Telink TLSR8359,
512 KB flash), and a web page that drives it: back up a tag's stock flash and put custom BLE
firmware on it from the browser, with nothing to install.

| | |
|---|---|
| `pcb/stellar_prog/` | The fixture: a single-sided board with a Waveshare RP2350-Zero and eight pogo pins that land on the tag's programming pads inside the battery compartment |
| `firmware/` | pico-sws, the firmware for the RP2350-Zero (also builds for a hand-wired RP2040 Pico): a Telink SWire master and a tag UART, over USB serial |
| `webui/` | The static web page (Web Serial; WebUSB only to update the programmer) |
| `docs/protocol.md` | The USB protocol between the page and the programmer |
| `scripts/` | UF2 packaging, and fetching/building the third-party tag firmware |

## Using it

Open the published page in a Chromium-based desktop browser, plug in the fixture, and follow the
page: connect, detect the tag, back up, flash. Flashing the BLE firmware overwrites the Hanshow
bootloader, so the backup the page makes you download is the only way back to stock.

A new RP2350-Zero has no firmware: hold BOOT while plugging it in, then use the page's "update
programmer" step, or drag `pico-sws.uf2` from the latest release onto the drive that appears.

## Building

    # programmer firmware (see firmware/README.md)
    (cd firmware && cargo build --release --target thumbv6m-none-eabi)
    (cd firmware && cargo build --release --target thumbv8m.main-none-eabihf --no-default-features --features rp2350)
    scripts/make-uf2.sh dist-fw                # needs picotool

    # floader + tag BLE firmware, from their pinned upstream commits, hash-checked
    scripts/fetch-tag-firmware.sh dist-tag

    # the site
    webui/build.sh --programmer dist-fw --tag-firmware dist-tag --version dev
    python3 -m http.server -d webui/dist 8000  # http://localhost:8000

`webui/build.sh` with no arguments builds a page without bundled firmware; it then works with
files you pick. Tests for the page's protocol and flashing logic run against a simulated
programmer and tag: `node --test --test-concurrency=1 "webui/test/*.test.js"`.

Pushing a `v*` tag runs `.github/workflows/release.yml`: it builds everything above, attaches the
programmer UF2s to a GitHub release, and deploys the page to GitHub Pages (repo setting: Pages
source "GitHub Actions").

## Credits

This project's own work is the fixture, the programmer firmware and the page. The parts that run
on the tag are other people's, fetched at build time and not stored in this repository:

- **floader**, the flash loader that runs from the tag's RAM: pvvx,
  [TlsrComProg825x](https://github.com/pvvx/TlsrComProg825x).
- **The BLE firmware**: atc1441's [ATC_TLSR_Paper](https://github.com/atc1441/ATC_TLSR_Paper),
  in reece15's port to this tag, [stellar-L3N-etag](https://github.com/reece15/stellar-L3N-etag).

The activation sequence (reset while sending CPU-stop) is also pvvx's.
