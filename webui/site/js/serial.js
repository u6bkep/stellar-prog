// Web Serial transport for the pico-sws control port, in the shape
// protocol.js expects: write(bytes), read() -> chunk | null, close().

import { connectProgrammer } from "./protocol.js";

export const VID = 0x2e8a;
export const PID = 0x000a;
export const SERIAL_FILTERS = [{ usbVendorId: VID, usbProductId: PID }];

export function serialAvailable() {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

export function isProgrammerPort(port) {
  const i = port.getInfo();
  return i.usbVendorId === VID && i.usbProductId === PID;
}

/// Previously granted ports that could be a pico-sws (either of its two).
/// Bounded: getPorts() never settles in some environments (seen in headless
/// Chrome), and the Connect button waits for this.
export async function grantedPorts(timeoutMs = 3000) {
  const ports = await Promise.race([
    navigator.serial.getPorts(),
    new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
  ]);
  return ports.filter(isProgrammerPort);
}

/// Open `port` and wrap it as a transport. The control port ignores the
/// baud rate; 230400 is what the tag UART runs at, so opening the bridge
/// port by mistake does not change it.
export async function openTransport(port) {
  try {
    await port.open({ baudRate: 230400, bufferSize: 8192 });
  } catch (e) {
    throw new Error(
      `could not open the serial port (${e.message}). It may be in use by another program ` +
      "(a terminal or the Python tools), or on Linux you may lack permission: see Help.");
  }
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  let closed = false;
  return {
    port,
    async write(bytes) {
      await writer.write(bytes);
    },
    async read() {
      if (closed) return null;
      const { value, done } = await reader.read();
      if (done || closed) return null;
      return value ?? new Uint8Array(0);
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await reader.cancel(); } catch { /* gone */ }
      try { reader.releaseLock(); } catch { /* gone */ }
      try { writer.releaseLock(); } catch { /* gone */ }
      try { await port.close(); } catch { /* gone */ }
    },
  };
}

/// Open `port` and check it answers PING like a control port. Returns a
/// connected PicoSws; throws (kind "wrong-port" for the UART bridge port).
export async function connectPort(port, log) {
  const t = await openTransport(port);
  try {
    return await connectProgrammer(t, { log });
  } catch (e) {
    await t.close();
    throw e;
  }
}
