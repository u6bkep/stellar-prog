import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeRequest, decodeRequest, encodeReply, RxQueue, parseIdent, firmwareStatus,
  connectProgrammer, PicoSws, CMD, STATUS, MAX_PAYLOAD, RX_LIMIT,
} from "../site/js/protocol.js";
import { SimTag, SimProgrammer, SimBridgePort, randomBytes, assertBytes } from "./sim.js";

const FLOADER = randomBytes(1960, 99);

test("request encoding is cmd u8 | addr u32 LE | len u16 LE | payload", () => {
  const r = encodeRequest(CMD.READ, 0x00040000, new Uint8Array([0x00, 0x04]));
  assert.deepEqual([...r], [0x02, 0x00, 0x00, 0x04, 0x00, 0x02, 0x00, 0x00, 0x04]);
  assert.throws(() => encodeRequest(CMD.WRITE, 0, new Uint8Array(MAX_PAYLOAD + 1)), RangeError);
});

test("decodeRequest waits for a complete frame and reports bytes used", () => {
  const f = encodeRequest(CMD.WRITE, 0x1234, new Uint8Array([1, 2, 3]));
  for (let n = 0; n < f.length; n++) assert.equal(decodeRequest(f.subarray(0, n)), null);
  const two = new Uint8Array([...f, ...encodeRequest(CMD.PING)]);
  const d = decodeRequest(two);
  assert.equal(d.cmd, CMD.WRITE);
  assert.equal(d.addr, 0x1234);
  assert.deepEqual([...d.payload], [1, 2, 3]);
  assert.equal(d.used, f.length);
  assert.equal(decodeRequest(two.subarray(d.used)).cmd, CMD.PING);
  // Oversized len: no payload buffered.
  const big = new Uint8Array([1, 0, 0, 0, 0, 0x01, 0x08]); // len 2049
  assert.equal(decodeRequest(big).payload, null);
});

test("reply encoding is status u8 | len u16 LE | data", () => {
  assert.deepEqual([...encodeReply(STATUS.READ_TIMEOUT, new Uint8Array([5, 0]))], [1, 2, 0, 5, 0]);
});

test("RxQueue assembles reads across chunk boundaries", async () => {
  const q = new RxQueue();
  q.push(new Uint8Array([1]));
  q.push(new Uint8Array([2, 3, 4]));
  const p = q.take(6, Date.now() + 1000);
  setTimeout(() => q.push(new Uint8Array([5, 6, 7])), 5);
  assert.deepEqual([...(await p)], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...(await q.take(1, Date.now() + 10))], [7]);
  await assert.rejects(q.take(1, Date.now() + 20), { kind: "timeout" });
});

test("PING identity parsing, protocol 1 and 2", () => {
  assert.deepEqual(parseIdent("pico-sws 2 rp2350 v0.1.0"),
    { raw: "pico-sws 2 rp2350 v0.1.0", protocol: 2, board: "rp2350", version: "v0.1.0" });
  assert.deepEqual(parseIdent("pico-sws 1"), { raw: "pico-sws 1", protocol: 1, board: null, version: null });
  assert.equal(parseIdent("pico-sws 1 rp2350").board, "rp2350");
  assert.equal(parseIdent("pico-sws 1 rp2350").version, null);
  assert.equal(parseIdent(new TextEncoder().encode("pico-sws 2 rp2040 v1.2.3-4-gabc")).version, "v1.2.3-4-gabc");
  assert.equal(parseIdent("pico-sws"), null);
  assert.equal(parseIdent("pico-sws x"), null);
  assert.equal(parseIdent("rustprobe 2"), null);
  assert.equal(parseIdent(new Uint8Array([0xc0, 0, 0])), null);
});

test("firmware version comparison", () => {
  const id = (v, p = 2) => ({ protocol: p, board: "rp2350", version: v });
  assert.equal(firmwareStatus(id(null, 1), "v0.2.0").state, "protocol");
  assert.equal(firmwareStatus(id(null, 1), null).state, "protocol");
  assert.equal(firmwareStatus(id("v0.2.0"), "v0.2.0").state, "current");
  assert.equal(firmwareStatus(id("v0.1.9"), "v0.2.0").state, "old");
  assert.equal(firmwareStatus(id("v1.0.0"), "v0.2.0").state, "newer");
  assert.equal(firmwareStatus(id("v0.2.0-3-g1234567"), "v0.2.0").state, "different");
  assert.equal(firmwareStatus(id("abc1234-dirty"), "v0.2.0").state, "different");
  assert.equal(firmwareStatus(id("v0.2.0"), null).state, "unknown");
});

for (const chunk of [null, 1, "random"]) {
  test(`client works with replies split into chunks (${chunk ?? "whole"})`, async () => {
    const tag = new SimTag({ floaderBin: FLOADER });
    const sim = new SimProgrammer(tag, { chunk });
    const p = await connectProgrammer(sim);
    assert.equal(p.ident.protocol, 2);
    assert.equal(p.ident.board, "rp2350");
    assert.equal(p.ident.version, "v0.1.0");
    await p.activate(600);
    const data = randomBytes(5000, 3); // > MAX_PAYLOAD: split into 3 WRITEs / READs
    await p.write(0x40000, data);
    assertBytes(await p.read(0x40000, data.length), data, "RAM read-back");
    const writes = sim.commands.filter((c) => c.cmd === CMD.WRITE).map((c) => c.len);
    assert.deepEqual(writes, [2048, 2048, 904]);
    await p.close();
  });
}

test("wrong port: a silent UART bridge is reported as wrong-port", async () => {
  const tag = new SimTag({ floaderBin: FLOADER });
  const t0 = Date.now();
  await assert.rejects(connectProgrammer(new SimBridgePort(tag)), { kind: "wrong-port" });
  assert.ok(Date.now() - t0 < 1500);
});

test("wrong port: floader answering on the bridge is not mistaken for a programmer", async () => {
  const tag = new SimTag({ floaderBin: FLOADER });
  tag.activate();
  tag.ram.set(FLOADER);
  tag.run(); // floader running: the PING frame gets a bad-CRC reply C0 00 00 00 + CRC
  const bridge = new SimBridgePort(tag);
  await assert.rejects(connectProgrammer(bridge), { kind: "wrong-port" });
  assert.ok(bridge.written.length >= 1);
});

test("protocol-1 firmware connects but has no UART_XFER/BOOTSEL", async () => {
  const tag = new SimTag({ floaderBin: FLOADER });
  const p = await connectProgrammer(new SimProgrammer(tag, { protocol: 1, board: "rp2350" }));
  assert.equal(p.ident.protocol, 1);
  assert.equal(p.ident.version, null);
  assert.equal(firmwareStatus(p.ident, "v0.1.0").state, "protocol");
  await assert.rejects(p.uartXfer(new Uint8Array(6), 6, 300), { kind: "protocol" });
  await assert.rejects(p.bootsel(), { kind: "protocol" });
  // Without the client-side guard the firmware itself says BAD_CMD.
  p.ident = null;
  await assert.rejects(p.uartBaud(230400), { kind: "status", statusName: "BAD_CMD" });
  await p.close();
});

test("a lost reply times out, and the next request resyncs and works", async () => {
  const tag = new SimTag({ floaderBin: FLOADER });
  const sim = new SimProgrammer(tag);
  const p = await connectProgrammer(sim);
  sim.dropControlReplies = 1;
  await assert.rejects(p.request(CMD.END, 0, new Uint8Array(0), 200), { kind: "timeout" });
  assert.equal(p.desynced, true);
  assert.deepEqual(await p.ping(), p.ident);
  await p.close();
});

test("status errors: READ_TIMEOUT with no tag, BAD_ARG, BAD_LEN", async () => {
  const tag = new SimTag({ floaderBin: FLOADER, present: false });
  const sim = new SimProgrammer(tag);
  const p = await connectProgrammer(sim);
  await p.activate(600);
  await assert.rejects(p.read(0xb2, 1), { kind: "status", statusName: "READ_TIMEOUT", index: 0 });
  await assert.rejects(p.uartBaud(10), { kind: "status", statusName: "BAD_ARG" });
  const { status } = await p.request(CMD.PING, 0, new Uint8Array([1]));
  assert.equal(status, STATUS.BAD_LEN);
  await p.close();
});

test("BOOTSEL replies OK, then the port goes away", async () => {
  const tag = new SimTag({ floaderBin: FLOADER });
  const sim = new SimProgrammer(tag);
  const p = await connectProgrammer(sim);
  await p.bootsel();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(p.ping(), { kind: "closed" });
});

test("requests are serialized when issued concurrently", async () => {
  const tag = new SimTag({ floaderBin: FLOADER });
  const p = await connectProgrammer(new SimProgrammer(tag, { chunk: "random" }));
  const pings = await Promise.all([p.ping(), p.ping(), p.ping()]);
  for (const id of pings) assert.equal(id.protocol, 2);
  await p.close();
});

test("client-side PicoSws without connect still resyncs first", async () => {
  const tag = new SimTag({ floaderBin: FLOADER });
  const sim = new SimProgrammer(tag);
  const p = new PicoSws(sim);
  const t0 = Date.now();
  await p.ping();
  assert.ok(Date.now() - t0 >= 290);
  await p.close();
});

// ---- bounds: none of these may loop or allocate without limit --------------

/// A transport whose read() answers from `next()` (null = closed). Every
/// write triggers `onWrite`. Each stub below produces a bounded amount of data.
class StubTransport {
  constructor(next, onWrite = () => {}) { this.next = next; this.onWrite = onWrite; this.closed = false; }
  async write(b) { this.onWrite(b); }
  async read() {
    if (this.closed) return null;
    const v = await this.next();
    return this.closed ? null : v;
  }
  async close() { this.closed = true; }
}

test("a reply header with a huge length is rejected at once, not waited for", async () => {
  let pending = [];
  let wake = null;
  const t = new StubTransport(
    () => pending.length ? pending.shift() : new Promise((r) => { wake = r; }),
    () => { const v = new Uint8Array([0, 0xff, 0xff, 1, 2, 3]); if (wake) { const w = wake; wake = null; w(v); } else pending.push(v); });
  const p = new PicoSws(t);
  const t0 = Date.now();
  await assert.rejects(p.request(CMD.PING, 0, new Uint8Array(0), 5000), { kind: "garbage" });
  assert.ok(Date.now() - t0 < 1500, "should not wait for the timeout");
  assert.equal(p.desynced, true);
  await p.close();
});

test("a port streaming garbage overflows the bounded receive buffer", async () => {
  let n = 0;
  const t = new StubTransport(async () => {
    if (++n > 300) return new Promise(() => {}); // 300 KB total, then quiet
    await new Promise((r) => setImmediate(r));
    return new Uint8Array(1024).fill(0x41); // 'A' = status 0x41: garbage
  });
  const q = new RxQueue();
  for (let i = 0; i < 70; i++) q.push(new Uint8Array(1024));
  assert.ok(q.length <= RX_LIMIT);
  await assert.rejects(q.take(3, Date.now() + 100), { kind: "garbage" });
  await assert.rejects(q.take(RX_LIMIT + 1, Date.now()), RangeError);
  // Through the client: the stream never forms a valid reply; it fails, bounded.
  const p = new PicoSws(t);
  await assert.rejects(p.ping(2000), (e) => e.kind === "garbage" || e.kind === "timeout");
  assert.ok(p.rx.length <= RX_LIMIT);
  await p.close();
});

test("a transport that only ever returns empty chunks is given up on", async () => {
  const t = new StubTransport(async () => new Uint8Array(0));
  await assert.rejects(connectProgrammer(t), { kind: "closed" });
});

test("PING versions with and without the v prefix compare equal", () => {
  const id = { protocol: 2, board: "rp2040", version: "0.1.0" };
  assert.equal(firmwareStatus(id, "v0.1.0").state, "current");
  assert.equal(firmwareStatus(id, "v0.1.1").state, "old");
});

test("the simulator rejects a chunk size that would never advance", () => {
  assert.throws(() => new SimProgrammer(new SimTag(), { chunk: 0 }), RangeError);
});
