//! Raspberry Pi Pico (RP2040), hand-wired to the fixture:
//! GP3 SWS (PIO, via the 1 k), GP2 NRST (open-drain), GP0 UART0 TX -> tag RXD, GP1 UART0 RX <- tag
//! TXD, GP25 LED while a command runs.

use embassy_executor::Spawner;
use embassy_futures::poll_once;
use embassy_rp::flash::{Blocking, Flash};
use embassy_rp::gpio::{Flex, Level, Output, Pull};
use embassy_rp::peripherals::{DMA_CH0, DMA_CH1, PIO0, UART0, USB};
use embassy_rp::pio::{InterruptHandler as PioIrq, Pio};
use embassy_rp::uart::{self, BufferedInterruptHandler, BufferedUart};
use embassy_rp::usb::{Driver, InterruptHandler as UsbIrq};
use embassy_rp::{bind_interrupts, dma};
use static_cell::StaticCell;

use crate::board::Board;
use crate::sws::Sws;

bind_interrupts!(struct Irqs {
    USBCTRL_IRQ => UsbIrq<USB>;
    PIO0_IRQ_0 => PioIrq<PIO0>;
    UART0_IRQ => BufferedInterruptHandler<UART0>;
    DMA_IRQ_0 => dma::InterruptHandler<DMA_CH0>, dma::InterruptHandler<DMA_CH1>;
});

/// Board name in the PING reply and the USB serial number.
pub const BOARD: &str = "rp2040";

/// The Pico's flash size; only the unique-id read uses the flash driver.
const FLASH_SIZE: usize = 2 * 1024 * 1024;
const UART_RX_BUF: usize = 2048;

pub struct Led(Output<'static>);

impl Led {
    pub async fn set(&mut self, on: bool) {
        self.0.set_level(if on { Level::High } else { Level::Low });
    }
}

/// Hardware UART0 with interrupt-driven ring buffers.
pub struct Uart(BufferedUart);

impl Uart {
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize, ()> {
        embedded_io_async::Read::read(&mut self.0, buf).await.map_err(|_| ())
    }

    pub async fn write_all(&mut self, buf: &[u8]) {
        let _ = embedded_io_async::Write::write_all(&mut self.0, buf).await;
    }

    /// Drop everything received so far.
    pub fn clear_rx(&mut self) {
        let mut scratch = [0u8; 64];
        // Bounded: a pending receive error also completes a read, without emptying anything.
        for _ in 0..2 * UART_RX_BUF / scratch.len() {
            if poll_once(self.read(&mut scratch)).is_pending() {
                break;
            }
        }
    }

    /// False, and no change, for a rate outside what the PL011 divider reaches from clk_peri.
    pub fn set_baudrate(&mut self, baud: u32) -> bool {
        if !(300..=3_000_000).contains(&baud) {
            return false;
        }
        self.0.set_baudrate(baud);
        true
    }
}

pub fn init(_spawner: Spawner, sws_baud: u32, uart_baud: u32) -> Board {
    let p = embassy_rp::init(Default::default());
    let led = Led(Output::new(p.PIN_25, Level::Low));

    // NRST: drive low or float, never drive high (the tag has its own, weak, pull-up).
    let mut nrst = Flex::new(p.PIN_2);
    nrst.set_pull(Pull::Up);
    nrst.set_low();
    nrst.set_as_input();

    let Pio { mut common, sm0, sm1, .. } = Pio::new(p.PIO0, Irqs);
    let dma_tx = dma::Channel::new(p.DMA_CH0, Irqs);
    let dma_rx = dma::Channel::new(p.DMA_CH1, Irqs);
    let sws = Sws::new(&mut common, sm0, sm1, p.PIN_3, dma_tx, dma_rx, sws_baud);

    static UART_TX: StaticCell<[u8; 1024]> = StaticCell::new();
    static UART_RX: StaticCell<[u8; UART_RX_BUF]> = StaticCell::new();
    let mut ucfg = uart::Config::default();
    ucfg.baudrate = uart_baud;
    let uart = Uart(BufferedUart::new(
        p.UART0,
        p.PIN_0,
        p.PIN_1,
        Irqs,
        UART_TX.init([0; 1024]),
        UART_RX.init([0; UART_RX_BUF]),
        ucfg,
    ));

    // Before USB starts: the read runs from RAM with interrupts off.
    let mut uid = [0u8; 8];
    Flash::<_, Blocking, FLASH_SIZE>::new_blocking(p.FLASH)
        .blocking_unique_id(&mut uid)
        .expect("flash unique id");

    Board { sws, nrst, led, uart, usb: Driver::new(p.USB, Irqs), uid: u64::from_be_bytes(uid) }
}
