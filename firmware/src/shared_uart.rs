//! The tag UART, shared by two users on the one executor:
//!
//! * the CDC bridge (`proto::uart_bridge`), the **background** user. It holds the UART while it
//!   waits for received bytes, which is most of the time.
//! * `UART_XFER` in the control task, the **exclusive** user. It needs the UART now and needs the
//!   bridge not to take the reply bytes.
//!
//! A plain mutex is not enough: the bridge would never let go, and when it did it could take the
//! lock back before the control task ran. So the exclusive user raises `wanted` and kicks the
//! bridge out of its wait; the bridge does not lock again until `wanted` is clear, which happens
//! only once the exclusive user holds the lock.

use core::cell::Cell;
use core::ops::{Deref, DerefMut};

use embassy_sync::blocking_mutex::raw::NoopRawMutex;
use embassy_sync::mutex::{Mutex, MutexGuard};
use embassy_sync::signal::Signal;

use crate::board::Uart;

pub struct SharedUart {
    uart: Mutex<NoopRawMutex, Uart>,
    baud: Cell<u32>,
    /// An exclusive user is waiting for the lock.
    wanted: Cell<bool>,
    /// Raised with `wanted`: wakes the background user out of its UART wait.
    kick: Signal<NoopRawMutex, ()>,
    /// Raised when an exclusive user lets go: wakes a background user parked on `wanted`.
    freed: Signal<NoopRawMutex, ()>,
}

/// Exclusive hold on the UART. Dropping it lets the background user back in.
pub struct Exclusive<'a> {
    guard: MutexGuard<'a, NoopRawMutex, Uart>,
    freed: &'a Signal<NoopRawMutex, ()>,
}

impl Deref for Exclusive<'_> {
    type Target = Uart;
    fn deref(&self) -> &Uart {
        &self.guard
    }
}

impl DerefMut for Exclusive<'_> {
    fn deref_mut(&mut self) -> &mut Uart {
        &mut self.guard
    }
}

impl Drop for Exclusive<'_> {
    fn drop(&mut self) {
        // The woken task only runs after this one yields, by which time `guard` is dropped too.
        self.freed.signal(());
    }
}

impl SharedUart {
    pub fn new(uart: Uart, baud: u32) -> Self {
        Self {
            uart: Mutex::new(uart),
            baud: Cell::new(baud),
            wanted: Cell::new(false),
            kick: Signal::new(),
            freed: Signal::new(),
        }
    }

    /// Take the UART ahead of the background user. Must be awaited to completion: dropping this
    /// future while it waits would leave `wanted` set and park the background user for good.
    pub async fn exclusive(&self) -> Exclusive<'_> {
        self.wanted.set(true);
        self.kick.signal(());
        let guard = self.uart.lock().await;
        self.wanted.set(false);
        Exclusive { guard, freed: &self.freed }
    }

    /// Take the UART as the background user: waits while an exclusive user is waiting or active.
    /// The holder must also watch [`kicked`](Self::kicked) and drop the guard when it completes.
    pub async fn background(&self) -> MutexGuard<'_, NoopRawMutex, Uart> {
        // `freed` may still be raised from an earlier hand-over; the loop re-checks `wanted`.
        while self.wanted.get() {
            self.freed.wait().await;
        }
        self.uart.lock().await
    }

    /// Completes when an exclusive user wants the UART.
    pub async fn kicked(&self) {
        self.kick.wait().await
    }

    pub fn baud(&self) -> u32 {
        self.baud.get()
    }

    /// Re-rate `uart` (a guard from this `SharedUart`). False, and no change, if the hardware
    /// cannot produce `baud`.
    pub fn set_baud(&self, uart: &mut Uart, baud: u32) -> bool {
        let ok = uart.set_baudrate(baud);
        if ok {
            self.baud.set(baud);
        }
        ok
    }
}
