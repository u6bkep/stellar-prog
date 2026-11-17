// Client for the pico-sws control port (docs/protocol.md, protocol 2).
//
// Transport-agnostic: takes any object with
//   write(Uint8Array): Promise<void>
//   read(): Promise<Uint8Array | null>   next received chunk, null once closed
//   close(): Promise<void>
// (serial.js wraps a Web Serial port; test/sim.js is a simulated programmer).
// No DOM or navigator access here, so it runs under `node --test`.

export const CMD = {
  PING: 0x00, WRITE: 0x01, READ: 0x02, CPU_STOP: 0x03, CPU_RUN: 0x04,
  ACTIVATE: 0x05, NRST: 0x06, END: 0x07, UART_XFER: 0x08, UART_BAUD: 0x09,
  BOOTSEL: 0x0a,
};
export const STATUS = { OK: 0, READ_TIMEOUT: 1, BAD_CMD: 2, BAD_LEN: 3, BAD_ARG: 4 };
const STATUS_NAMES = ["OK", "READ_TIMEOUT", "BAD_CMD", "BAD_LEN", "BAD_ARG"];

export const PROTOCOL = 2;
export const MAX_PAYLOAD = 2048;
export const PING_TIMEOUT_MS = 500; // "no valid reply within 500 ms" = wrong port
export const RESYNC_MS = 300; // firmware drops a partial frame after 250 ms idle
export const REG_SWS_DIV = 0x00b2;

const EMPTY = new Uint8Array(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ProgrammerError extends Error {
  /// kind: "timeout" | "status" | "garbage" | "closed" | "wrong-port" | "protocol"
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "ProgrammerError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// ---- framing ------------------------------------------------------------

/// request: cmd u8 | addr u32 | len u16 | payload
export function encodeRequest(cmd, addr = 0, payload = EMPTY) {
  if (payload.length > MAX_PAYLOAD) throw new RangeError(`payload ${payload.length} > ${MAX_PAYLOAD}`);
  const out = new Uint8Array(7 + payload.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, cmd);
  v.setUint32(1, addr >>> 0, true);
  v.setUint16(5, payload.length, true);
  out.set(payload, 7);
  return out;
}

/// Parse one request from the front of `buf` (used by the simulator).
/// Returns {cmd, addr, len, payload, used} or null if incomplete. `payload`
/// is null when len > MAX_PAYLOAD (the frame is not buffered).
export function decodeRequest(buf) {
  if (buf.length < 7) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cmd = v.getUint8(0), addr = v.getUint32(1, true), len = v.getUint16(5, true);
  if (len > MAX_PAYLOAD) return { cmd, addr, len, payload: null, used: 7 };
  if (buf.length < 7 + len) return null;
  return { cmd, addr, len, payload: buf.slice(7, 7 + len), used: 7 + len };
}

/// reply: status u8 | len u16 | data
export function encodeReply(status, data = EMPTY) {
  const out = new Uint8Array(3 + data.length);
  out[0] = status;
  out[1] = data.length & 0xff;
  out[2] = data.length >> 8;
  out.set(data, 3);
  return out;
}

// Replies are at most 3 + MAX_PAYLOAD bytes; anything buffered beyond this
// is a device streaming garbage (e.g. the UART bridge port), not a reply.
export const RX_LIMIT = 64 * 1024;

/// Byte FIFO fed by the transport's read loop; `take` waits for n bytes.
export class RxQueue {
  constructor(limit = RX_LIMIT) {
    this.chunks = [];
    this.length = 0;
    this.limit = limit;
    this.overflowed = false;
    this.waiter = null;
    this.closed = null;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    if (this.length + chunk.length > this.limit) {
      // Bounded memory: drop everything and let the pending take() fail.
      this.clear();
      this.overflowed = true;
      this._wake();
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
    this._wake();
  }

  close(err) {
    this.closed = err;
    this._wake();
  }

  clear() {
    this.chunks = [];
    this.length = 0;
    this.overflowed = false;
  }

  _wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  _consume(n) {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - off);
      out.set(c.subarray(0, k), off);
      off += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.length -= n;
    return out;
  }

  /// Resolve with exactly n bytes, or throw a "timeout" ProgrammerError at
  /// `deadline` (a Date.now() value) / "closed" if the transport closes.
  async take(n, deadline) {
    if (n > this.limit) throw new RangeError(`take(${n}) exceeds the receive limit`);
    for (;;) {
      if (this.overflowed) {
        this.overflowed = false;
        throw new ProgrammerError("garbage", "the port sent far more data than any reply");
      }
      if (this.length >= n) break;
      if (this.closed) throw this.closed;
      const left = deadline - Date.now();
      if (left <= 0) throw new ProgrammerError("timeout", "no reply from the programmer");
      await new Promise((resolve) => {
        const t = setTimeout(() => { this.waiter = null; resolve(); }, left);
        this.waiter = () => { clearTimeout(t); resolve(); };
      });
    }
    return this._consume(n);
  }
}

// ---- PING identity and version checks -------------------------------------

/// "pico-sws <protocol> [<board> [<version>]]" -> {protocol, board, version, raw}, or null.
export function parseIdent(data) {
  const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
  const f = raw.split(" ").filter((s) => s.length);
  if (f[0] !== "pico-sws" || f.length < 2 || !/^\d+$/.test(f[1])) return null;
  return { raw, protocol: Number(f[1]), board: f[2] ?? null, version: f[3] ?? null };
}

function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v ?? "");
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], rest: m[4] } : null;
}

/// Compare the programmer's PING identity against the bundled firmware
/// version (null if none is bundled). Returns {state, message}:
///   "protocol"  protocol != 2: tag operations need an update first
///   "old"       older than the bundled firmware
///   "different" not comparable or a different build of the same version
///   "newer"     newer than the bundled firmware
///   "current"   same version
///   "unknown"   nothing bundled to compare against
export function firmwareStatus(ident, bundled) {
  if (ident.protocol !== PROTOCOL) {
    return {
      state: "protocol",
      message: `This programmer speaks protocol ${ident.protocol}; this page needs protocol ${PROTOCOL}. ` +
        "Update the programmer firmware before working on tags.",
    };
  }
  if (!bundled) return { state: "unknown", message: "" };
  if (ident.version === bundled) return { state: "current", message: "Firmware is up to date." };
  const a = semver(ident.version), b = semver(bundled);
  if (a && b) {
    if (a.n.every((x, i) => x === b.n[i]) && a.rest === b.rest) {
      return { state: "current", message: "Firmware is up to date." };
    }
    for (let i = 0; i < 3; i++) {
      if (a.n[i] < b.n[i]) {
        return { state: "old", message: `Programmer firmware ${ident.version} is out of date (this page bundles ${bundled}). Updating is recommended.` };
      }
      if (a.n[i] > b.n[i]) {
        return { state: "newer", message: `Programmer firmware ${ident.version} is newer than the one bundled here (${bundled}).` };
      }
    }
  }
  return {
    state: "different",
    message: `Programmer firmware ${ident.version ?? "(unknown)"} differs from the bundled ${bundled}.`,
  };
}

// ---- client ---------------------------------------------------------------

export class PicoSws {
  constructor(transport, { log = () => {} } = {}) {
    this.transport = transport;
    this.log = log;
    this.rx = new RxQueue();
    this.ident = null;
    this.uartBaudRate = 230400;
    this.desynced = true; // unknown state until the first resync
    this.queue = Promise.resolve();
    this.pump = this._pumpLoop();
  }

  async _pumpLoop() {
    try {
      let empty = 0;
      for (;;) {
        const chunk = await this.transport.read();
        if (chunk === null) break;
        // A transport that keeps resolving with nothing would spin here
        // forever without yielding to timers; give up on it instead.
        if (chunk.length === 0) {
          if (++empty > 1000) throw new Error("the port keeps returning empty reads");
          continue;
        }
        empty = 0;
        this.rx.push(chunk);
      }
      this.rx.close(new ProgrammerError("closed", "the programmer disconnected"));
    } catch (e) {
      this.rx.close(new ProgrammerError("closed", `serial port error: ${e.message}`));
    }
  }

  async close() {
    try { await this.transport.close(); } catch { /* already gone */ }
  }

  /// Run `fn` with exclusive use of the port (one request in flight).
  _exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /// Wait out any partial frame, then discard whatever arrived.
  async resync() {
    await sleep(RESYNC_MS);
    this.rx.clear();
    this.desynced = false;
  }

  /// One request/reply. Returns {status, data}; throws ProgrammerError on
  /// timeout, a malformed reply or a closed port.
  request(cmd, addr = 0, payload = EMPTY, timeoutMs = 1000) {
    return this._exclusive(async () => {
      if (this.desynced) await this.resync();
      if (this.rx.closed) throw this.rx.closed;
      if (this.rx.length) {
        this.log(`discarding ${this.rx.length} stray byte(s) from the programmer`);
        this.rx.clear();
      }
      await this.transport.write(encodeRequest(cmd, addr, payload));
      const deadline = Date.now() + timeoutMs;
      try {
        const hdr = await this.rx.take(3, deadline);
        const status = hdr[0], len = hdr[1] | (hdr[2] << 8);
        if (status >= STATUS_NAMES.length || len > MAX_PAYLOAD) {
          throw new ProgrammerError("garbage", `malformed reply header ${hex(hdr)}`);
        }
        const data = await this.rx.take(len, deadline);
        return { status, data };
      } catch (e) {
        if (e.kind === "timeout" || e.kind === "garbage") this.desynced = true;
        throw e;
      }
    });
  }

  /// request() that throws unless the status is OK; returns the data.
  async cmd(cmd, addr = 0, payload = EMPTY, timeoutMs = 1000) {
    const { status, data } = await this.request(cmd, addr, payload, timeoutMs);
    if (status === STATUS.OK) return data;
    const name = STATUS_NAMES[status];
    if (status === STATUS.READ_TIMEOUT) {
      throw new ProgrammerError("status",
        `SWire read at 0x${addr.toString(16)}: the tag stopped answering at byte ${data[0] | (data[1] << 8)}`,
        { status, statusName: name, index: data[0] | (data[1] << 8) });
    }
    throw new ProgrammerError("status", `programmer rejected command 0x${cmd.toString(16)}: ${name}`,
      { status, statusName: name });
  }

  _requireProtocol2(what) {
    if (this.ident && this.ident.protocol < 2) {
      throw new ProgrammerError("protocol", `${what} needs programmer protocol 2 (this one has ${this.ident.protocol}): update its firmware`);
    }
  }

  /// PING; returns the parsed identity or null for a reply that isn't one.
  async ping(timeoutMs = PING_TIMEOUT_MS) {
    const { status, data } = await this.request(CMD.PING, 0, EMPTY, timeoutMs);
    return status === STATUS.OK ? parseIdent(data) : null;
  }

  async write(addr, data) {
    for (let off = 0; off < data.length; off += MAX_PAYLOAD) {
      const part = data.subarray(off, Math.min(off + MAX_PAYLOAD, data.length));
      await this.cmd(CMD.WRITE, addr + off, part, swireMs(part.length));
    }
  }

  async read(addr, n) {
    const out = new Uint8Array(n);
    for (let off = 0; off < n; off += MAX_PAYLOAD) {
      const k = Math.min(MAX_PAYLOAD, n - off);
      const data = await this.cmd(CMD.READ, addr + off, u16(k), swireMs(k));
      if (data.length !== k) throw new ProgrammerError("garbage", `READ returned ${data.length} of ${k} bytes`);
      out.set(data, off);
    }
    return out;
  }

  cpuStop() { return this.cmd(CMD.CPU_STOP); }
  cpuRun() { return this.cmd(CMD.CPU_RUN); }
  end() { return this.cmd(CMD.END); }
  nrst(release) { return this.cmd(CMD.NRST, release ? 1 : 0); }

  /// Reset the tag while hammering CPU-stop; leaves it halted.
  activate(ms = 600) { return this.cmd(CMD.ACTIVATE, ms, EMPTY, ms + 1500); }

  async uartBaud(baud) {
    this._requireProtocol2("UART_BAUD");
    await this.cmd(CMD.UART_BAUD, baud);
    this.uartBaudRate = baud;
  }

  /// One exchange with the loader on the tag UART: flush, send `payload`,
  /// collect up to `rxLen` bytes for at most `timeoutMs` after the last byte out.
  async uartXfer(payload, rxLen, timeoutMs) {
    this._requireProtocol2("UART_XFER");
    if (rxLen > MAX_PAYLOAD || timeoutMs > 0xffff) throw new RangeError("UART_XFER argument out of range");
    const wireMs = ((payload.length + rxLen) * 10 * 1000) / this.uartBaudRate;
    return this.cmd(CMD.UART_XFER, (rxLen & 0xffff) | (timeoutMs << 16), payload,
      Math.ceil(wireMs + timeoutMs + 1000));
  }

  async bootsel() {
    this._requireProtocol2("BOOTSEL");
    await this.cmd(CMD.BOOTSEL);
  }
}

/// Open the control protocol on `transport`: resync, PING. Throws a
/// "wrong-port" ProgrammerError if nothing valid answers within 500 ms
/// (typically the UART bridge port of the same programmer was picked).
export async function connectProgrammer(transport, opts = {}) {
  const p = new PicoSws(transport, opts);
  let ident = null;
  try {
    ident = await p.ping();
  } catch (e) {
    if (e.kind !== "timeout" && e.kind !== "garbage") { await p.close(); throw e; }
  }
  if (!ident) {
    await p.close();
    throw new ProgrammerError("wrong-port", "this port did not answer like a pico-sws control port");
  }
  p.ident = ident;
  return p;
}

// SWire runs at about 3 kB/s: allow twice that plus margin.
function swireMs(n) { return Math.ceil((n / 3) * 2) + 1000; }

function u16(n) { return new Uint8Array([n & 0xff, n >> 8]); }

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}
