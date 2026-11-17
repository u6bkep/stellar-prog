// pvvx's floader (TlsrComProg825x) driven through the pico-sws programmer.
//
// floader runs from the tag's RAM at 0x40000 and talks on the tag UART at
// 230400 baud. Every exchange is one UART_XFER on the control port.
//
// Frames: [cmd u8][addr u24 LE][payload] + CRC-16/MODBUS (LE). The reply
// echoes the 4-byte header (with fields replaced for some commands), then
// data, then the CRC. Commands: 0 version (addr low byte 1 = reboot,
// 2 = write flash status from addr bits 8-23), 1 read (payload u16 len
// <= 1024), 2 write (payload = data), 3 erase 4 KB sector, 5 JEDEC ID.
// A bad CRC is answered with cmd | 0xC0, an unknown command with cmd | 0x80.
// Chip erase (4) is deliberately not exposed.
//
// Flash protection: the stock Hanshow app locks the flash (status 0x2c,
// block-protect bits) at every boot. Erase/program to protected sectors are
// acknowledged by floader and silently ignored by the flash, so
// writeSector() checks for blank after the erase; unlock() writes status 0.

import { STATUS } from "./protocol.js";

export const FLOADER_ADDR = 0x40000;
export const SECTOR = 0x1000;
export const PAGE = 0x100;
export const READ_CHUNK = 1024;
export const UART_BAUD = 230400;
export const SWS_CLK = 24e6;
export const TACT_MS = 600;

// The tag this page supports: Telink TLSR8359 (chip ID 0x5562), 512 KB flash.
export const EXPECTED_CHIP_ID = 0x5562;
export const EXPECTED_SIZE_BYTE = 0x13;

// Never written unless allowProtected: Hanshow bootloader and per-tag config.
export const PROTECTED = [
  { start: 0x00000, end: 0x0d000, what: "Hanshow bootloader" },
  { start: 0x7b000, end: 0x80000, what: "per-tag configuration" },
];

const FL_VERSION = 0, FL_READ = 1, FL_WRITE = 2, FL_ERASE = 3, FL_JEDEC = 5;

// UART_XFER timeouts in ms: the Python tools' serial timeouts rounded up
// plus margin (0.2 s, 1024*12/230400+0.05 s, 0.3 s, 0.5 s).
export const T_CMD = 300;
export const T_READ = 200;
export const T_WRITE = 400;
export const T_ERASE = 600;
export const TRIES = 4;

const EMPTY = new Uint8Array(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TagError extends Error {
  /// `hint` is the "what to do next" line shown to the user.
  constructor(message, hint = "") {
    super(message);
    this.name = "TagError";
    this.hint = hint;
  }
}

export const HINT_CONTACT =
  "Check that the tag sits flat and firmly on the pogo pins, then try again.";

// ---- CRC-16/MODBUS ---------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc16(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return crc;
}

export function withCrc(data) {
  const out = new Uint8Array(data.length + 2);
  out.set(data);
  const c = crc16(data);
  out[data.length] = c & 0xff;
  out[data.length + 1] = c >> 8;
  return out;
}

export function crcOk(data) {
  if (data.length < 2) return false;
  const c = crc16(data.subarray(0, data.length - 2));
  return data[data.length - 2] === (c & 0xff) && data[data.length - 1] === c >> 8;
}

export function floaderFrame(cmd, addr, payload = EMPTY) {
  const body = new Uint8Array(4 + payload.length);
  body[0] = cmd;
  body[1] = addr & 0xff;
  body[2] = (addr >> 8) & 0xff;
  body[3] = (addr >> 16) & 0xff;
  body.set(payload, 4);
  return withCrc(body);
}

const ALIVE_PROBE = floaderFrame(0x1f, 0x785634); // bad command 1F 34 56 78 ...
const ALIVE_REPLY = floaderFrame(0x9f, 0x785634); // ... is answered with 9F 34 56 78

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isBlank(d) {
  for (let i = 0; i < d.length; i++) if (d[i] !== 0xff) return false;
  return true;
}

export const h6 = (a) => `0x${a.toString(16).padStart(6, "0")}`;

/// Throw unless [addr, addr+n) avoids the protected regions (or allowProtected).
export function checkWritable(addr, n, allowProtected) {
  if (allowProtected) return;
  for (const r of PROTECTED) {
    if (addr < r.end && addr + n > r.start) {
      throw new TagError(
        `${h6(addr)}+0x${n.toString(16)} overlaps the ${r.what} region ${h6(r.start)}-${h6(r.end)}`,
        "Tick \"allow writing the bootloader and per-tag regions\" if you really mean to overwrite it.");
    }
  }
}

// ---- client ---------------------------------------------------------------

export class Floader {
  /// `pico` is a connected PicoSws.
  constructor(pico, { log = () => {} } = {}) {
    this.pico = pico;
    this.log = log;
    this.retries = 0;
  }

  /// One floader command with up to TRIES attempts. Returns the reply
  /// (header + rlen-4 data bytes + CRC) or null. `echo` also requires the
  /// reply to echo the request's address bytes (read/write/erase do).
  async cmd(c, addr, payload = EMPTY, { rlen = 4, timeoutMs = T_CMD, tries = TRIES, echo = false } = {}) {
    const frame = floaderFrame(c, addr, payload);
    for (let i = 0; i < tries; i++) {
      const r = await this.pico.uartXfer(frame, rlen + 2, timeoutMs);
      if (r.length === rlen + 2 && r[0] === c && crcOk(r) &&
          (!echo || (r[1] === frame[1] && r[2] === frame[2] && r[3] === frame[3]))) {
        return r;
      }
      this.retries++;
      this.log(`floader cmd ${c} @${h6(addr)}: ${describeBad(r, rlen + 2)}${i + 1 < tries ? ", retrying" : ""}`);
    }
    return null;
  }

  /// Is floader already running on the tag? (1F.. is answered with 9F..)
  async alive() {
    const r = await this.pico.uartXfer(ALIVE_PROBE, ALIVE_REPLY.length, T_CMD);
    return equalBytes(r, ALIVE_REPLY);
  }

  /// Reset + halt the tag, set and verify the SWire bit time, load floader
  /// to RAM, read it back, start it.
  async load(floaderBin, { tactMs = TACT_MS } = {}) {
    const p = this.pico, log = this.log;
    log(`resetting the tag and halting its CPU (${tactMs} ms)...`);
    await p.activate(tactMs);
    const div = Math.min(127, Math.floor(SWS_CLK / UART_BAUD));
    await p.write(0x00b2, new Uint8Array([div]));
    let got;
    try {
      got = await p.read(0x00b2, 1);
    } catch (e) {
      if (e.kind === "status" && e.status === STATUS.READ_TIMEOUT) {
        throw new TagError("No reply from the tag over SWS.",
          `${HINT_CONTACT} No reply here almost always means the pogo pins are not seated.`);
      }
      throw e;
    }
    if (got[0] !== div) {
      throw new TagError(`The tag answered, but its SWS speed register read back 0x${got[0].toString(16)} instead of 0x${div.toString(16)}.`,
        HINT_CONTACT);
    }
    log(`  tag halted; SWS speed ${div} verified`);
    log(`loading floader (${floaderBin.length} bytes) to RAM ${h6(FLOADER_ADDR)}...`);
    await p.write(FLOADER_ADDR, floaderBin);
    const back = await p.read(FLOADER_ADDR, floaderBin.length);
    for (let i = 0; i < floaderBin.length; i++) {
      if (back[i] !== floaderBin[i]) {
        throw new TagError(`floader read-back differs at ${h6(FLOADER_ADDR + i)}.`, HINT_CONTACT);
      }
    }
    log("  read back OK; starting it");
    await p.cpuRun();
    await sleep(150);
  }

  /// floader version, chip ID, JEDEC ID, flash size.
  async identify() {
    const v = await this.cmd(FL_VERSION, 0);
    if (!v) {
      throw new TagError("floader does not answer on the tag UART.",
        `${HINT_CONTACT} SWS worked, so check the RXD and TXD pins in particular.`);
    }
    const j = await this.cmd(FL_JEDEC, 0);
    if (!j) throw new TagError("floader did not return the flash ID.", HINT_CONTACT);
    const jedec = (j[1] << 16) | (j[2] << 8) | j[3];
    return {
      floaderVersion: `${v[1] >> 4}.${v[1] & 15}`,
      chipId: v[2] | (v[3] << 8),
      jedec,
      sizeByte: j[3],
      size: j[3] < 32 ? 2 ** j[3] : 0,
    };
  }

  async read(addr, n, progress = null) {
    const out = new Uint8Array(n);
    for (let off = 0; off < n; off += READ_CHUNK) {
      const k = Math.min(READ_CHUNK, n - off);
      const len = new Uint8Array([k & 0xff, k >> 8]);
      const r = await this.cmd(FL_READ, addr + off, len, { rlen: 4 + k, timeoutMs: T_READ, echo: true });
      if (!r) throw new TagError(`Reading flash at ${h6(addr + off)} failed ${TRIES} times.`, HINT_CONTACT);
      out.set(r.subarray(4, 4 + k), off);
      if (progress) progress(off + k, n);
    }
    return out;
  }

  /// Clear the flash status register (all block-protect bits off).
  async unlock() {
    if (!(await this.cmd(FL_VERSION, 2 | (0 << 8), EMPTY, { timeoutMs: T_ERASE }))) {
      throw new TagError("Unlocking the flash (status write) failed.", HINT_CONTACT);
    }
  }

  async eraseSector(addr, allowProtected = false) {
    if (addr % SECTOR) throw new RangeError("unaligned erase");
    checkWritable(addr, SECTOR, allowProtected);
    if (!(await this.cmd(FL_ERASE, addr, EMPTY, { timeoutMs: T_ERASE, echo: true }))) {
      throw new TagError(`Erasing sector ${h6(addr)} failed.`, HINT_CONTACT);
    }
  }

  /// Erase one 4 KB sector, check it is blank, program it page by page
  /// (all-0xff pages skipped), read back and compare.
  async writeSector(addr, data, allowProtected = false) {
    if (addr % SECTOR || data.length !== SECTOR) throw new RangeError("writeSector needs one aligned sector");
    checkWritable(addr, SECTOR, allowProtected);
    await this.eraseSector(addr, allowProtected);
    if (!isBlank(await this.read(addr, SECTOR))) {
      throw new TagError(`Sector ${h6(addr)} is not blank after erase: the flash is write-protected.`,
        "The flash unlock did not take effect. Reboot the tag, run Detect again and retry.");
    }
    for (let p = 0; p < SECTOR; p += PAGE) {
      const chunk = data.subarray(p, p + PAGE);
      if (isBlank(chunk)) continue;
      if (!(await this.cmd(FL_WRITE, addr + p, chunk, { timeoutMs: T_WRITE, echo: true }))) {
        throw new TagError(`Programming flash at ${h6(addr + p)} failed.`, HINT_CONTACT);
      }
    }
    if (!equalBytes(await this.read(addr, SECTOR), data)) {
      throw new TagError(`Verify failed in sector ${h6(addr)}: it reads back different from what was written.`,
        `${HINT_CONTACT} Then run the same write again; sectors that already match are skipped.`);
    }
  }

  /// Write `data` at a sector-aligned address. First reads every target
  /// sector and compares; then writes (and verifies) only those that differ.
  /// progress({phase: "compare"|"write", done, total, addr}).
  /// Returns {written: [addr...], total: sectors}.
  async write(addr, data, { allowProtected = false, progress = () => {} } = {}) {
    if (addr % SECTOR) throw new TagError(`Address ${h6(addr)} is not a multiple of 4 KB.`);
    const img = padToSector(data);
    checkWritable(addr, img.length, allowProtected);
    const n = img.length / SECTOR;
    const todo = [];
    for (let i = 0; i < n; i++) {
      const a = addr + i * SECTOR;
      const want = img.subarray(i * SECTOR, (i + 1) * SECTOR);
      if (!equalBytes(await this.read(a, SECTOR), want)) todo.push(i);
      progress({ phase: "compare", done: i + 1, total: n, addr: a });
    }
    this.log(`${todo.length} of ${n} sector(s) differ and will be written`);
    const written = [];
    for (const [k, i] of todo.entries()) {
      const a = addr + i * SECTOR;
      progress({ phase: "write", done: k, total: todo.length, addr: a });
      this.log(`  sector ${h6(a)}: write`);
      await this.writeSector(a, img.subarray(i * SECTOR, (i + 1) * SECTOR), allowProtected);
      written.push(a);
    }
    progress({ phase: "write", done: todo.length, total: todo.length, addr: addr + img.length });
    return { written, total: n };
  }

  /// Ask floader to reset the MCU; the firmware in flash starts. No reply.
  async reboot() {
    await this.pico.uartXfer(floaderFrame(FL_VERSION, 1), 0, 0);
  }
}

export function padToSector(data) {
  const len = Math.ceil(data.length / SECTOR) * SECTOR;
  if (len === data.length) return data;
  const out = new Uint8Array(len).fill(0xff);
  out.set(data);
  return out;
}

function describeBad(r, want) {
  if (r.length === 0) return "no reply";
  if (r.length !== want) return `short reply (${r.length} of ${want} bytes)`;
  if (!crcOk(r)) return "reply failed its CRC";
  if ((r[0] & 0xc0) === 0xc0) return "floader saw a bad CRC in the request";
  if (r[0] & 0x80) return "floader rejected the command";
  return "unexpected reply header";
}
