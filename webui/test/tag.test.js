import test from "node:test";
import assert from "node:assert/strict";
import { connectProgrammer, CMD } from "../site/js/protocol.js";
import {
  crc16, withCrc, crcOk, floaderFrame, Floader, TagError, SECTOR, checkWritable,
} from "../site/js/floader.js";
import { TagSession } from "../site/js/tag.js";
import { SimTag, SimProgrammer, randomBytes, FLASH_SIZE, assertBytes } from "./sim.js";

const FLOADER = randomBytes(1960, 99);
const hexs = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

async function setup(tagOpts = {}, progOpts = {}) {
  const tag = new SimTag({ floaderBin: FLOADER, ...tagOpts });
  const sim = new SimProgrammer(tag, progOpts);
  const pico = await connectProgrammer(sim);
  const logs = [];
  const s = new TagSession(pico, { floaderBin: FLOADER, log: (l) => logs.push(l) });
  return { tag, sim, pico, s, logs, close: () => pico.close() };
}

const xfers = (sim) => sim.commands.filter((c) => c.cmd === CMD.UART_XFER);

// ---- frame format --------------------------------------------------------

test("CRC-16/MODBUS matches the vectors in floader's main.c", () => {
  assert.equal(crc16(new TextEncoder().encode("123456789")), 0x4b37);
  assert.equal(hexs(floaderFrame(0, 0)), "00 00 00 00 00 24");
  assert.equal(hexs(floaderFrame(5, 0)), "05 00 00 00 00 e8");
  assert.equal(hexs(floaderFrame(0x1f, 0x785634)), "1f 34 56 78 79 bc");
  assert.equal(hexs(withCrc(new Uint8Array([0x9f, 0x34, 0x56, 0x78]))), "9f 34 56 78 50 7c");
  assert.equal(hexs(floaderFrame(1, 0x040000, new Uint8Array([4, 0]))), "01 00 00 04 04 00 42 cb");
  assert.equal(hexs(floaderFrame(3, 0x040000)), "03 00 00 04 01 a3");
  assert.ok(crcOk(floaderFrame(2, 0x1000, new Uint8Array([1, 2, 3]))));
  const bad = floaderFrame(2, 0x1000, new Uint8Array([1, 2, 3]));
  bad[4] ^= 1;
  assert.ok(!crcOk(bad));
});

test("protected regions are refused unless allowed", () => {
  assert.throws(() => checkWritable(0x0, 0x1000, false), TagError);
  assert.throws(() => checkWritable(0x7a000, 0x2000, false), TagError);
  assert.doesNotThrow(() => checkWritable(0xd000, 0x6e000, false));
  assert.doesNotThrow(() => checkWritable(0x0, 0x80000, true));
});

// ---- activation, detect ----------------------------------------------------

test("detect: UART_BAUD, activate, verify 0xb2, load + read back floader, run, identify", async () => {
  const { sim, s, close } = await setup();
  const { info, activated } = await s.detect();
  assert.equal(activated, true);
  assert.equal(info.chipId, 0x5562);
  assert.equal(info.jedec, 0x856013);
  assert.equal(info.size, FLASH_SIZE);
  assert.equal(info.floaderVersion, "1.1");
  assert.equal(info.supported, true);
  const cmds = sim.commands.map((c) => c.cmd);
  // Order: PING, UART_BAUD, alive probe (UART_XFER), ACTIVATE, WRITE 0xb2, READ 0xb2, WRITE floader, READ back, CPU_RUN, version, JEDEC
  assert.deepEqual(cmds, [CMD.PING, CMD.UART_BAUD, CMD.UART_XFER, CMD.ACTIVATE, CMD.WRITE, CMD.READ,
    CMD.WRITE, CMD.READ, CMD.CPU_RUN, CMD.UART_XFER, CMD.UART_XFER]);
  assert.equal(sim.commands[1].addr, 230400);
  assert.equal(sim.commands[3].addr, 600);
  assert.deepEqual([sim.commands[4].addr, sim.commands[4].len], [0xb2, 1]);
  assert.equal(sim.commands[6].addr, 0x40000);
  // Second detect: floader already running, no re-activation.
  const again = await s.detect();
  assert.equal(again.activated, false);
  assert.equal(sim.commands.filter((c) => c.cmd === CMD.ACTIVATE).length, 1);
  assert.equal(sim.commands.filter((c) => c.cmd === CMD.UART_BAUD).length, 1);
  await close();
});

test("detect with no tag on the fixture says so", async () => {
  const { s, close } = await setup({ present: false });
  await assert.rejects(s.detect(), (e) => e instanceof TagError && /No reply from the tag/.test(e.message) && /pogo/.test(e.hint));
  await close();
});

test("detect with a tag whose UART does not answer", async () => {
  const { tag, s, close } = await setup();
  tag.dropReplies = 1000;
  await assert.rejects(s.detect(), (e) => e instanceof TagError && /floader does not answer/.test(e.message));
  await close();
});

test("detect with no floader.bin and floader not running", async () => {
  const { pico, close } = await setup();
  const s = new TagSession(pico, { floaderBin: null });
  await assert.rejects(s.detect(), /floader.bin is not available/);
  await close();
});

test("wrong chip ID: detect reports it, writes are refused", async () => {
  const { s, tag, close } = await setup({ chipId: 0x5316 });
  const { info } = await s.detect();
  assert.equal(info.supported, false);
  assert.match(info.problems[0], /chip ID is 0x5316/);
  const before = tag.flash.slice();
  await assert.rejects(s.writeImage(0xd000, new Uint8Array(4096), { requireBackup: false }), /Refusing to write/);
  await assert.rejects(s.restore(new Uint8Array(FLASH_SIZE)), /Refusing to write/);
  assertBytes(tag.flash, before, "flash");
  await close();
});

test("wrong flash size is refused too", async () => {
  const { s, close } = await setup({ jedec: 0x856014 });
  const { info } = await s.detect();
  assert.equal(info.supported, false);
  await assert.rejects(s.writeImage(0xd000, new Uint8Array(4096), { requireBackup: false }), /Refusing/);
  await close();
});

// ---- dump ------------------------------------------------------------------

test("backup reads the whole flash twice and returns it", async () => {
  const { s, tag, sim, close } = await setup();
  const phases = new Set();
  const img = await s.backupFlash({ progress: (p) => phases.add(p.phase) });
  assertBytes(img, tag.flash, "backup");
  assert.deepEqual([...phases], ["read", "verify"]);
  const reads = xfers(sim).filter((c) => c.len === 8); // floader read frames: 4 + u16 + CRC
  assert.equal(reads.length, 2 * FLASH_SIZE / 1024);
  assert.ok(s.backup);
  await close();
});

test("backup fails when the two reads disagree", async () => {
  const { s, tag, close } = await setup();
  await s.detect();
  tag.readGlitches = 1; // one bad byte with a valid CRC: only the second read can catch it
  await assert.rejects(s.backupFlash(), /two reads of the flash differ in 1 sector/);
  assert.ok(s.backup === null, "backup should be cleared");
  await close();
});

// ---- retries ----------------------------------------------------------------

test("dropped and corrupted floader replies are retried", async () => {
  const { s, tag, close } = await setup();
  await s.detect();
  const fl = s.floader;
  tag.dropReplies = 2;
  assertBytes(await fl.read(0x1000, 4096), tag.flash.subarray(0x1000, 0x2000), "read");
  tag.corruptReplies = 3;
  assertBytes(await fl.read(0x2000, 2048), tag.flash.subarray(0x2000, 0x2800), "read");
  assert.equal(fl.retries, 5);
  tag.dropReplies = 4; // all four tries lost
  await assert.rejects(fl.read(0x0, 1024), (e) => e instanceof TagError && /failed 4 times/.test(e.message));
  await close();
});

// ---- flash ------------------------------------------------------------------

test("writes need a backup from this session unless overridden", async () => {
  const { s, close } = await setup();
  await s.detect();
  await assert.rejects(s.writeImage(0xd000, new Uint8Array(4096)), /No backup of this tag/);
  await close();
});

test("flash: unlock, skip matching sectors, write + verify the rest, reboot", async () => {
  const { s, tag, sim, logs, close } = await setup();
  await s.backupFlash();
  // Image at 0x0 over the bootloader: sectors 0, 2, 5 keep their content.
  const img = randomBytes(6 * SECTOR - 100, 5);
  for (const i of [0, 2, 5]) img.set(tag.flash.subarray(i * SECTOR, (i + 1) * SECTOR).subarray(0, Math.min(SECTOR, img.length - i * SECTOR)), i * SECTOR);
  // Sector 5 is partial: the padded tail (0xff) must also match for it to be skipped.
  tag.flash.fill(0xff, 5 * SECTOR + (img.length - 5 * SECTOR), 6 * SECTOR);
  img.fill(0xff, 3 * SECTOR + 0x100, 3 * SECTOR + 0x300); // two blank pages: skipped when programming
  const tail = tag.flash.slice(6 * SECTOR);
  const r = await s.writeImage(0, img, { allowProtected: true });
  assert.deepEqual(r.written, [0x1000, 0x3000, 0x4000]);
  assert.equal(r.total, 6);
  assertBytes(tag.flash.subarray(0, img.length), img, "flash");
  assertBytes(tag.flash.subarray(6 * SECTOR), tail, "flash tail");
  // floader's reboot: UART_XFER with rx_len 0; the stock-like tag re-locks on boot.
  const last = xfers(sim).at(-1);
  assert.equal(last.addr & 0xffff, 0);
  assert.ok(tag.log.includes("booted flash firmware"));
  assert.equal(tag.locked, true);
  assert.ok(logs.some((l) => /wrote and verified 3 sector\(s\); 3 already matched/.test(l)));
  // Programming skipped the blank pages: 3 sectors x 16 pages - 2.
  const pageWrites = xfers(sim).filter((c) => c.len === 4 + 256 + 2);
  assert.equal(pageWrites.length, 3 * 16 - 2);
  await close();
});

test("flash refuses protected regions without the override, and unaligned addresses", async () => {
  const { s, close } = await setup();
  await s.backupFlash();
  await assert.rejects(s.writeImage(0, new Uint8Array(100)), /overlaps the Hanshow bootloader/);
  await assert.rejects(s.writeImage(0x7c000, new Uint8Array(100)), /per-tag configuration/);
  await assert.rejects(s.writeImage(0x10010, new Uint8Array(100)), /not a multiple of 4 KB/);
  await assert.rejects(s.writeImage(0x7f000, new Uint8Array(0x2000), { allowProtected: true }), /runs past the end/);
  await assert.rejects(s.writeImage(0x10000, new Uint8Array(0)), /empty/);
  await close();
});

test("a locked flash is detected: erase is acknowledged but nothing changes", async () => {
  const { s, tag, close } = await setup();
  await s.detect();
  assert.equal(tag.locked, true);
  const fl = new Floader(s.pico); // no unlock()
  const before = tag.flash.slice();
  await assert.rejects(fl.write(0x10000, randomBytes(SECTOR, 8)), /not blank after erase: the flash is write-protected/);
  assertBytes(tag.flash, before, "flash");
  assert.ok(tag.log.some((l) => /erase 10000 ignored/.test(l)));
  await fl.unlock();
  const data = randomBytes(SECTOR, 8);
  await fl.write(0x10000, data);
  assertBytes(tag.flash.subarray(0x10000, 0x11000), data, "flash");
  await close();
});

test("flash survives dropped replies during erase/program", async () => {
  const { s, tag, close } = await setup();
  await s.backupFlash();
  const data = randomBytes(2 * SECTOR, 11);
  // The compare reads (2 sectors x 4 chunks) come first; drop replies after that.
  const orig = tag.uartRx.bind(tag);
  let n = 0;
  tag.uartRx = (frame, baud) => {
    n++;
    if (n === 12 || n === 13 || n === 20) tag.dropReplies++;
    return orig(frame, baud);
  };
  await s.writeImage(0x20000, data, { reboot: false });
  assertBytes(tag.flash.subarray(0x20000, 0x22000), data, "flash");
  assert.ok(s.floader.retries >= 3);
  await close();
});

test("swapping the tag invalidates the session backup", async () => {
  const { s, sim, close } = await setup();
  await s.backupFlash();
  assert.ok(s.backup);
  // A different tag goes on the fixture: floader is not running on it.
  sim.tag = new SimTag({ floaderBin: FLOADER, flash: randomBytes(FLASH_SIZE, 77) });
  const { activated } = await s.detect();
  assert.equal(activated, true);
  assert.ok(s.backup === null, "backup should be cleared");
  await assert.rejects(s.writeImage(0xd000, new Uint8Array(100)), /No backup of this tag/);
  await close();
});

// ---- restore, reboot --------------------------------------------------------

test("restore refuses a file that is not exactly the flash size", async () => {
  const { s, tag, close } = await setup();
  const before = tag.flash.slice();
  await assert.rejects(s.restore(new Uint8Array(FLASH_SIZE - 1)), /exactly 524288 bytes/);
  await assert.rejects(s.restore(new Uint8Array(94396)), /this file is 94396 bytes/);
  assertBytes(tag.flash, before, "flash");
  await close();
});

test("restore writes a full image at 0x0 without needing a session backup", async () => {
  const { s, tag, close } = await setup();
  const image = tag.flash.slice();
  // The tag was flashed with something else in the bootloader and config regions.
  tag.flash.set(randomBytes(0x3000, 21), 0);
  tag.flash.set(randomBytes(0x1000, 22), 0x7d000);
  const r = await s.restore(image);
  assert.deepEqual(r.written, [0x0, 0x1000, 0x2000, 0x7d000]);
  assertBytes(tag.flash, image, "flash");
  await close();
});

test("reboot pulses NRST and the tag starts its flash firmware", async () => {
  const { s, tag, sim, close } = await setup();
  await s.detect();
  await s.reboot();
  const nrst = sim.commands.filter((c) => c.cmd === CMD.NRST).map((c) => c.addr);
  assert.deepEqual(nrst, [0, 1]);
  assert.equal(tag.floaderRunning, false);
  assert.ok(tag.log.includes("booted flash firmware"));
  assert.equal(s.info, null);
  await close();
});

test("backup refuses an implausible flash size instead of allocating it", async () => {
  const { s, close } = await setup({ jedec: 0x85601f }); // would be 2 GB
  await assert.rejects(s.backupFlash(), /implausible size code 0x1f/);
  await close();
});

test("an oversized image is refused before anything is padded or written", async () => {
  const { s, tag, close } = await setup();
  const before = tag.flash.slice();
  await assert.rejects(s.writeImage(0x1000, new Uint8Array(FLASH_SIZE), { requireBackup: false, allowProtected: true }), /runs past the end/);
  assertBytes(tag.flash, before, "flash");
  await close();
});
