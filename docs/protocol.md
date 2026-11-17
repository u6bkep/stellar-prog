# pico-sws host protocol (version 2)

The programmer firmware (`firmware/`) is a USB composite device with two CDC-ACM serial ports.
Hosts are the web UI (`webui/`, Web Serial) and Python scripts (pyserial).

## USB identity

| | |
|---|---|
| VID:PID | `2e8a:000a` |
| Manufacturer / product | `stellar-prog` / `pico-sws` |
| Serial number | `pico-sws-<board>-<uid>`: board `rp2350` or `rp2040`, uid = 16 hex digits, unique per chip |
| Port 0 (interfaces 0+1) | **control**: the framed protocol below |
| Port 1 (interfaces 2+3) | **UART bridge**: raw bytes to/from the tag's RXD/TXD |

`2e8a:000a` is also what any pico-sdk program with USB stdio uses, and the two ports of one
programmer look identical to Web Serial (`getInfo()` only has VID/PID). A host that can't tell the
ports apart opens one, sends `PING`, and treats "no valid reply within 500 ms" as "wrong port".
Valid means status `OK` and data starting with `pico-sws`: a loader running on the tag can answer
bytes sent to the bridge port within milliseconds.

The control port ignores line coding (baud rate) and DTR/RTS. The bridge port sets the tag UART to
the host's baud rate whenever the host changes line coding.

## Framing

All integers are little-endian.

    request:  cmd u8 | addr u32 | len u16 | payload[len]
    reply:    status u8 | len u16 | data[len]

- One reply per request, always. Send the next request only after the reply.
- `len` is at most `MAX_PAYLOAD` = 2048 in both directions.
- A request must arrive without pauses: if a frame is incomplete and nothing arrives for 250 ms,
  the firmware drops the partial frame without replying. A host that connects to a programmer in
  an unknown state waits 300 ms, discards its input, and then sends `PING`.
- A request with `len` > `MAX_PAYLOAD` gets `BAD_LEN`, and the firmware then discards input until
  the port has been idle for 250 ms.

| status | name | data |
|---|---|---|
| 0 | `OK` | per command |
| 1 | `READ_TIMEOUT` | `u16`: index of the first byte the tag did not deliver (SWire `READ` only) |
| 2 | `BAD_CMD` | none |
| 3 | `BAD_LEN` | none: payload length wrong for the command, or over `MAX_PAYLOAD` |
| 4 | `BAD_ARG` | none: `addr` field out of range for the command |

## Commands

| cmd | name | `addr` | payload | reply data |
|---|---|---|---|---|
| 0x00 | `PING` | - | - | ASCII identity string, see below |
| 0x01 | `WRITE` | tag address | bytes to write (1..`MAX_PAYLOAD`) | - |
| 0x02 | `READ` | tag address | `count u16` (1..`MAX_PAYLOAD`) | `count` bytes |
| 0x03 | `CPU_STOP` | - | - | - |
| 0x04 | `CPU_RUN` | - | - | - |
| 0x05 | `ACTIVATE` | ms of CPU-stop hammering after reset | - | - |
| 0x06 | `NRST` | 0 = assert (drive low), 1 = release | - | - |
| 0x07 | `END` | - | - | - |
| 0x08 | `UART_XFER` | `rx_len` (bits 0-15) \| `timeout_ms` (bits 16-31) | bytes to send (0..`MAX_PAYLOAD`) | 0..`rx_len` bytes received |
| 0x09 | `UART_BAUD` | baud rate | - | - |
| 0x0a | `BOOTSEL` | - | - | - |

Commands 0x08-0x0a and the `BAD_ARG` status are new in protocol 2.

**`PING`** replies `pico-sws <protocol> <board> <firmware-version>`, space-separated ASCII, for
example `pico-sws 2 rp2350 v0.1.0`. Protocol-1 firmware replies `pico-sws 1` or
`pico-sws 1 rp2350` (no version field): it lacks `UART_XFER`, `UART_BAUD` and `BOOTSEL`, so the
only way to update it is to hold BOOT while plugging in.

**`WRITE` / `READ` / `CPU_STOP` / `CPU_RUN` / `END`** are Telink SWire transactions on the tag's
SWS pad (line coding: `firmware/src/sws.rs`). `WRITE`/`READ` address the tag's register and SRAM space and
only work while the tag CPU is halted. SWire writes are not acknowledged, so `WRITE` returns `OK`
with no tag present: only a `READ` (`READ_TIMEOUT`) shows that nothing is there. SWire reads run at about 3 kB/s, so a 1 KB `READ` takes
about 0.3 s. `CPU_STOP` writes 0x05 to register 0x602, `CPU_RUN` writes 0x88.

**`ACTIVATE`** resets the tag (NRST low 50 ms) while sending CPU-stop writes, keeps sending them
for `addr` ms after releasing reset, and leaves the CPU halted. The reply comes when the sequence
is done: allow `addr` + 500 ms. 600 ms is the value used on the bench. The slave's bit time is at
its reset default afterwards: write `24e6 / 230400` = 104 to register 0xb2 and read it back before
anything else.

**`NRST`** drives the tag's reset low or releases it. `1` after `0` restarts the tag's own
firmware.

**`UART_XFER`** is one exchange on the tag UART, for a loader running on the tag (pvvx's floader):

1. If the payload is not empty: discard bytes already received from the tag, then send the payload.
2. Collect received bytes until there are `rx_len` of them, or until `timeout_ms` has passed since
   the last payload byte went out.
3. Reply `OK` with the bytes collected. Fewer than `rx_len` bytes is not an error at this level.

`rx_len` = 0 sends without waiting. An empty payload reads without flushing or sending, and its
timeout runs from when the command arrives. Bytes the tag sends beyond `rx_len` stay buffered until
the next exchange with a payload discards them. `rx_len` over `MAX_PAYLOAD` is `BAD_ARG`. The reply
comes at most `timeout_ms` plus the payload's time on the wire after the request: a host allows that
plus a margin for USB. The UART bridge port is paused during the exchange and never sees
its bytes.

**`UART_BAUD`** sets the tag UART rate (8N1). The rate is 230400 after power-up but the bridge
port changes it too, and operating systems probe new serial ports, so a host sets the rate once
before its first `UART_XFER`. A rate the hardware can't produce is `BAD_ARG`.

**`BOOTSEL`** replies `OK`, then 100 ms later reboots the programmer into the RP2040/RP2350 USB
bootloader (PICOBOOT + mass storage, `2e8a:0003` / `2e8a:000f`). The serial ports disappear.

## Firmware version

`firmware/build.rs` takes the version string from the `STELLAR_PROG_VERSION` environment variable
if set (CI passes the release tag), else from `git describe --tags --always --dirty`, else
`CARGO_PKG_VERSION`. It must not contain spaces.
