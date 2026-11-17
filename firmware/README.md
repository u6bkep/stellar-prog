# pico-sws

Telink SWire (SWS) master + tag UART for the Hanshow Stellar-L3N pogo fixture (`../pcb/stellar_prog`).
Host protocol: `../docs/protocol.md`. The SWire line coding is described at the top of `src/sws.rs`.

Two boards, one cargo feature each:

| | `rp2350` | `rp2040` (default) |
|---|---|---|
| Board | Waveshare RP2350-Zero on stellar_prog rev 4 | Raspberry Pi Pico, hand-wired |
| SWS | GP26 (PIO0) -> R1 on the board | GP3 (PIO0) -> 1 kΩ -> SWS |
| NRST (open-drain) | GP29 | GP2 |
| -> tag RXD | GP15, PIO1 UART TX | GP0, UART0 TX |
| <- tag TXD | GP27, PIO1 UART RX | GP1, UART0 RX |
| X1 / X2 | GP14 / GP28, plain inputs behind open JP2 / JP3 | n/c |
| Status LED | WS2812 on GP16 (green) | GP25 |
| USB serial number | `pico-sws-rp2350-<uid>` | `pico-sws-rp2040-<uid>` |

stellar_prog rev 3 and later carry the 1 kΩ on the board (R1). On the RP2350-Zero the tag UART pins
are not a hardware UART TX/RX pair, hence the PIO UART (`src/pio_uart.rs`).

USB: `2e8a:000a`, product `pico-sws`, two CDC-ACM ports. On Linux they appear under
`/dev/serial/by-id/usb-stellar-prog_pico-sws_pico-sws-<board>-<uid>`: `-if00` is the control port,
`-if02` the raw UART bridge (230400 8N1, follows the host's line coding). The web UI and
`UART_XFER` only need the control port.

## Build

Rust with the `thumbv6m-none-eabi` and `thumbv8m.main-none-eabihf` targets. Embassy comes from the
`computer-whisperer/embassy` fork; `Cargo.lock` pins the revision.

    # RP2350-Zero
    cargo build --release --target thumbv8m.main-none-eabihf --no-default-features --features rp2350
    # RP2040 Pico
    cargo build --release --target thumbv6m-none-eabi

The ELF is `target/<target>/release/pico-sws`. The version that `PING` reports comes from
`STELLAR_PROG_VERSION`, else `git describe` (`build.rs`).

## Flash

A programmer already running protocol 2 reboots into its USB bootloader on the `BOOTSEL` command
(the web UI's update button does this). Otherwise hold BOOT while plugging in. Then:

    picotool load -f -x target/thumbv8m.main-none-eabihf/release/pico-sws -t elf

or over SWD, which also streams the defmt log:

    probe-rs run --chip RP2040 --probe <sel> target/thumbv6m-none-eabi/release/pico-sws

The RP2350-Zero's SWD is not on its castellations: the Waveshare schematic has a separate three-pad
footprint (SWD1: SWCLK, GND, SWDIO).
