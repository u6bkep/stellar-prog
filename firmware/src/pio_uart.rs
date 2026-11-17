//! 8N1 UART on two PIO state machines, for a TX/RX pin pair that no hardware UART can serve
//! (RP2350-Zero on stellar_prog rev 4: TX GP15, RX GP27).
//!
//! The programs are embassy-rp's `pio_programs::uart` (pico-examples uart_tx / uart_rx, 8 PIO cycles
//! per bit). Two differences from that driver: the baud rate can change at runtime (the bridge
//! follows the host's line coding), and a dedicated task drains received bytes into a 2 KB pipe, so
//! nothing is lost while the bridge waits on USB (the joined RX FIFO holds 8 bytes: 350 us at
//! 230400). One instance per firmware: the pipe and the baud signal are statics.

use embassy_futures::select::{select, Either};
use embassy_rp::clocks::clk_sys_freq;
use embassy_rp::gpio::{Level, Pull};
use embassy_rp::pio::program::pio_asm;
use embassy_rp::pio::{Common, Config, Direction, FifoJoin, Instance, Pin, PioPin, ShiftDirection, StateMachine};
use embassy_rp::Peri;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::pipe::Pipe;
use embassy_sync::signal::Signal;
use fixed::types::extra::U8;
use fixed::FixedU32;

static RX_PIPE: Pipe<CriticalSectionRawMutex, 2048> = Pipe::new();
static RX_BAUD: Signal<CriticalSectionRawMutex, u32> = Signal::new();

/// PIO clock divider for 8 cycles per bit, or None if `baud` is outside what a 16.8 divider can
/// reach (below ~287 baud or above clk_sys / 8).
fn divider(baud: u32) -> Option<FixedU32<U8>> {
    let bits = clk_sys_freq() as u64 * 256 / (8 * baud.max(1) as u64);
    (256..=0xffff_ffff).contains(&bits).then(|| FixedU32::from_bits(bits as u32))
}

/// Bridge side: transmit, the receive pipe, and baud changes for both directions.
pub struct PioUart<'d, P: Instance, const S: usize> {
    tx: StateMachine<'d, P, S>,
    _pin: Pin<'d, P>,
}

/// Receive side, owned by its own task (`run`).
pub struct PioUartRx<'d, P: Instance, const S: usize> {
    sm: StateMachine<'d, P, S>,
    _pin: Pin<'d, P>,
}

pub fn new<'d, P: Instance, const T: usize, const R: usize>(
    common: &mut Common<'d, P>,
    mut tx: StateMachine<'d, P, T>,
    mut rx: StateMachine<'d, P, R>,
    tx_pin: Peri<'d, impl PioPin + 'd>,
    rx_pin: Peri<'d, impl PioPin + 'd>,
    baud: u32,
) -> (PioUart<'d, P, T>, PioUartRx<'d, P, R>) {
    let prg = pio_asm!(
        ".side_set 1 opt",
        "    pull       side 1 [7]", // stop bit, or stall with the line idle high
        "    set x, 7   side 0 [7]", // start bit, 8 cycles
        "bitloop:",
        "    out pins, 1",
        "    jmp x-- bitloop   [6]",
    );
    let loaded = common.load_program(&prg.program);
    let tx_pin = common.make_pio_pin(tx_pin);
    tx.set_pins(Level::High, &[&tx_pin]);
    tx.set_pin_dirs(Direction::Out, &[&tx_pin]);
    let mut cfg = Config::default();
    cfg.set_out_pins(&[&tx_pin]);
    cfg.use_program(&loaded, &[&tx_pin]);
    cfg.shift_out.auto_fill = false;
    cfg.shift_out.direction = ShiftDirection::Right;
    cfg.fifo_join = FifoJoin::TxOnly;
    cfg.clock_divider = divider(baud).expect("UART baud out of PIO divider range");
    tx.set_config(&cfg);
    tx.set_enable(true);

    let prg = pio_asm!(
        "start:",
        "    wait 0 pin 0",        // start bit
        "    set x, 7    [10]",    // to the middle of bit 0 (12 cycles incl. wait, set)
        "rx_bitloop:",
        "    in pins, 1",
        "    jmp x-- rx_bitloop [6]",
        "    jmp pin good_stop",
        "    irq 4 rel",           // framing error / break: flag it, wait for idle, drop the byte
        "    wait 1 pin 0",
        "    jmp start",
        "good_stop:",
        "    in null 24",          // byte to bits 7..0
        "    push",
    );
    let loaded = common.load_program(&prg.program);
    let mut rx_pin = common.make_pio_pin(rx_pin);
    rx_pin.set_pull(Pull::None); // as the hardware UART leaves its RX pad
    rx.set_pin_dirs(Direction::In, &[&rx_pin]);
    let mut cfg = Config::default();
    cfg.use_program(&loaded, &[]);
    cfg.set_in_pins(&[&rx_pin]);
    cfg.set_jmp_pin(&rx_pin);
    cfg.shift_in.auto_fill = false;
    cfg.shift_in.direction = ShiftDirection::Right;
    cfg.shift_in.threshold = 32;
    cfg.fifo_join = FifoJoin::RxOnly;
    cfg.clock_divider = divider(baud).expect("UART baud out of PIO divider range");
    rx.set_config(&cfg);
    rx.set_enable(true);

    (PioUart { tx, _pin: tx_pin }, PioUartRx { sm: rx, _pin: rx_pin })
}

impl<'d, P: Instance, const S: usize> PioUart<'d, P, S> {
    /// Received bytes (at least one).
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize, ()> {
        Ok(RX_PIPE.read(buf).await)
    }

    pub async fn write_all(&mut self, buf: &[u8]) {
        for &b in buf {
            self.tx.tx().wait_push(b as u32).await;
        }
    }

    /// Drop everything received so far.
    pub fn clear_rx(&mut self) {
        RX_PIPE.clear();
    }

    /// Takes effect immediately for TX (a byte in flight is garbled) and as soon as the RX task runs.
    /// False, and no change, for a rate the PIO divider can't reach.
    pub fn set_baudrate(&mut self, baud: u32) -> bool {
        let Some(div) = divider(baud) else {
            defmt::warn!("uart: baud {} out of range, ignored", baud);
            return false;
        };
        self.tx.set_clock_divider(div);
        self.tx.clkdiv_restart();
        RX_BAUD.signal(baud);
        true
    }
}

impl<'d, P: Instance, const S: usize> PioUartRx<'d, P, S> {
    pub async fn run(mut self) -> ! {
        let mut dropped = 0u32;
        loop {
            match select(self.sm.rx().wait_pull(), RX_BAUD.wait()).await {
                Either::First(w) => {
                    if RX_PIPE.try_write(&[w as u8]).is_err() {
                        dropped += 1;
                        if dropped.is_power_of_two() {
                            defmt::warn!("uart rx: pipe full, {} bytes dropped", dropped);
                        }
                    }
                }
                Either::Second(baud) => {
                    let Some(div) = divider(baud) else { continue };
                    self.sm.set_clock_divider(div);
                    self.sm.clkdiv_restart();
                }
            }
        }
    }
}
