// Tag-side flows: detect, back up, flash, restore, reboot. No DOM access:
// main.js drives a TagSession and renders what it returns.

import {
  Floader, TagError, HINT_CONTACT, UART_BAUD, SECTOR, EXPECTED_CHIP_ID,
  EXPECTED_SIZE_BYTE, h6, equalBytes, checkWritable,
} from "./floader.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function describeTag(info) {
  const problems = [];
  if (info.chipId !== EXPECTED_CHIP_ID) {
    problems.push(`chip ID is 0x${info.chipId.toString(16)}, expected 0x${EXPECTED_CHIP_ID.toString(16)} (TLSR8359)`);
  }
  if (info.jedec === 0 || info.jedec === 0xffffff) {
    problems.push(`the flash does not answer (JEDEC ID ${h6(info.jedec)})`);
  } else if (info.sizeByte !== EXPECTED_SIZE_BYTE) {
    problems.push(`flash size code 0x${info.sizeByte.toString(16)}, expected 0x${EXPECTED_SIZE_BYTE.toString(16)} (512 KB)`);
  }
  return { supported: problems.length === 0, problems };
}

export class TagSession {
  /// `pico`: connected PicoSws (protocol 2). `floaderBin`: Uint8Array or null.
  constructor(pico, { log = () => {}, floaderBin = null } = {}) {
    this.pico = pico;
    this.log = log;
    this.floader = new Floader(pico, { log });
    this.floaderBin = floaderBin;
    this.baudSet = false;
    this.info = null; // last identify() result + {supported, problems}
    // The backup taken in this session, valid for the tag currently on the
    // fixture. Cleared whenever the tag has to be (re)activated, because that
    // is what happens when a different tag is put on the fixture.
    this.backup = null;
  }

  /// Make sure floader is running on the tag and identify it.
  /// Returns {info, activated}.
  async prepare() {
    if (!this.baudSet) {
      await this.pico.uartBaud(UART_BAUD);
      this.baudSet = true;
    }
    let activated = false;
    if (await this.floader.alive()) {
      this.log("floader is already running on the tag");
    } else {
      if (!this.floaderBin) {
        throw new TagError("floader.bin is not available.",
          "This copy of the page has no bundled floader. Choose floader.bin in the Help section.");
      }
      if (this.backup) {
        this.log("the tag had to be reset: the backup taken earlier no longer counts for it");
        this.backup = null;
      }
      this.info = null;
      await this.floader.load(this.floaderBin);
      activated = true;
    }
    const id = await this.floader.identify();
    this.info = { ...id, ...describeTag(id) };
    return { info: this.info, activated };
  }

  async detect() {
    const r = await this.prepare();
    const i = r.info;
    this.log(`floader v${i.floaderVersion}, chip ID 0x${i.chipId.toString(16)}, ` +
      `flash JEDEC ID ${h6(i.jedec)} (${i.size >> 10} KB)`);
    if (!i.supported) this.log(`not a supported tag: ${i.problems.join("; ")}`);
    return r;
  }

  _requireSupported() {
    if (!this.info.supported) {
      throw new TagError(`Refusing to write: ${this.info.problems.join("; ")}.`,
        "This page only writes Hanshow Stellar-L3N tags (TLSR8359, 512 KB flash).");
    }
  }

  /// Read the whole flash twice and compare. Stores and returns the image.
  /// progress({phase: "read"|"verify", done, total}).
  async backupFlash({ progress = () => {} } = {}) {
    const { info } = await this.prepare();
    if (info.jedec === 0 || info.jedec === 0xffffff) {
      throw new TagError("The tag's flash does not answer, so there is nothing to back up.", HINT_CONTACT);
    }
    // floader addresses are 24-bit: 64 KB..16 MB is the only plausible range,
    // and the size decides how much memory the backup allocates.
    if (info.sizeByte < 0x10 || info.sizeByte > 0x18) {
      throw new TagError(`The flash reports an implausible size code 0x${info.sizeByte.toString(16)} (JEDEC ID ${h6(info.jedec)}).`,
        HINT_CONTACT);
    }
    const t0 = Date.now();
    const a = await this.floader.read(0, info.size, (done, total) => progress({ phase: "read", done, total }));
    this.log(`read ${info.size} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s; reading again to verify`);
    const b = await this.floader.read(0, info.size, (done, total) => progress({ phase: "verify", done, total }));
    const bad = [];
    for (let off = 0; off < a.length; off += SECTOR) {
      if (!equalBytes(a.subarray(off, off + SECTOR), b.subarray(off, off + SECTOR))) bad.push(off);
    }
    if (bad.length) {
      throw new TagError(
        `The two reads of the flash differ in ${bad.length} sector(s), first at ${h6(bad[0])}. The backup is not trustworthy.`,
        `${HINT_CONTACT} Then take the backup again.`);
    }
    this.backup = { data: a, takenAt: new Date() };
    this.log(`backup verified (${a.length} bytes, both reads identical)`);
    return a;
  }

  /// Write `data` at `addr` (4 KB aligned): unlock, write changed sectors,
  /// verify, optionally reboot. `requireBackup` false = the user confirmed
  /// they already hold a backup of this tag. Returns floader.write()'s result.
  async writeImage(addr, data, { allowProtected = false, requireBackup = true, reboot = true, progress = () => {} } = {}) {
    if (addr % SECTOR) throw new TagError(`Address ${h6(addr)} is not a multiple of 4 KB (0x1000).`);
    if (data.length === 0) throw new TagError("The file is empty.");
    const { info } = await this.prepare();
    this._requireSupported();
    if (requireBackup && !this.backup) {
      throw new TagError("No backup of this tag has been taken in this session.",
        "Use \"Back up flash\" first, or tick the box confirming you already have a backup of this tag.");
    }
    const end = addr + Math.ceil(data.length / SECTOR) * SECTOR;
    if (end > info.size) {
      throw new TagError(`The image (${data.length} bytes at ${h6(addr)}) runs past the end of the ${info.size >> 10} KB flash.`);
    }
    // Before the unlock: a refused write must leave the tag as it was.
    checkWritable(addr, end - addr, allowProtected);
    this.log("unlocking the flash");
    await this.floader.unlock();
    const r = await this.floader.write(addr, data, { allowProtected, progress });
    this.log(`wrote and verified ${r.written.length} sector(s); ${r.total - r.written.length} already matched`);
    if (reboot) await this.reboot({ viaFloader: true });
    return r;
  }

  /// Write a full-flash backup image back at 0x0.
  async restore(image, opts = {}) {
    const { info } = await this.prepare();
    if (image.length !== info.size) {
      throw new TagError(`A backup must be exactly ${info.size} bytes (the flash size); this file is ${image.length} bytes.`,
        "Choose the .bin file this page saved when backing up the tag.");
    }
    return this.writeImage(0, image, { ...opts, allowProtected: true, requireBackup: false });
  }

  /// Restart the tag into its flash firmware. viaFloader: floader's reboot
  /// command (no reply); otherwise pulse NRST, which works in any state.
  async reboot({ viaFloader = false } = {}) {
    if (viaFloader) {
      await this.floader.reboot();
      this.log("reboot command sent; the tag starts its flash firmware");
    } else {
      await this.pico.nrst(false);
      await sleep(50);
      await this.pico.nrst(true);
      this.log("tag reset; it starts its flash firmware");
    }
    this.info = null;
  }
}
