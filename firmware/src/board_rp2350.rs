//! Waveshare RP2350-Zero soldered to stellar_prog rev 4 (pcb/stellar_prog/gen_board.py):
//! GP26 SWS (PIO0, via R1 1 k on the board), GP29 NRST (open-drain), GP15 -> tag RXD and GP27 <- tag
//! TXD (PIO1 UART: that pair is not a hardware UART TX/RX pair), GP14 X1 / GP28 X2 (behind open
//! solder jumpers JP2/JP3; held as plain inputs), WS2812 on GP16 lit while a command runs
//! (Waveshare schematic RP2350_Zero.pdf: GPIO16 -> WS2812B DIN).

use embassy_executor::Spawner;
use embassy_rp::gpio::{Flex, Level, Pull};
use embassy_rp::peripherals::{DMA_CH0, DMA_CH1, PIO0, PIO1, USB};
use embassy_rp::pio::program::pio_asm;
use embassy_rp::pio::{
    Common, Config, Direction, FifoJoin, InterruptHandler as PioIrq, Pio, PioPin, ShiftConfig, ShiftDirection,
    StateMachine,
};
use embassy_rp::usb::{Driver, InterruptHandler as UsbIrq};
use embassy_rp::{bind_interrupts, dma, Peri};
use embassy_time::{Duration, Instant, Timer};
use fixed::types::extra::U8;
use fixed::FixedU32;

use crate::board::Board;
use crate::pio_uart::{self, PioUart};
use crate::sws::Sws;

bind_interrupts!(struct Irqs {
    USBCTRL_IRQ => UsbIrq<USB>;
    PIO0_IRQ_0 => PioIrq<PIO0>;
    PIO1_IRQ_0 => PioIrq<PIO1>;
    DMA_IRQ_0 => dma::InterruptHandler<DMA_CH0>, dma::InterruptHandler<DMA_CH1>;
});

/// Board name in the PING reply and the USB serial number.
pub const BOARD: &str = "rp2350";

pub type Uart = PioUart<'static, PIO1, 0>;

/// One WS2812 on a PIO state machine; `set` pushes a single GRB word.
pub struct Led {
    sm: StateMachine<'static, PIO1, 2>,
    last: Instant,
}

/// GRB, dim: the LED sits next to the USB connector and is very bright at full scale.
const LED_ON: u32 = 0x18_00_00; // green
/// A word clocked out back to back with the previous one is passed on to DOUT instead of latching,
/// so successive pushes need the 30 us frame plus the reset gap (>= 280 us on newer WS2812s).
const LED_GAP: Duration = Duration::from_micros(350);

impl Led {
    fn new(common: &mut Common<'static, PIO1>, mut sm: StateMachine<'static, PIO1, 2>, pin: Peri<'static, impl PioPin>) -> Self {
        // Classic ws2812 program: T1 = 2, T2 = 5, T3 = 3 cycles -> 10 cycles per bit at 800 kHz.
        let prg = pio_asm!(
            ".side_set 1",
            ".wrap_target",
            "bitloop:",
            "    out x, 1        side 0 [2]",
            "    jmp !x do_zero  side 1 [1]",
            "    jmp bitloop     side 1 [4]",
            "do_zero:",
            "    nop             side 0 [4]",
            ".wrap",
        );
        let loaded = common.load_program(&prg.program);
        let pin = common.make_pio_pin(pin);
        sm.set_pins(Level::Low, &[&pin]);
        sm.set_pin_dirs(Direction::Out, &[&pin]);
        let mut cfg = Config::default();
        cfg.use_program(&loaded, &[&pin]);
        cfg.shift_out = ShiftConfig { threshold: 24, direction: ShiftDirection::Left, auto_fill: true };
        cfg.fifo_join = FifoJoin::TxOnly;
        let div_bits = embassy_rp::clocks::clk_sys_freq() as u64 * 256 / 8_000_000;
        cfg.clock_divider = FixedU32::<U8>::from_bits(div_bits as u32);
        sm.set_config(&cfg);
        sm.set_enable(true);
        let _ = sm.tx().try_push(0); // off
        Self { sm, last: Instant::now() }
    }

    pub async fn set(&mut self, on: bool) {
        Timer::at(self.last + LED_GAP).await;
        let grb = if on { LED_ON } else { 0 };
        let _ = self.sm.tx().try_push(grb << 8);
        self.last = Instant::now();
    }
}

pub fn init(spawner: Spawner, sws_baud: u32, uart_baud: u32) -> Board {
    let p = embassy_rp::init(Default::default());

    // NRST: drive low or float, never drive high (the tag has its own, weak, pull-up).
    let mut nrst = Flex::new(p.PIN_29);
    nrst.set_pull(Pull::Up);
    nrst.set_low();
    nrst.set_as_input();

    // X1/X2 are still unidentified tag pads: if JP2/JP3 get bridged, present high impedance instead
    // of the RP2350 reset default (pull-down). Dropping a Flex leaves its pad register all zero: no
    // pulls, input buffer off (RP2350-E9 advises IE=0 on unused inputs), function NULL.
    drop(Flex::new(p.PIN_14));
    drop(Flex::new(p.PIN_28));

    let Pio { mut common, sm0, sm1, .. } = Pio::new(p.PIO0, Irqs);
    let dma_tx = dma::Channel::new(p.DMA_CH0, Irqs);
    let dma_rx = dma::Channel::new(p.DMA_CH1, Irqs);
    let sws = Sws::new(&mut common, sm0, sm1, p.PIN_26, dma_tx, dma_rx, sws_baud);

    // PIO pins stay configured while any state machine of the block is alive (embassy resets them
    // only when the last user drops), so dropping `common1` here is fine, as for PIO0 above.
    let Pio { common: mut common1, sm0: u_tx, sm1: u_rx, sm2: led_sm, .. } = Pio::new(p.PIO1, Irqs);
    let (uart, uart_rx) = pio_uart::new(&mut common1, u_tx, u_rx, p.PIN_15, p.PIN_27, uart_baud);
    spawner.spawn(uart_rx_task(uart_rx).unwrap());
    let led = Led::new(&mut common1, led_sm, p.PIN_16);

    let uid = embassy_rp::otp::get_chipid().expect("otp chipid");

    Board { sws, nrst, led, uart, usb: Driver::new(p.USB, Irqs), uid }
}

#[embassy_executor::task]
async fn uart_rx_task(rx: pio_uart::PioUartRx<'static, PIO1, 1>) -> ! {
    rx.run().await
}
