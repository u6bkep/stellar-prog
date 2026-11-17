//! Host protocol on CDC port 0 and the transparent UART bridge on CDC port 1. The protocol is
//! specified in docs/protocol.md; keep the two in step.
//!
//! Control request: `cmd u8, addr u32 LE, len u16 LE, payload[len]`. Reply: `status u8, len u16 LE,
//! data[len]`. Policy stays on the host; the firmware only moves bytes.

use defmt::{info, warn};
use embassy_futures::select::{select4, Either4};
use embassy_rp::gpio::Flex;
use embassy_rp::peripherals::{PIO0, USB};
use embassy_rp::usb::Driver;
use embassy_time::{with_deadline, with_timeout, Duration, Instant, Timer};
use embassy_usb::class::cdc_acm::CdcAcmClass;

use crate::board::{Led, Uart, BOARD};
use crate::shared_uart::SharedUart;
use crate::sws::Sws;

type Cdc = CdcAcmClass<'static, Driver<'static, USB>>;

/// Protocol version, the second word of the PING reply.
const PROTOCOL: &str = "2";
/// Release tag or `git describe` of this build (build.rs), the fourth word of the PING reply.
const FW_VERSION: &str = env!("FW_VERSION");

/// -> `data` = `pico-sws <protocol> <board> <firmware version>`.
pub const CMD_PING: u8 = 0x00;
/// `addr`, `payload` = bytes to write.
pub const CMD_WRITE: u8 = 0x01;
/// `addr`, `payload` = `count u16 LE` -> `data` = the bytes.
pub const CMD_READ: u8 = 0x02;
pub const CMD_CPU_STOP: u8 = 0x03;
pub const CMD_CPU_RUN: u8 = 0x04;
/// `addr` = ms to keep hammering CPU-stop after the reset pulse.
pub const CMD_ACTIVATE: u8 = 0x05;
/// `addr` = 0: assert (drive low), 1: release.
pub const CMD_NRST: u8 = 0x06;
/// Send the SWire end command.
pub const CMD_END: u8 = 0x07;
/// One exchange on the tag UART. `addr` = `rx_len` (bits 0-15) | `timeout_ms` (bits 16-31),
/// `payload` = bytes to send -> `data` = up to `rx_len` bytes received.
pub const CMD_UART_XFER: u8 = 0x08;
/// `addr` = tag UART baud rate.
pub const CMD_UART_BAUD: u8 = 0x09;
/// Reboot the programmer into the USB bootloader, after the reply.
pub const CMD_BOOTSEL: u8 = 0x0a;

pub const ST_OK: u8 = 0;
/// `data` = `u16 LE` index of the first byte the slave did not deliver.
pub const ST_READ_TIMEOUT: u8 = 1;
pub const ST_BAD_CMD: u8 = 2;
/// Payload length wrong for the command, or over `MAX_LEN`.
pub const ST_BAD_LEN: u8 = 3;
/// `addr` out of range for the command.
pub const ST_BAD_ARG: u8 = 4;

const HDR: usize = 7;
/// Largest request payload and reply data. A 1 KB floader read reply is 1030 bytes.
const MAX_LEN: usize = 2048;
/// An incomplete request is dropped when the host goes quiet for this long, so a host that died
/// mid-frame cannot leave the next one out of step.
const FRAME_IDLE: Duration = Duration::from_millis(250);
/// Time between the BOOTSEL reply and the reboot, for the host to collect the reply.
const BOOTSEL_DELAY: Duration = Duration::from_millis(100);

pub async fn control(
    mut sws: Sws<'static, PIO0>,
    mut nrst: Flex<'static>,
    mut led: Led,
    uart: &'static SharedUart,
    mut class: Cdc,
) -> ! {
    let mut req = [0u8; HDR + MAX_LEN];
    let mut resp = [0u8; 3 + MAX_LEN];
    let mut pkt = [0u8; 64];
    loop {
        class.wait_connection().await;
        info!("control: connected");
        let mut fill = 0usize;
        'conn: loop {
            // Gather packets until one whole frame is in `req`.
            let frame_len = loop {
                if fill >= HDR {
                    let len = u16::from_le_bytes([req[5], req[6]]) as usize;
                    if len > MAX_LEN {
                        warn!("control: len {} too large", len);
                        if reply(&mut class, &mut resp, ST_BAD_LEN, 0).await.is_err() {
                            break 'conn;
                        }
                        // The oversized payload is on its way: swallow input until the host stops.
                        loop {
                            match with_timeout(FRAME_IDLE, class.read_packet(&mut pkt)).await {
                                Ok(Ok(_)) => {}
                                Ok(Err(_)) => break 'conn,
                                Err(_) => break,
                            }
                        }
                        fill = 0;
                        continue;
                    }
                    if fill >= HDR + len {
                        break HDR + len;
                    }
                }
                let got = if fill == 0 {
                    class.read_packet(&mut pkt).await.map(Some)
                } else {
                    match with_timeout(FRAME_IDLE, class.read_packet(&mut pkt)).await {
                        Ok(r) => r.map(Some),
                        Err(_) => Ok(None),
                    }
                };
                match got {
                    Ok(Some(n)) => {
                        let n = n.min(req.len() - fill);
                        req[fill..fill + n].copy_from_slice(&pkt[..n]);
                        fill += n;
                    }
                    Ok(None) => {
                        warn!("control: dropped {} bytes of an unfinished request", fill);
                        fill = 0;
                    }
                    Err(_) => break 'conn,
                }
            };
            let cmd = req[0];
            let addr = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
            let payload_len = frame_len - HDR;

            led.set(true).await;
            let mut bootsel = false;
            let (status, out_len) = match cmd {
                CMD_PING => {
                    let mut n = 3;
                    for part in ["pico-sws ", PROTOCOL, " ", BOARD, " ", FW_VERSION] {
                        resp[n..n + part.len()].copy_from_slice(part.as_bytes());
                        n += part.len();
                    }
                    (ST_OK, n - 3)
                }
                CMD_WRITE => {
                    sws.write(addr, &req[HDR..frame_len]).await;
                    (ST_OK, 0)
                }
                CMD_READ => {
                    let count = u16::from_le_bytes([req[HDR], req[HDR + 1]]) as usize;
                    if payload_len != 2 || count > MAX_LEN {
                        (ST_BAD_LEN, 0)
                    } else {
                        match sws.read(addr, &mut resp[3..3 + count]).await {
                            Ok(()) => (ST_OK, count),
                            Err(e) => {
                                resp[3..5].copy_from_slice(&(e.0 as u16).to_le_bytes());
                                (ST_READ_TIMEOUT, 2)
                            }
                        }
                    }
                }
                CMD_CPU_STOP => {
                    sws.cpu_stop().await;
                    (ST_OK, 0)
                }
                CMD_CPU_RUN => {
                    sws.cpu_run().await;
                    (ST_OK, 0)
                }
                CMD_ACTIVATE => {
                    sws.activate(&mut nrst, addr as u64).await;
                    (ST_OK, 0)
                }
                CMD_NRST => {
                    if addr == 0 {
                        nrst.set_as_output();
                    } else {
                        nrst.set_as_input();
                    }
                    (ST_OK, 0)
                }
                CMD_END => {
                    sws.send_end().await;
                    (ST_OK, 0)
                }
                CMD_UART_XFER => {
                    let rx_len = (addr & 0xffff) as usize;
                    let timeout = Duration::from_millis((addr >> 16) as u64);
                    if rx_len > MAX_LEN {
                        (ST_BAD_ARG, 0)
                    } else {
                        let mut u = uart.exclusive().await;
                        let n = uart_xfer(&mut u, uart.baud(), &req[HDR..frame_len], &mut resp[3..3 + rx_len], timeout)
                            .await;
                        (ST_OK, n)
                    }
                }
                CMD_UART_BAUD => {
                    let mut u = uart.exclusive().await;
                    if uart.set_baud(&mut u, addr) {
                        info!("control: uart baud {}", addr);
                        (ST_OK, 0)
                    } else {
                        (ST_BAD_ARG, 0)
                    }
                }
                CMD_BOOTSEL => {
                    bootsel = true;
                    (ST_OK, 0)
                }
                _ => (ST_BAD_CMD, 0),
            };
            led.set(false).await;

            // Drop the consumed frame; keep any bytes of the next one.
            req.copy_within(frame_len..fill, 0);
            fill -= frame_len;
            if reply(&mut class, &mut resp, status, out_len).await.is_err() {
                break 'conn;
            }
            if bootsel {
                info!("control: reboot to the USB bootloader");
                Timer::after(BOOTSEL_DELAY).await;
                embassy_rp::rom_data::reset_to_usb_boot(0, 0);
            }
        }
        info!("control: disconnected");
    }
}

/// One exchange on the tag UART: with something to send, drop what was received before and send
/// it; then collect until `rx` is full or `timeout` has passed since the last byte went out.
/// Returns the number of bytes collected.
async fn uart_xfer(uart: &mut Uart, baud: u32, tx: &[u8], rx: &mut [u8], timeout: Duration) -> usize {
    let mut deadline = Instant::now() + timeout;
    if !tx.is_empty() {
        uart.clear_rx();
        uart.write_all(tx).await;
        // write_all returns once the bytes are queued: the last one leaves up to this much later.
        let on_wire = Duration::from_micros(tx.len() as u64 * 10 * 1_000_000 / baud.max(1) as u64);
        deadline = Instant::now() + on_wire + timeout;
    }
    let mut n = 0;
    // The clock check bounds a run of receive errors (a held-low line), which complete at once.
    while n < rx.len() && Instant::now() < deadline {
        match with_deadline(deadline, uart.read(&mut rx[n..])).await {
            Ok(Ok(k)) => n += k,
            Ok(Err(())) => {}
            Err(_) => break,
        }
    }
    n
}

async fn reply(class: &mut Cdc, resp: &mut [u8], status: u8, len: usize) -> Result<(), ()> {
    resp[0] = status;
    resp[1..3].copy_from_slice(&(len as u16).to_le_bytes());
    let total = 3 + len;
    for chunk in resp[..total].chunks(64) {
        class.write_packet(chunk).await.map_err(|_| ())?;
    }
    if total % 64 == 0 {
        class.write_packet(&[]).await.map_err(|_| ())?;
    }
    Ok(())
}

/// Transparent CDC <-> tag UART copy. Line-coding changes from the host re-rate the UART; DTR is
/// ignored so a host that never raises it still gets its bytes. The bridge is the UART's background
/// user (shared_uart.rs): it gives way to UART_XFER, whose bytes it never sees.
pub async fn uart_bridge(uart: &'static SharedUart, class: Cdc) -> ! {
    let (mut usb_tx, mut usb_rx, control) = class.split_with_control();
    let mut pkt = [0u8; 64];
    let mut ubuf = [0u8; 64];
    loop {
        usb_rx.wait_connection().await;
        info!("bridge: connected");
        loop {
            // Holds the UART only while this arm is pending: any other arm completing drops it.
            let from_tag = async {
                let mut u = uart.background().await;
                u.read(&mut ubuf).await
            };
            match select4(usb_rx.read_packet(&mut pkt), from_tag, control.control_changed(), uart.kicked()).await {
                Either4::First(Ok(n)) => {
                    uart.background().await.write_all(&pkt[..n]).await;
                }
                Either4::First(Err(_)) => break,
                Either4::Second(Ok(n)) => {
                    if usb_tx.write_packet(&ubuf[..n]).await.is_err() {
                        break;
                    }
                }
                Either4::Second(Err(_)) => {}
                Either4::Third(()) => {
                    let rate = control.line_coding().data_rate();
                    if rate != 0 && rate != uart.baud() {
                        let mut u = uart.background().await;
                        if uart.set_baud(&mut u, rate) {
                            info!("bridge: baud {}", rate);
                        }
                    }
                }
                // UART_XFER wants the UART; `from_tag` and its hold are gone, so just go round.
                Either4::Fourth(()) => {}
            }
        }
        info!("bridge: disconnected");
    }
}
