// Simulated pico-sws programmer (docs/protocol.md) with a fake Hanshow
// Stellar-L3N tag behind it, for `node --test`. Not shipped in webui/dist.
//
// SimProgrammer implements the transport interface protocol.js expects
// (write / read / close). SimTag models the tag: the SWire register/RAM
// space, CPU halt/run, a floader that answers per pvvx's Uartfloader
// main.c, and a 512 KB flash with the stock firmware's lock behaviour.

import { decodeRequest, encodeReply, CMD, STATUS, MAX_PAYLOAD } from "../site/js/protocol.js";
import { withCrc, crc16 } from "../site/js/floader.js";

export const FLASH_SIZE = 512 * 1024;

/// Deterministic PRNG (mulberry32) so tests are reproducible.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(n, seed) {
  const r = prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (r() * 256) | 0;
  return out;
}

/// A plausible stock image: random content with erased (0xff) stretches.
export function stockImage(seed = 1) {
  const img = randomBytes(FLASH_SIZE, seed);
  img.fill(0xff, 0x20000, 0x40000);
  img.fill(0xff, 0x60000, 0x7b000);
  return img;
}

export class SimTag {
  constructor({
    floaderBin, flash = stockImage(), chipId = 0x5562, jedec = 0x856013,
    locked = true, present = true,
  } = {}) {
    this.floaderBin = floaderBin;
    this.flash = flash;
    this.chipId = chipId;
    this.jedec = jedec;
    this.status = locked ? 0x2c : 0x00;
    this.present = present;
    this.ram = new Uint8Array(0x10000); // SRAM at 0x40000
    this.regs = new Map();
    this.halted = false;
    this.floaderRunning = false;
    this.inReset = false;
    this.baud = 230400; // floader's fixed rate
    // Faults, consumed one per floader reply.
    this.dropReplies = 0;
    this.corruptReplies = 0;
    this.readGlitches = 0; // corrupt read data *before* the CRC (an SPI-level error)
    this.log = [];
  }

  get locked() { return (this.status & 0x7c) !== 0; }

  // ---- SWire ----

  activate() {
    this.inReset = false;
    this.floaderRunning = false;
    this.halted = true;
    this.regs.set(0xb2, 0x05); // reset-default bit time
  }

  swWrite(addr, bytes) {
    if (!this.present) return;
    if (addr === 0x602) {
      if (bytes[0] === 0x05) this.halted = true;
      if (bytes[0] === 0x88) this.run();
      return;
    }
    if (!this.halted) return;
    for (let i = 0; i < bytes.length; i++) this._poke(addr + i, bytes[i]);
  }

  /// Returns the bytes, or the index of the first byte not delivered.
  swRead(addr, n) {
    if (!this.present || !this.halted) return { missing: 0 };
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this._peek(addr + i);
    return { data: out };
  }

  _poke(a, v) {
    if (a >= 0x40000 && a < 0x50000) this.ram[a - 0x40000] = v;
    else this.regs.set(a, v);
  }

  _peek(a) {
    if (a >= 0x40000 && a < 0x50000) return this.ram[a - 0x40000];
    return this.regs.get(a) ?? 0;
  }

  run() {
    this.halted = false;
    const fl = this.floaderBin;
    this.floaderRunning = !!fl && this.ram.subarray(0, fl.length).every((b, i) => b === fl[i]);
    this.log.push(this.floaderRunning ? "floader started" : "ran garbage");
  }

  /// The firmware in flash starts (stock firmware locks the flash).
  bootFlash() {
    this.floaderRunning = false;
    this.halted = false;
    this.status = 0x2c;
    this.log.push("booted flash firmware");
  }

  // ---- UART: floader ----

  /// Bytes arriving at the tag's RXD as one burst. Returns the reply bytes.
  uartRx(frame, baud) {
    if (!this.present || !this.floaderRunning || this.inReset) return new Uint8Array(0);
    if (baud !== this.baud) return new Uint8Array(0); // framing errors: floader sees garbage
    const reply = this._floader(frame);
    if (!reply) return new Uint8Array(0);
    if (this.dropReplies > 0) { this.dropReplies--; return new Uint8Array(0); }
    if (this.corruptReplies > 0) {
      this.corruptReplies--;
      reply[reply.length >> 1] ^= 0x5a;
    }
    return reply;
  }

  _floader(rx) {
    if (rx.length < 4 + 2) return null;
    const len = rx.length - 2;
    let tx = rx.slice(0, 4);
    const c = crc16(rx.subarray(0, len));
    if ((c & 0xff) !== rx[len] || c >> 8 !== rx[len + 1]) {
      tx[0] |= 0xc0;
      return withCrc(tx);
    }
    const cmd = rx[0], faddr = rx[1] | (rx[2] << 8) | (rx[3] << 16);
    switch (cmd) {
      case 1: { // read
        let n = len === 4 ? 1024 : rx[4] | (rx[5] << 8);
        if (n > 1024) n = 1024;
        const out = new Uint8Array(4 + n);
        out.set(tx);
        for (let i = 0; i < n; i++) out[4 + i] = this.flash[(faddr + i) % this.flash.length];
        if (this.readGlitches > 0 && n > 0) { this.readGlitches--; out[4 + (n >> 1)] ^= 0x01; }
        tx = out;
        break;
      }
      case 2: // write
        if (len === 4 || len > 1024 + 4) tx[0] |= 0x80;
        else this._program(faddr, rx.subarray(4, len));
        break;
      case 3: // sector erase
        this._erase(faddr & ~0xfff, 0x1000);
        break;
      case 4: // chip erase
        if (faddr === 0) this._erase(0, this.flash.length);
        else tx[0] |= 0x80;
        break;
      case 5: // JEDEC ID
        tx[1] = (this.jedec >> 16) & 0xff;
        tx[2] = (this.jedec >> 8) & 0xff;
        tx[3] = this.jedec & 0xff;
        break;
      case 0:
        if (rx[1] === 1) { this.bootFlash(); return null; } // MCU reboot: no reply goes out
        if (rx[1] === 2) { this.status = rx[2]; break; } // flash_write_status(addrh)
        tx[1] = 0x11;
        tx[2] = this.chipId & 0xff;
        tx[3] = this.chipId >> 8;
        break;
      default:
        tx[0] |= 0x80;
    }
    return withCrc(tx);
  }

  _erase(addr, n) {
    if (this.locked) { this.log.push(`erase ${addr.toString(16)} ignored (locked)`); return; }
    this.flash.fill(0xff, addr, addr + n);
  }

  _program(addr, data) {
    if (this.locked) { this.log.push(`program ${addr.toString(16)} ignored (locked)`); return; }
    for (let i = 0; i < data.length; i++) this.flash[addr + i] &= data[i]; // NOR: 1 -> 0 only
  }
}

/// Byte-stream plumbing shared by the two simulated ports.
class SimPort {
  constructor({ chunk = null, seed = 7 } = {}) {
    this.out = [];
    this.reader = null;
    this.closed = false;
    if (chunk !== null && chunk !== "random" && !(Number.isInteger(chunk) && chunk >= 1)) {
      throw new RangeError(`chunk must be null, "random" or an integer >= 1 (got ${chunk})`);
    }
    this.chunk = chunk; // null: whole replies; number: max chunk size; "random": 1..17 bytes
    this.rand = prng(seed);
    this.written = [];
  }

  _emit(bytes) {
    if (!bytes.length) return;
    if (this.chunk === null) {
      this.out.push(bytes);
    } else {
      for (let off = 0; off < bytes.length;) {
        const n = this.chunk === "random" ? 1 + ((this.rand() * 17) | 0) : this.chunk;
        this.out.push(bytes.slice(off, off + n));
        off += n;
      }
    }
    this._wake();
  }

  _wake() {
    const r = this.reader;
    if (!r) return;
    if (this.out.length) { this.reader = null; r(this.out.shift()); }
    else if (this.closed) { this.reader = null; r(null); }
  }

  read() {
    if (this.out.length) return Promise.resolve(this.out.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => { this.reader = resolve; });
  }

  async close() {
    this.closed = true;
    this._wake();
  }
}

/// The programmer's control port.
export class SimProgrammer extends SimPort {
  constructor(tag, { protocol = 2, board = "rp2350", version = "v0.1.0", ...opts } = {}) {
    super(opts);
    this.tag = tag;
    this.protocol = protocol;
    this.board = board;
    this.version = version;
    this.inbuf = new Uint8Array(0);
    this.lastRx = 0;
    this.discarding = false;
    this.uartBaud = 230400;
    this.uartPending = new Uint8Array(0); // tag -> programmer bytes not yet collected
    this.dropControlReplies = 0;
    this.commands = []; // log of decoded requests: {cmd, addr, len}
    this.bootsel = false;
  }

  async write(bytes) {
    if (this.closed) throw new Error("port closed");
    this.written.push(bytes);
    const now = Date.now();
    if (now - this.lastRx > 250) {
      this.inbuf = new Uint8Array(0); // partial frame dropped after 250 ms idle
      this.discarding = false;
    }
    this.lastRx = now;
    if (this.discarding) return;
    const b = new Uint8Array(this.inbuf.length + bytes.length);
    b.set(this.inbuf);
    b.set(bytes, this.inbuf.length);
    this.inbuf = b;
    for (;;) {
      const req = decodeRequest(this.inbuf);
      if (!req) break;
      if (req.payload === null) {
        this._reply(STATUS.BAD_LEN);
        this.inbuf = new Uint8Array(0);
        this.discarding = true;
        break;
      }
      this.inbuf = this.inbuf.slice(req.used);
      this.commands.push({ cmd: req.cmd, addr: req.addr, len: req.len });
      this._handle(req);
    }
  }

  _reply(status, data) {
    if (this.dropControlReplies > 0) { this.dropControlReplies--; return; }
    const frame = encodeReply(status, data);
    // Deliver asynchronously, like a real USB endpoint.
    setImmediate(() => this._emit(frame));
  }

  _handle({ cmd, addr, payload }) {
    const t = this.tag;
    const v2 = this.protocol >= 2;
    const none = () => payload.length === 0;
    switch (cmd) {
      case CMD.PING: {
        if (!none()) return this._reply(STATUS.BAD_LEN);
        const s = this.protocol >= 2
          ? `pico-sws ${this.protocol} ${this.board} ${this.version}`
          : this.board ? `pico-sws 1 ${this.board}` : "pico-sws 1";
        return this._reply(STATUS.OK, new TextEncoder().encode(s));
      }
      case CMD.WRITE:
        if (payload.length === 0) return this._reply(STATUS.BAD_LEN);
        t.swWrite(addr, payload);
        return this._reply(STATUS.OK);
      case CMD.READ: {
        if (payload.length !== 2) return this._reply(STATUS.BAD_LEN);
        const n = payload[0] | (payload[1] << 8);
        if (n < 1 || n > MAX_PAYLOAD) return this._reply(STATUS.BAD_LEN);
        const r = t.swRead(addr, n);
        if (r.data) return this._reply(STATUS.OK, r.data);
        return this._reply(STATUS.READ_TIMEOUT, new Uint8Array([r.missing & 0xff, r.missing >> 8]));
      }
      case CMD.CPU_STOP:
      case CMD.CPU_RUN:
        if (!none()) return this._reply(STATUS.BAD_LEN);
        t.swWrite(0x602, [cmd === CMD.CPU_STOP ? 0x05 : 0x88]);
        return this._reply(STATUS.OK);
      case CMD.ACTIVATE:
        if (!none()) return this._reply(STATUS.BAD_LEN);
        if (t.present) t.activate();
        return this._reply(STATUS.OK);
      case CMD.NRST:
        if (!none()) return this._reply(STATUS.BAD_LEN);
        if (addr === 0) { t.inReset = true; t.floaderRunning = false; t.halted = false; }
        else if (t.inReset) { t.inReset = false; if (t.present) t.bootFlash(); }
        return this._reply(STATUS.OK);
      case CMD.END:
        return this._reply(none() ? STATUS.OK : STATUS.BAD_LEN);
      case CMD.UART_XFER: {
        if (!v2) return this._reply(STATUS.BAD_CMD);
        const rxLen = addr & 0xffff;
        if (rxLen > MAX_PAYLOAD) return this._reply(STATUS.BAD_ARG);
        if (payload.length) {
          this.uartPending = t.uartRx(payload, this.uartBaud); // flush, send, tag answers
        }
        const n = Math.min(rxLen, this.uartPending.length);
        const got = this.uartPending.slice(0, n);
        this.uartPending = this.uartPending.slice(n);
        return this._reply(STATUS.OK, got);
      }
      case CMD.UART_BAUD:
        if (!v2) return this._reply(STATUS.BAD_CMD);
        if (!none()) return this._reply(STATUS.BAD_LEN);
        if (addr < 1200 || addr > 3000000) return this._reply(STATUS.BAD_ARG);
        this.uartBaud = addr;
        return this._reply(STATUS.OK);
      case CMD.BOOTSEL:
        if (!v2) return this._reply(STATUS.BAD_CMD);
        this._reply(STATUS.OK);
        this.bootsel = true;
        setTimeout(() => this.close(), 20); // the serial port disappears
        return undefined;
      default:
        return this._reply(STATUS.BAD_CMD);
    }
  }
}

/// The same programmer's UART bridge port: host bytes go straight to the
/// tag's RXD, whatever the tag sends comes straight back.
export class SimBridgePort extends SimPort {
  constructor(tag, opts = {}) {
    super(opts);
    this.tag = tag;
  }

  async write(bytes) {
    if (this.closed) throw new Error("port closed");
    this.written.push(bytes);
    const reply = this.tag.uartRx(bytes, 230400);
    if (reply.length) setImmediate(() => this._emit(reply));
  }
}

/// Byte-array equality with a short failure message. Never hand large typed
/// arrays (or objects holding them) to node:assert: on failure it inspects
/// them with maxArrayLength Infinity and diffs line by line, which for a
/// 512 KB image needs tens of GB.
export function assertBytes(actual, expected, what = "bytes") {
  if (!(actual instanceof Uint8Array) || !(expected instanceof Uint8Array)) {
    throw new Error(`${what}: not Uint8Arrays`);
  }
  if (actual.length !== expected.length) {
    throw new Error(`${what}: length ${actual.length}, expected ${expected.length}`);
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${what}: differ at 0x${i.toString(16)}: 0x${actual[i].toString(16)} != 0x${expected[i].toString(16)}`);
    }
  }
}
