import test from "node:test";
import assert from "node:assert/strict";
import { parseUf2, filterFamily, familiesIn, familyName, coalesce, FAMILIES } from "../site/js/uf2.js";
import { CHIP_FAMILY } from "../site/js/picoboot.js";

/// One 512-byte UF2 block with a 256-byte payload of `fill`.
function block(addr, family, fill, { blockNo = 0, numBlocks = 1, notMain = false } = {}) {
  const b = new ArrayBuffer(512);
  const v = new DataView(b);
  v.setUint32(0, 0x0a324655, true);
  v.setUint32(4, 0x9e5d5157, true);
  v.setUint32(8, (family !== null ? 0x2000 : 0) | (notMain ? 1 : 0), true);
  v.setUint32(12, addr, true);
  v.setUint32(16, 256, true);
  v.setUint32(20, blockNo, true);
  v.setUint32(24, numBlocks, true);
  v.setUint32(28, family ?? 0, true);
  new Uint8Array(b, 32, 256).fill(fill);
  v.setUint32(508, 0x0ab16f30, true);
  return new Uint8Array(b);
}

function cat(...blocks) {
  const out = new Uint8Array(blocks.length * 512);
  blocks.forEach((b, i) => out.set(b, i * 512));
  return out.buffer;
}

// Like scripts/make-uf2.sh's pico-sws.uf2: the RP2040 image followed by the RP2350 one.
const combined = cat(
  block(0x10000000, FAMILIES.rp2040, 0x40, { blockNo: 0, numBlocks: 2 }),
  block(0x10000100, FAMILIES.rp2040, 0x41, { blockNo: 1, numBlocks: 2 }),
  block(0x10000000, FAMILIES["rp2350-arm-s"], 0x50, { blockNo: 0, numBlocks: 3 }),
  block(0x10000100, FAMILIES["rp2350-arm-s"], 0x51, { blockNo: 1, numBlocks: 3 }),
  block(0x10000300, FAMILIES["rp2350-arm-s"], 0x53, { blockNo: 2, numBlocks: 3 }),
  block(0x10ffff00, FAMILIES.absolute, 0xee, { notMain: false }),
);

test("combined UF2: each chip gets only its own family's blocks", () => {
  const blocks = parseUf2(combined);
  assert.deepEqual(familiesIn(blocks).map(familyName).sort(), ["absolute", "rp2040", "rp2350-arm-s"]);

  const r40 = coalesce(filterFamily(blocks, CHIP_FAMILY.rp2040));
  assert.deepEqual(r40.map((r) => [r.addr, r.data.length]), [[0x10000000, 512]]);
  assert.equal(r40[0].data[0], 0x40);
  assert.equal(r40[0].data[256], 0x41);

  const r50 = coalesce(filterFamily(blocks, CHIP_FAMILY.rp2350));
  // A gap at 0x10000200 splits the RP2350 image into two ranges.
  assert.deepEqual(r50.map((r) => [r.addr, r.data.length]), [[0x10000000, 512], [0x10000300, 256]]);
  assert.equal(r50[0].data[0], 0x50);
  assert.equal(r50[1].data[0], 0x53);
});

test("a single-family UF2 has nothing for the other chip", () => {
  const blocks = parseUf2(cat(block(0x10000000, FAMILIES.rp2040, 1)));
  assert.equal(filterFamily(blocks, CHIP_FAMILY.rp2350).length, 0);
});

test("blocks without a family pass any filter; not-main-flash blocks are skipped", () => {
  const blocks = parseUf2(cat(block(0x10000000, null, 1), block(0x20000000, FAMILIES.rp2040, 2, { notMain: true })));
  assert.equal(blocks.length, 1);
  assert.equal(filterFamily(blocks, CHIP_FAMILY.rp2350).length, 1);
});

test("malformed UF2 files are rejected", () => {
  assert.throws(() => parseUf2(new ArrayBuffer(100)), /not a multiple of 512/);
  const bad = block(0x10000000, FAMILIES.rp2040, 1);
  bad[0] ^= 1;
  assert.throws(() => parseUf2(cat(bad)), /bad UF2 magic/);
});
