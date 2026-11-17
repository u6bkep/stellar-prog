// Page wiring: programmer connection and update, tag operations, log.
// All protocol logic lives in protocol.js / floader.js / tag.js.

import { firmwareStatus, ProgrammerError, PROTOCOL } from "./protocol.js";
import { TagError, h6, SECTOR } from "./floader.js";
import { TagSession } from "./tag.js";
import { serialAvailable, grantedPorts, connectPort, SERIAL_FILTERS } from "./serial.js";
import { parseUf2, filterFamily, familiesIn, familyName, coalesce } from "./uf2.js";
import { Picoboot, requestBootromDevice, isBootromDevice, CHIP_FAMILY } from "./picoboot.js";

// pvvx/TlsrComProg825x @ 2de91fe, the floader this page was tested against.
const FLOADER_SHA256 = "d38e06e9283ad3db9dac883c07be0ea46d30ecd989073f422539de9430d11000";
const FLASH_SIZE = 512 * 1024;

const $ = (id) => document.getElementById(id);

const app = {
  manifest: null,
  pico: null, // connected PicoSws
  port: null, // its SerialPort
  session: null, // TagSession for it
  connecting: false,
  busy: false,
  floaderBin: null,
  tagFw: null, // bundled BLE firmware, fetched on first use
  binFile: null, // {name, data}
  restoreFile: null,
  uf2File: null, // ArrayBuffer
  uf2Bundled: null,
  boot: null, // open Picoboot
};

// ---- log and status lines ---------------------------------------------------

function log(line) {
  const el = $("log");
  const t = new Date().toTimeString().slice(0, 8);
  el.textContent += `${t} ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(id, text, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${cls}`;
}

function showBanner(id, kind, msg, hint = "") {
  const el = $(id);
  el.className = `banner ${kind}`;
  el.textContent = msg;
  if (hint) {
    const h = document.createElement("span");
    h.className = "hint";
    h.textContent = hint;
    el.append(h);
  }
}

function hideBanner(id) { $(id).className = "banner hidden"; }

function progress(id, frac) {
  const el = $(id);
  if (frac === null) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.value = frac;
}

/// {msg, hint} for any error, worded for someone at the bench.
function explain(e) {
  if (e instanceof TagError) return { msg: e.message, hint: e.hint };
  if (e instanceof ProgrammerError) {
    switch (e.kind) {
      case "closed":
        return { msg: "The programmer disconnected.", hint: "Plug it back in; the page reconnects by itself, or click Connect programmer." };
      case "timeout":
      case "garbage":
        return { msg: "The programmer stopped answering.", hint: "Unplug it, plug it back in, and try again." };
      case "protocol":
        return { msg: e.message, hint: "Update the programmer's firmware (section 1)." };
      default:
        return { msg: e.message, hint: "" };
    }
  }
  return { msg: e?.message ?? String(e), hint: "" };
}

function download(name, data, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function sha256hex(data) {
  const d = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const kb = (n) => `${Math.round(n / 1024)} KB`;

function table(id, rows) {
  const el = $(id);
  el.textContent = "";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const a = document.createElement("td"), b = document.createElement("td");
    a.textContent = k;
    b.textContent = v;
    tr.append(a, b);
    el.append(tr);
  }
  el.classList.toggle("hidden", rows.length === 0);
}

// ---- rendering ----------------------------------------------------------------

function render() {
  renderProgrammer();
  renderUpdate();
  renderTag();
}

function renderProgrammer() {
  const p = app.pico;
  $("btn-connect").disabled = app.busy || app.connecting || !serialAvailable();
  $("btn-disconnect").disabled = !p || app.busy;
  if (!p) {
    table("prog-info", []);
    if (!app.connecting) setStatus("prog-status", "Not connected.");
    return;
  }
  const bundled = app.manifest?.programmer?.version ?? null;
  const i = p.ident;
  table("prog-info", [
    ["board", i.board ?? "(not reported)"],
    ["firmware", i.version ?? "(not reported: old firmware)"],
    ["protocol", String(i.protocol)],
    ...(bundled ? [["bundled firmware", bundled]] : []),
  ]);
  setStatus("prog-status", "Connected.", "ok");
  const st = firmwareStatus(i, bundled);
  if (st.state === "protocol") showBanner("prog-banner", "error", st.message, "Open \"Update the programmer's firmware\" below.");
  else if (st.state === "old") showBanner("prog-banner", "warn", st.message);
  else if (st.state === "different" || st.state === "newer") showBanner("prog-banner", "warn", st.message, "Tag operations still work.");
  else hideBanner("prog-banner");
}

function haveUf2() {
  return $("uf2-src-file").checked ? !!app.uf2File : !!app.manifest?.programmer;
}

function renderUpdate() {
  const p = app.pico;
  $("btn-bootsel").disabled = !p || p.ident.protocol < 2 || app.busy;
  $("btn-bootrom").disabled = app.busy || !navigator.usb;
  $("btn-write-uf2").disabled = !app.boot || app.busy || !haveUf2();
}

function renderTag() {
  const p = app.pico, s = app.session;
  const ready = !!p && p.ident.protocol === PROTOCOL && !app.busy;
  const backup = s?.backup ?? null;
  const override = $("backup-override").checked;
  const mayWrite = !!backup || override;
  $("btn-detect").disabled = !ready;
  $("btn-backup").disabled = !ready;
  $("btn-reboot").disabled = !ready;
  $("btn-flash").disabled = !ready || !app.manifest?.tag_firmware || !mayWrite;
  $("btn-write-bin").disabled = !ready || !app.binFile || !mayWrite;
  $("btn-restore").disabled = !ready || !app.restoreFile;

  if (s?.info) {
    const i = s.info;
    table("tag-info", [
      ["chip ID", `0x${i.chipId.toString(16)}${i.chipId === 0x5562 ? " (TLSR8359)" : ""}`],
      ["flash", `JEDEC ID ${h6(i.jedec)}, ${i.size ? kb(i.size) : "unknown size"}`],
      ["floader", `v${i.floaderVersion}`],
      ["supported", i.supported ? "yes" : `no: ${i.problems.join("; ")}`],
    ]);
  } else {
    table("tag-info", []);
  }

  if (backup) {
    $("backup-status").textContent =
      `Backup of this tag taken at ${backup.takenAt.toTimeString().slice(0, 8)}: ${backup.fileName}` +
      (backup.sha256 ? ` (SHA-256 ${backup.sha256.slice(0, 16)}…)` : "");
  } else {
    $("backup-status").textContent = "No backup of this tag yet.";
  }
  $("btn-backup-download").classList.toggle("hidden", !backup);
  $("btn-backup-download").disabled = app.busy;
  document.querySelector(".backup-box").classList.toggle("have", !!backup);

  const fw = app.manifest?.tag_firmware;
  let info = fw
    ? `Bundled BLE firmware: ${fw.file.split("/").pop()} (${fw.size} bytes), built from ` +
      `${fw.source.replace("https://github.com/", "")} at ${fw.commit.slice(0, 7)}.`
    : "No BLE firmware is bundled with this copy of the page; you can still write your own .bin under \"More\".";
  if (fw && !mayWrite) info += " Back up the tag first (or tick the box above) to enable Flash.";
  $("fw-info").textContent = info;

  if (!p && !app.busy) setStatus("tag-status", "Connect the programmer first.");
  else if (p && p.ident.protocol !== PROTOCOL && !app.busy) setStatus("tag-status", "Tag operations need the programmer firmware updated first.", "warn");
}

// ---- programmer connection --------------------------------------------------

function attach(pico, port) {
  app.pico = pico;
  app.port = port;
  app.session = new TagSession(pico, { log, floaderBin: app.floaderBin });
  log(`programmer connected: "${pico.ident.raw}"`);
  hideBanner("prog-banner");
  const st = firmwareStatus(pico.ident, app.manifest?.programmer?.version ?? null);
  if (st.state === "protocol" || st.state === "old") $("update-box").open = true;
  if (pico.ident.protocol === PROTOCOL) setStatus("tag-status", "Ready. Put a tag on the fixture and click Detect tag.");
  render();
}

async function detach(reason) {
  const p = app.pico;
  app.pico = app.port = app.session = null;
  if (p) await p.close();
  if (reason) log(reason);
  render();
}

/// Connect to a previously allowed port without a prompt, if one answers.
async function tryGranted() {
  if (app.pico || app.busy || app.connecting || !serialAvailable()) return false;
  app.connecting = true;
  render();
  try {
    for (const port of await grantedPorts()) {
      try {
        attach(await connectPort(port, log), port);
        return true;
      } catch (e) {
        log(e.kind === "wrong-port" ? "an allowed port did not answer (the programmer's UART port); trying the next" : `an allowed port failed: ${e.message}`);
      }
    }
    return false;
  } finally {
    app.connecting = false;
    render();
  }
}

$("btn-connect").addEventListener("click", async () => {
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: SERIAL_FILTERS });
  } catch {
    return; // chooser cancelled
  }
  if (app.pico) await detach();
  hideBanner("prog-banner");
  app.connecting = true;
  setStatus("prog-status", "Connecting…");
  render();
  try {
    attach(await connectPort(port, log), port);
  } catch (e) {
    if (e.kind === "wrong-port") {
      showBanner("prog-banner", "error",
        "That was the programmer's UART port, not its control port.",
        "Click Connect programmer again and pick the other pico-sws entry in the list.");
      log("the chosen port did not answer PING: it is the UART bridge port; forgetting it");
      try { await port.forget?.(); } catch { /* older browser */ }
    } else {
      const { msg, hint } = explain(e);
      showBanner("prog-banner", "error", msg, hint);
      log(`connect failed: ${msg}`);
    }
  } finally {
    app.connecting = false;
    render();
  }
});

$("btn-disconnect").addEventListener("click", () => detach("disconnected"));

if (serialAvailable()) {
  navigator.serial.addEventListener("connect", () => setTimeout(tryGranted, 500));
  navigator.serial.addEventListener("disconnect", (ev) => {
    if (ev.target === app.port) detach("the programmer was unplugged or restarted");
  });
}

// ---- programmer firmware update ----------------------------------------------

async function selectedUf2() {
  if ($("uf2-src-file").checked) {
    if (!app.uf2File) throw new Error("choose a .uf2 file first");
    return app.uf2File;
  }
  if (!app.uf2Bundled) {
    const r = await fetch(app.manifest.programmer.uf2);
    if (!r.ok) throw new Error(`could not load the bundled firmware (HTTP ${r.status})`);
    app.uf2Bundled = await r.arrayBuffer();
  }
  return app.uf2Bundled;
}

$("uf2-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  $("uf2-src-file").checked = true;
  try {
    const buf = await file.arrayBuffer();
    const fams = familiesIn(parseUf2(buf));
    app.uf2File = buf;
    $("uf2-file-info").textContent = `${file.name} (${kb(buf.byteLength)}, ${fams.map(familyName).join(" + ") || "no family"})`;
  } catch (e) {
    app.uf2File = null;
    $("uf2-file-info").textContent = `${file.name}: ${e.message}`;
  }
  render();
});
$("uf2-src-bundled").addEventListener("change", render);
$("uf2-src-file").addEventListener("change", render);

async function connectBootrom(device) {
  if (app.boot?.device === device) return;
  if (app.boot) { await app.boot.close(); app.boot = null; }
  try {
    const b = new Picoboot(device, log);
    await b.open();
    app.boot = b;
    $("bootrom-info").textContent = `connected: ${b.chip.toUpperCase()} bootloader`;
    setStatus("uf2-status", "Bootloader connected. Click Write firmware.");
    $("update-box").open = true;
  } catch (e) {
    $("bootrom-info").textContent = `could not open it: ${e.message}` +
      (navigator.platform.startsWith("Linux") ? " (on Linux, see the udev rule in Help)" : "");
  }
  render();
}

/// Wait up to `ms` for an already-allowed bootloader device to show up.
async function waitForBootrom(ms) {
  if (!navigator.usb) return null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = (await navigator.usb.getDevices()).find(isBootromDevice);
    if (d) return d;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

$("btn-bootsel").addEventListener("click", async () => {
  if (!app.pico) return;
  app.busy = true;
  render();
  try {
    await app.pico.bootsel();
    await detach("programmer restarting into its bootloader");
    setStatus("uf2-status", "Waiting for the bootloader to appear…");
    const dev = await waitForBootrom(5000);
    if (dev) await connectBootrom(dev);
    else setStatus("uf2-status", "The programmer is in bootloader mode. Now click Choose bootloader device… and pick it.");
  } catch (e) {
    setStatus("uf2-status", `failed: ${explain(e).msg}`, "warn");
  } finally {
    app.busy = false;
    render();
  }
});

$("btn-bootrom").addEventListener("click", async () => {
  let device;
  try {
    device = await requestBootromDevice();
  } catch {
    return; // chooser cancelled
  }
  await connectBootrom(device);
});

$("btn-write-uf2").addEventListener("click", async () => {
  if (!app.boot) return;
  app.busy = true;
  render();
  try {
    const buf = await selectedUf2();
    const all = parseUf2(buf);
    const blocks = filterFamily(all, CHIP_FAMILY[app.boot.chip]);
    if (blocks.length === 0) {
      throw new Error(`this .uf2 has nothing for an ${app.boot.chip.toUpperCase()} ` +
        `(it contains: ${familiesIn(all).map(familyName).join(", ") || "none"})`);
    }
    const ranges = coalesce(blocks);
    log(`writing ${ranges.reduce((n, r) => n + r.data.length, 0)} bytes of programmer firmware to the ${app.boot.chip}`);
    await app.boot.flashRanges(ranges, (frac, label) => {
      progress("uf2-progress", frac);
      setStatus("uf2-status", label);
    });
    await app.boot.close();
    app.boot = null;
    $("bootrom-info").textContent = "";
    setStatus("uf2-status", "Done. The programmer is restarting; the page reconnects when it comes back " +
      "(if it does not, click Connect programmer).", "ok");
    log("programmer firmware written and verified");
  } catch (e) {
    setStatus("uf2-status", `failed: ${e.message}`, "warn");
    log(`programmer update failed: ${e.message}`);
  } finally {
    progress("uf2-progress", null);
    app.busy = false;
    render();
  }
});

if (navigator.usb) {
  navigator.usb.addEventListener("connect", (ev) => {
    if (isBootromDevice(ev.device) && !app.boot && !app.busy) connectBootrom(ev.device);
  });
  navigator.usb.addEventListener("disconnect", (ev) => {
    if (app.boot && ev.device === app.boot.device) {
      app.boot = null;
      $("bootrom-info").textContent = "";
      render();
    }
  });
}

// ---- tag operations -------------------------------------------------------------

/// Run one tag operation with the buttons locked and errors reported.
async function runTag(label, fn) {
  if (app.busy || !app.session) return;
  app.busy = true;
  hideBanner("tag-banner");
  setStatus("tag-status", `${label}…`);
  render();
  try {
    await fn(app.session);
  } catch (e) {
    const { msg, hint } = explain(e);
    showBanner("tag-banner", "error", msg, hint);
    setStatus("tag-status", "");
    log(`${label} failed: ${msg}`);
    if (e instanceof ProgrammerError && e.kind === "closed") await detach();
  } finally {
    progress("tag-progress", null);
    app.busy = false;
    render();
  }
}

function writeProgress(p) {
  progress("tag-progress", p.total ? p.done / p.total : 1);
  setStatus("tag-status", p.phase === "compare"
    ? `Checking which sectors need writing: ${p.done} of ${p.total}`
    : `Writing and verifying sector ${Math.min(p.done + 1, p.total)} of ${p.total}`);
}

function saveBackup(backup) {
  download(backup.fileName, backup.data);
}

$("btn-detect").addEventListener("click", () => runTag("Detecting the tag", async (s) => {
  const { info } = await s.detect();
  if (info.supported) setStatus("tag-status", "Tag found: TLSR8359 with 512 KB flash.", "ok");
  else showBanner("tag-banner", "warn", `This tag is not supported: ${info.problems.join("; ")}.`,
    "The page can read it but will not write it.");
}));

$("btn-backup").addEventListener("click", () => runTag("Backing up", async (s) => {
  const data = await s.backupFlash({
    progress: (p) => {
      progress("tag-progress", p.done / p.total);
      setStatus("tag-status", `${p.phase === "read" ? "Reading" : "Reading again to verify"}: ${kb(p.done)} of ${kb(p.total)}`);
    },
  });
  const b = s.backup;
  b.fileName = `stellar-l3n-backup-${stamp()}.bin`;
  b.sha256 = crypto.subtle ? await sha256hex(data) : null;
  log(`backup ${b.fileName}: ${data.length} bytes${b.sha256 ? `, SHA-256 ${b.sha256}` : ""}`);
  saveBackup(b);
  setStatus("tag-status", "Backup read twice, verified, and saved to your downloads. Keep that file safe.", "ok");
}));

$("btn-backup-download").addEventListener("click", () => {
  if (app.session?.backup) saveBackup(app.session.backup);
});

$("backup-override").addEventListener("change", renderTag);

async function bundledTagFirmware() {
  if (app.tagFw) return app.tagFw;
  const fw = app.manifest.tag_firmware;
  const r = await fetch(fw.file);
  if (!r.ok) throw new Error(`could not load the bundled firmware (HTTP ${r.status})`);
  const data = new Uint8Array(await r.arrayBuffer());
  if (crypto.subtle && (await sha256hex(data)) !== fw.sha256) {
    throw new Error("the bundled firmware does not match its checksum; reload the page");
  }
  app.tagFw = data;
  return data;
}

const override = () => $("backup-override").checked;

$("btn-flash").addEventListener("click", () => {
  if (!confirm("Flash the BLE firmware onto this tag?\n\nThis replaces the Hanshow bootloader and firmware. " +
    "The original can only be put back from a backup of this tag.")) return;
  runTag("Flashing the BLE firmware", async (s) => {
    const fw = await bundledTagFirmware();
    const r = await s.writeImage(0, fw, {
      allowProtected: true, requireBackup: !override(), reboot: true, progress: writeProgress,
    });
    setStatus("tag-status", `Done: ${r.written.length} of ${r.total} sectors written and verified ` +
      `(${r.total - r.written.length} already matched). The tag is restarting with the BLE firmware.`, "ok");
  });
});

$("btn-reboot").addEventListener("click", () => runTag("Rebooting the tag", async (s) => {
  await s.reboot();
  setStatus("tag-status", "The tag restarted from its flash.", "ok");
}));

async function readChosen(input, infoId) {
  const file = input.files[0];
  if (!file) return null;
  if (file.size > 16 * 1024 * 1024) {
    $(infoId).textContent = `${file.name} is ${kb(file.size)}: far larger than the tag's flash`;
    return null;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, data };
}

$("bin-file").addEventListener("change", async (ev) => {
  app.binFile = await readChosen(ev.target, "bin-file-info");
  if (app.binFile) $("bin-file-info").textContent = `${app.binFile.name} (${app.binFile.data.length} bytes)`;
  render();
});

function parseAddr(text) {
  const s = text.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s, 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NaN;
}

$("btn-write-bin").addEventListener("click", () => {
  const f = app.binFile;
  const addr = parseAddr($("bin-addr").value);
  if (!Number.isFinite(addr)) {
    showBanner("tag-banner", "error", `"${$("bin-addr").value}" is not an address.`, "Write it as hex (0x10000) or decimal.");
    return;
  }
  if (addr % SECTOR) {
    showBanner("tag-banner", "error", `${h6(addr)} is not a multiple of 4 KB (0x1000).`);
    return;
  }
  if (!confirm(`Write ${f.name} (${f.data.length} bytes) to the tag at ${h6(addr)}?`)) return;
  runTag(`Writing ${f.name}`, async (s) => {
    const r = await s.writeImage(addr, f.data, {
      allowProtected: $("bin-protected").checked, requireBackup: !override(),
      reboot: $("bin-reboot").checked, progress: writeProgress,
    });
    setStatus("tag-status", `Done: ${r.written.length} of ${r.total} sectors written and verified` +
      ($("bin-reboot").checked ? "; the tag is restarting." : "."), "ok");
  });
});

$("restore-file").addEventListener("change", async (ev) => {
  app.restoreFile = await readChosen(ev.target, "restore-file-info");
  const f = app.restoreFile;
  if (f) {
    $("restore-file-info").textContent = f.data.length === FLASH_SIZE
      ? `${f.name} (512 KB)`
      : `${f.name} is ${f.data.length} bytes: a full backup is exactly ${FLASH_SIZE} bytes`;
    if (f.data.length !== FLASH_SIZE) app.restoreFile = null;
  }
  render();
});

$("btn-restore").addEventListener("click", () => {
  const f = app.restoreFile;
  if (!confirm(`Restore ${f.name} onto this tag?\n\nEverything on the tag's flash is replaced by the backup. ` +
    "Make sure the backup is from this tag: each tag has its own configuration data.")) return;
  runTag(`Restoring ${f.name}`, async (s) => {
    const r = await s.restore(f.data, { progress: writeProgress, reboot: true });
    setStatus("tag-status", `Restored: ${r.written.length} of ${r.total} sectors written and verified ` +
      `(${r.total - r.written.length} already matched). The tag is restarting.`, "ok");
  });
});

// ---- log ------------------------------------------------------------------------

$("btn-log-clear").addEventListener("click", () => { $("log").textContent = ""; });
$("btn-log-save").addEventListener("click", () => download(`stellar-prog-log-${stamp()}.txt`, $("log").textContent, "text/plain"));

window.addEventListener("beforeunload", (ev) => {
  if (app.busy) ev.preventDefault();
});

// ---- floader ---------------------------------------------------------------------

function setFloader(bin, from) {
  app.floaderBin = bin;
  if (app.session) app.session.floaderBin = bin;
  $("floader-state").textContent = `Using ${from}.`;
  $("floader-pick").classList.add("hidden");
}

async function loadBundledFloader() {
  const fl = app.manifest?.floader;
  if (!fl) return false;
  try {
    const r = await fetch(fl.file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bin = new Uint8Array(await r.arrayBuffer());
    if ((await sha256hex(bin)) !== FLOADER_SHA256) throw new Error("checksum mismatch");
    setFloader(bin, `the bundled copy (${bin.length} bytes, commit ${fl.commit.slice(0, 7)})`);
    return true;
  } catch (e) {
    log(`bundled floader unusable: ${e.message}`);
    return false;
  }
}

$("floader-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const bin = new Uint8Array(await file.arrayBuffer());
  if ((await sha256hex(bin)) !== FLOADER_SHA256) {
    $("floader-state").textContent = `${file.name} is not the expected floader.bin (SHA-256 mismatch); not used.`;
    return;
  }
  setFloader(bin, `${file.name} (checksum OK)`);
  log("floader.bin loaded from a file");
});

// ---- start --------------------------------------------------------------------------

async function loadManifest() {
  try {
    const r = await fetch("firmware/manifest.json", { cache: "no-cache" });
    if (r.ok) app.manifest = await r.json();
  } catch { /* running from the source tree */ }
  const m = app.manifest;
  if (m?.repo) $("repo-link").href = m.repo;
  $("site-version").textContent = m ? `stellar-prog ${m.version}` : "stellar-prog (development copy: no manifest)";

  const pr = m?.programmer;
  if (pr) {
    $("uf2-bundled-info").textContent = `pico-sws ${pr.version} for RP2040 and RP2350`;
    $("uf2-download").href = pr.uf2;
    $("uf2-download").classList.remove("hidden");
    $("uf2-download-none").classList.add("hidden");
  } else {
    $("uf2-bundled-info").textContent = "(not bundled with this copy)";
    $("uf2-src-bundled").disabled = true;
    $("uf2-src-file").checked = true;
  }
}

async function main() {
  const problems = [];
  if (!window.isSecureContext) problems.push("open it over https or from localhost");
  if (!serialAvailable()) problems.push("this browser has no Web Serial: use Chrome, Edge or another Chromium-based desktop browser");
  if (problems.length) {
    showBanner("browser-banner", "error", `This page cannot reach the programmer: ${problems.join("; ")}.`);
  } else if (!navigator.usb) {
    showBanner("browser-banner", "warn", "This browser has no WebUSB: updating the programmer works only by downloading the .uf2 and dragging it onto the bootloader drive.");
  }

  await loadManifest();
  if (!(await loadBundledFloader())) {
    $("floader-state").textContent = "This copy of the page has no bundled floader. Choose floader.bin below; " +
      "without it the page can only use a tag that already runs floader.";
    $("floader-pick").classList.remove("hidden");
  }
  render();

  if (serialAvailable()) {
    if (!(await tryGranted())) setStatus("prog-status", "Not connected. Plug in the programmer and click Connect programmer.");
  }
  if (navigator.usb && !app.pico) {
    const d = (await navigator.usb.getDevices()).find(isBootromDevice);
    if (d) {
      log("a programmer in bootloader mode is attached");
      await connectBootrom(d);
    }
  }
}

main().catch((e) => {
  console.error(e);
  showBanner("browser-banner", "error", `The page failed to start: ${e.message}`);
});
