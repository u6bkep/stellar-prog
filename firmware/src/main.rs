//! pico-sws: Telink SWire master + UART bridge for the Hanshow L3N programmer fixture
//! Two USB CDC-ACM ports, specified in docs/protocol.md:
//!
//! * port 0 (-if00): control. Request `cmd u8, addr u32 LE, len u16 LE, payload[len]`; reply
//!   `status u8, len u16 LE, data[len]`. Commands: see [`proto`].
//! * port 1 (-if02): raw bridge to the tag's RXD/TXD, 230400 8N1 unless the host sets another rate.
//!
//! Two boards, one per cargo feature (pins in each `board_*.rs`):
//! * `rp2040` (default): a Raspberry Pi Pico hand-wired to the fixture.
//! * `rp2350`: a Waveshare RP2350-Zero soldered to stellar_prog rev 4.

#![no_std]
#![no_main]

#[cfg(all(feature = "rp2040", feature = "rp2350"))]
compile_error!("enable exactly one of the rp2040 / rp2350 features");

mod board;
#[cfg_attr(feature = "rp2040", path = "board_rp2040.rs")]
#[cfg_attr(feature = "rp2350", path = "board_rp2350.rs")]
mod chip;
#[cfg(feature = "rp2350")]
mod pio_uart;
mod proto;
mod shared_uart;
mod sws;

use core::fmt::Write as _;

use defmt::info;
use embassy_executor::Spawner;
use embassy_rp::gpio::Flex;
use embassy_rp::peripherals::{PIO0, USB};
use embassy_rp::usb::Driver;
use embassy_usb::class::cdc_acm::{CdcAcmClass, State};
use embassy_usb::UsbDevice;
use static_cell::StaticCell;
use {defmt_rtt as _, panic_probe as _};

use crate::shared_uart::SharedUart;
use crate::sws::Sws;

/// SWire unit rate, as pvvx's UART baud. The host sets the slave's 0xb2 to match.
const SWS_BAUD: u32 = 230_400;
const UART_BAUD: u32 = 230_400;

type UsbDriver = Driver<'static, USB>;

#[embassy_executor::task]
async fn usb_task(mut usb: UsbDevice<'static, UsbDriver>) -> ! {
    usb.run().await
}

#[embassy_executor::task]
async fn bridge_task(uart: &'static SharedUart, class: CdcAcmClass<'static, UsbDriver>) -> ! {
    proto::uart_bridge(uart, class).await
}

#[embassy_executor::task]
async fn control_task(
    sws: Sws<'static, PIO0>,
    nrst: Flex<'static>,
    led: board::Led,
    uart: &'static SharedUart,
    class: CdcAcmClass<'static, UsbDriver>,
) -> ! {
    proto::control(sws, nrst, led, uart, class).await
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let b = board::init(spawner, SWS_BAUD, UART_BAUD);
    info!("boot");

    // pico-sws-<board>-<uid>: fixtures stay apart on one host, and the board name stays greppable
    // in /dev/serial/by-id.
    static SERIAL: StaticCell<heapless::String<40>> = StaticCell::new();
    let serial = SERIAL.init(heapless::String::new());
    write!(serial, "pico-sws-{}-{:016X}", board::BOARD, b.uid).unwrap();

    let mut config = embassy_usb::Config::new(0x2e8a, 0x000a);
    config.manufacturer = Some("stellar-prog");
    config.product = Some("pico-sws");
    config.serial_number = Some(serial.as_str());
    config.max_power = 100;
    config.max_packet_size_0 = 64;

    static CONFIG_DESC: StaticCell<[u8; 256]> = StaticCell::new();
    static BOS_DESC: StaticCell<[u8; 256]> = StaticCell::new();
    // Holds any one descriptor: the serial-number string is 66 bytes (32 UTF-16 characters).
    static CONTROL_BUF: StaticCell<[u8; 256]> = StaticCell::new();
    let mut builder = embassy_usb::Builder::new(
        b.usb,
        config,
        CONFIG_DESC.init([0; 256]),
        BOS_DESC.init([0; 256]),
        &mut [],
        CONTROL_BUF.init([0; 256]),
    );
    static STATE0: StaticCell<State> = StaticCell::new();
    static STATE1: StaticCell<State> = StaticCell::new();
    let ctl = CdcAcmClass::new(&mut builder, STATE0.init(State::new()), 64);
    let brg = CdcAcmClass::new(&mut builder, STATE1.init(State::new()), 64);
    let usb = builder.build();

    static UART: StaticCell<SharedUart> = StaticCell::new();
    let uart = &*UART.init(SharedUart::new(b.uart, UART_BAUD));

    spawner.spawn(usb_task(usb).unwrap());
    spawner.spawn(bridge_task(uart, brg).unwrap());
    spawner.spawn(control_task(b.sws, b.nrst, b.led, uart, ctl).unwrap());
    info!("running");
}
