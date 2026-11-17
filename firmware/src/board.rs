//! What the chip-specific setup (`chip`: board_rp2040.rs or board_rp2350.rs) hands to the tasks.

use embassy_rp::gpio::Flex;
use embassy_rp::peripherals::{PIO0, USB};
use embassy_rp::usb::Driver;

pub use crate::chip::{init, Led, Uart, BOARD};
use crate::sws::Sws;

pub struct Board {
    /// SWire master on PIO0 SM0/SM1 (both chips).
    pub sws: Sws<'static, PIO0>,
    /// Tag reset: driven low or released, never driven high.
    pub nrst: Flex<'static>,
    /// Lit while a control command runs.
    pub led: Led,
    /// Tag UART for the CDC bridge and UART_XFER: `read`, `write_all`, `clear_rx`, `set_baudrate`.
    pub uart: Uart,
    pub usb: Driver<'static, USB>,
    /// Per-chip unique id, for the USB serial number.
    pub uid: u64,
}
