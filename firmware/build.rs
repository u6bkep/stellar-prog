use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

/// The firmware version PING reports (docs/protocol.md): the release tag from CI, else
/// `git describe`, else the crate version. One word: the PING reply is space-separated.
fn fw_version() -> String {
    println!("cargo:rerun-if-env-changed=STELLAR_PROG_VERSION");
    let described = || {
        // Re-describe when HEAD moves or the index changes; edits alone leave "-dirty" stale.
        println!("cargo:rerun-if-changed=../.git/HEAD");
        println!("cargo:rerun-if-changed=../.git/index");
        let out = Command::new("git").args(["describe", "--tags", "--always", "--dirty"]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    let version = env::var("STELLAR_PROG_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(described)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap());
    version.split_whitespace().collect::<Vec<_>>().join("-")
}

fn main() {
    println!("cargo:rustc-env=FW_VERSION={}", fw_version());

    let rp2040 = env::var_os("CARGO_FEATURE_RP2040").is_some();
    let rp2350 = env::var_os("CARGO_FEATURE_RP2350").is_some();
    let memory: &[u8] = match (rp2040, rp2350) {
        (true, false) => include_bytes!("memory-rp2040.x"),
        (false, true) => include_bytes!("memory-rp2350.x"),
        _ => panic!("enable exactly one of the rp2040 / rp2350 features (rp2350: --no-default-features)"),
    };
    let out = &PathBuf::from(env::var_os("OUT_DIR").unwrap());
    File::create(out.join("memory.x")).unwrap().write_all(memory).unwrap();
    println!("cargo:rustc-link-search={}", out.display());
    println!("cargo:rerun-if-changed=memory-rp2040.x");
    println!("cargo:rerun-if-changed=memory-rp2350.x");
    println!("cargo:rustc-link-arg-bins=--nmagic");
    println!("cargo:rustc-link-arg-bins=-Tlink.x");
    if rp2040 {
        println!("cargo:rustc-link-arg-bins=-Tlink-rp.x"); // boot2 section
    }
    println!("cargo:rustc-link-arg-bins=-Tdefmt.x");
}
