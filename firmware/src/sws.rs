//! Telink SWire (SWS) master on two PIO state machines sharing one GPIO.
//!
//! Line coding (measured on the bench with a logic analyser): a bit slot is 5 units and starts low;
//! 1 = 4 low + 1 high, 0 = 1 low + 4 high. A byte is 10 slots: flag (1 = command), 8 data bits MSB
//! first, trailing 0-slot. Write: `5a a2 a1 a0 00` data... `ff`. Read: `5a a2 a1 a0 80`, then one
//! strobe (master low for one unit, then released) per byte; the slave answers on its own clock
//! with a ~1.6-unit low (merged with the strobe), ~1.7 high, 8 data slots, a 1-unit-low terminator,
//! and idles high until the next strobe. `ff` ends the read.
//!
//! SM0 (TX) consumes two OSR bits per *unit*: level, then direction (1 = drive). Both levels are
//! driven push-pull through the series resistor — a pull-up alone is far too slow (1.8 us rise
//! measured; the tag's own SWS pull-up is 1 M) — and the line is released only where the slave may
//! answer. SM1 (RX) measures every low pulse on the pin in 2-cycle ticks; a read byte is ten pulses
//! (start, 8 bits, terminator) pulled by DMA.

use embassy_futures::select::{select, Either};
use embassy_rp::clocks::clk_sys_freq;
use embassy_rp::dma;
use embassy_rp::gpio::{Flex, Level, Pull};
use embassy_rp::pio::program::pio_asm;
use embassy_rp::pio::{
    Common, Config, Direction, FifoJoin, Instance, Pin, PioPin, ShiftConfig, ShiftDirection, StateMachine,
};
use embassy_rp::Peri;
use embassy_time::{Duration, Instant, Timer};
use fixed::types::extra::U8;
use fixed::FixedU32;
use heapless::Vec;

/// PIO cycles per TX unit (`out pins, 1` + `out pindirs, 1 [6]`).
const UNIT_CYCLES: u32 = 8;

pub const CMD_START: u8 = 0x5a;
pub const CMD_END: u8 = 0xff;
pub const REG_CPU: u32 = 0x0602;
pub const CPU_STOP: u8 = 0x05;
pub const CPU_RUN: u8 = 0x88;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Low,
    High,
    Release,
}

/// Unit-stream builder: two bits per unit (level, drive), LSB first within each word.
pub struct Units<const N: usize> {
    words: Vec<u32, N>,
    len: usize,
}

impl<const N: usize> Units<N> {
    pub const fn new() -> Self {
        Self { words: Vec::new(), len: 0 }
    }

    pub fn clear(&mut self) {
        self.words.clear();
        self.len = 0;
    }

    pub fn unit(&mut self, u: Unit) {
        if self.len % 16 == 0 {
            self.words.push(0).expect("Units buffer full");
        }
        let bits = match u {
            Unit::Low => 0b10,
            Unit::High => 0b11,
            Unit::Release => 0b00,
        };
        *self.words.last_mut().unwrap() |= bits << (2 * (self.len % 16));
        self.len += 1;
    }

    /// Released line (listen window / inter-message idle).
    pub fn idle(&mut self, units: usize) {
        for _ in 0..units {
            self.unit(Unit::Release);
        }
    }

    pub fn slot(&mut self, one: bool) {
        let low = if one { 4 } else { 1 };
        for i in 0..5 {
            self.unit(if i < low { Unit::Low } else { Unit::High });
        }
    }

    pub fn byte(&mut self, cmd: bool, b: u8) {
        self.slot(cmd);
        for i in (0..8).rev() {
            self.slot(b >> i & 1 == 1);
        }
        self.slot(false);
    }

    pub fn end(&mut self) {
        self.byte(true, CMD_END);
    }

    /// `5a aa.aa.aa rw`: start command, 24-bit address, 0x00 write / 0x80 read.
    pub fn header(&mut self, addr: u32, read: bool) {
        self.byte(true, CMD_START);
        self.byte(false, (addr >> 16) as u8);
        self.byte(false, (addr >> 8) as u8);
        self.byte(false, addr as u8);
        self.byte(false, if read { 0x80 } else { 0x00 });
    }

    pub fn write(&mut self, addr: u32, data: &[u8]) {
        self.header(addr, false);
        for &d in data {
            self.byte(false, d);
        }
        self.end();
    }

    pub fn words(&self) -> &[u32] {
        &self.words
    }

}

/// Largest single write (bytes) the scratch stream holds: (5 + 1024 + 1) bytes * 50 units * 2 bits.
pub const MAX_WRITE: usize = 1024;
const SCRATCH_WORDS: usize = ((5 + MAX_WRITE + 1) * 50 + 16) * 2 / 32 + 1; // + the release tail

/// Why a read failed: the slave did not produce a complete byte at this index.
#[derive(Clone, Copy, Debug, defmt::Format)]
pub struct ReadTimeout(pub usize);

pub struct Sws<'d, P: Instance> {
    tx: StateMachine<'d, P, 0>,
    rx: StateMachine<'d, P, 1>,
    _pin: Pin<'d, P>,
    dma_tx: dma::Channel<'d>,
    dma_rx: dma::Channel<'d>,
    units: Units<SCRATCH_WORDS>,
    /// Width (RX ticks) above which a data slot's low is a 1 (0: ~4.2 us, 1: ~17 us).
    one_ticks: u32,
    /// Longest wait for the ten pulses of one byte (a byte is ~190 us at the default rate).
    byte_timeout: Duration,
}

impl<'d, P: Instance> Sws<'d, P> {
    /// `baud` is the unit rate (pvvx's UART baud); the slave's reg 0xb2 must be set to match.
    pub fn new(
        common: &mut Common<'d, P>,
        mut tx: StateMachine<'d, P, 0>,
        mut rx: StateMachine<'d, P, 1>,
        pin: Peri<'d, impl PioPin + 'd>,
        dma_tx: dma::Channel<'d>,
        dma_rx: dma::Channel<'d>,
        baud: u32,
    ) -> Self {
        let pin = common.make_pio_pin(pin);
        // Keep the tag's weak pull-up company while the line is released.
        let mut pin = pin;
        pin.set_pull(Pull::Up);
        tx.set_pins(Level::Low, &[&pin]);
        tx.set_pin_dirs(Direction::In, &[&pin]);

        let prg = pio_asm!(".wrap_target", "out pins, 1", "out pindirs, 1 [6]", ".wrap");
        let loaded = common.load_program(&prg.program);
        let mut cfg = Config::default();
        cfg.use_program(&loaded, &[]);
        cfg.set_out_pins(&[&pin]);
        cfg.set_set_pins(&[&pin]);
        cfg.shift_out = ShiftConfig { threshold: 32, direction: ShiftDirection::Right, auto_fill: true };
        cfg.fifo_join = FifoJoin::TxOnly;
        let div_bits = clk_sys_freq() as u64 * 256 / (baud as u64 * UNIT_CYCLES as u64);
        cfg.clock_divider = FixedU32::<U8>::from_bits(div_bits as u32);
        tx.set_config(&cfg);
        tx.set_enable(true);

        // Low-pulse timer: X counts down two cycles per step while the pin is low.
        let prg = pio_asm!(
            ".wrap_target",
            "    wait 0 pin 0",
            "    set x, 0",
            "    mov x, ~x",
            "count:",
            "    jmp pin done",
            "    jmp x-- count",
            "done:",
            "    mov isr, ~x",
            "    push",
            ".wrap",
        );
        let loaded = common.load_program(&prg.program);
        let mut cfg = Config::default();
        cfg.use_program(&loaded, &[]);
        cfg.set_in_pins(&[&pin]);
        cfg.set_jmp_pin(&pin);
        cfg.fifo_join = FifoJoin::RxOnly;
        rx.set_config(&cfg);
        rx.set_enable(false);

        let unit_ns = 1_000_000_000 / baud;
        // RX tick = 2 PIO cycles at clkdiv 1 (16 ns on the RP2040 at 125 MHz, 13.3 ns on the RP2350
        // at 150 MHz); threshold = 2.5 units in ticks.
        let one_ticks = (clk_sys_freq() as u64 * 5 / (4 * baud as u64)) as u32;
        Self {
            tx,
            rx,
            _pin: pin,
            dma_tx,
            dma_rx,
            units: Units::new(),
            one_ticks,
            byte_timeout: Duration::from_micros(unit_ns as u64 * 80 / 1000),
        }
    }

    /// Queue the scratch stream. Returns when DMA has filled the FIFO with the last word, i.e. up to
    /// 4 words (64 units) before the line actually goes idle.
    async fn flush(&mut self) {
        self.units.idle(16); // never leave the line driven by whatever the last word's padding was
        self.tx.tx().dma_push(&mut self.dma_tx, self.units.words(), false).await;
    }

    /// Wait until the TX FIFO has drained and the OSR's last word (16 units) has played out.
    async fn drain(&mut self) {
        while !self.tx.tx().empty() {
            Timer::after_micros(20).await;
        }
        Timer::after_micros(100).await;
    }

    pub async fn send_end(&mut self) {
        self.units.clear();
        self.units.end();
        self.flush().await;
    }

    pub async fn write(&mut self, addr: u32, data: &[u8]) {
        for (i, chunk) in data.chunks(MAX_WRITE).enumerate() {
            self.units.clear();
            self.units.write(addr + (i * MAX_WRITE) as u32, chunk);
            self.flush().await;
        }
    }

    pub async fn cpu_stop(&mut self) {
        self.write(REG_CPU, &[CPU_STOP]).await;
    }

    pub async fn cpu_run(&mut self) {
        self.write(REG_CPU, &[CPU_RUN]).await;
    }

    /// pvvx's activation (TlsrComProg.py): CPU-stop blocks around and after a reset
    /// pulse so the stop lands before the stock firmware starts. Leaves the CPU halted.
    pub async fn activate(&mut self, nrst: &mut Flex<'_>, tact_ms: u64) {
        self.units.clear();
        self.units.end();
        self.units.write(REG_CPU, &[CPU_STOP]);
        self.flush().await;
        nrst.set_as_output(); // low
        Timer::after_millis(50).await;
        self.units.clear();
        for _ in 0..8 {
            self.units.write(REG_CPU, &[CPU_STOP]);
        }
        self.flush().await;
        nrst.set_as_input(); // release
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_millis(tact_ms) {
            self.flush().await;
        }
        self.drain().await;
        Timer::after_millis(10).await;
        // Resync after the hammering: the v0 bench sequence sent an end command here too.
        self.send_end().await;
    }

    /// Capture `w.len()` low pulses on the pin (RX SM + DMA) while the scratch stream plays.
    async fn capture(&mut self, w: &mut [u32], timeout: Duration) -> bool {
        // The previous stream (e.g. a write that preceded this read) may still be playing.
        self.drain().await;
        self.rx.restart();
        self.rx.clear_fifos();
        self.rx.set_enable(true);
        let rx = self.rx.rx().dma_pull(&mut self.dma_rx, w, false);
        self.units.idle(16);
        let tx = self.tx.tx().dma_push(&mut self.dma_tx, self.units.words(), false);
        tx.await;
        let got = matches!(select(rx, Timer::after(timeout)).await, Either::First(_));
        self.rx.set_enable(false);
        got
    }

    /// `w` = [start, b7 .. b0, terminator] low-pulse widths in RX ticks.
    fn decode(&self, w: &[u32]) -> u8 {
        let mut b = 0u8;
        for &t in &w[1..9] {
            b = (b << 1) | (t > self.one_ticks) as u8;
        }
        b
    }

    /// Read `out.len()` bytes from `addr` (auto-incrementing). Measured protocol: the slave sends
    /// byte 0 by itself right after the header; every further byte needs one strobe (master low for
    /// one unit, then released). Always closes the read with `ff`.
    pub async fn read(&mut self, addr: u32, out: &mut [u8]) -> Result<(), ReadTimeout> {
        const HEADER_PULSES: usize = 5 * 10;
        if out.is_empty() {
            return Ok(());
        }
        let mut w = [0u32; HEADER_PULSES + 10];
        self.units.clear();
        self.units.header(addr, true);
        let got = self.capture(&mut w, self.byte_timeout * 8).await;
        let mut res = Ok(());
        if got {
            out[0] = self.decode(&w[HEADER_PULSES..]);
            for i in 1..out.len() {
                let mut w = [0u32; 10];
                self.units.clear();
                self.units.unit(Unit::Low);
                self.units.idle(3);
                if !self.capture(&mut w, self.byte_timeout).await {
                    res = Err(ReadTimeout(i));
                    break;
                }
                out[i] = self.decode(&w);
            }
        } else {
            res = Err(ReadTimeout(0));
        }
        self.send_end().await;
        res
    }
}
