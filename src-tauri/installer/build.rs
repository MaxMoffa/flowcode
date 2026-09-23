use std::path::PathBuf;

/// The installer embeds the main app's already-built output (see
/// `src/payload.rs`) - it needs a real filesystem directory containing the
/// app binary (`flowcode.exe` on Windows, `flowcode` elsewhere),
/// `config/shortcuts.json` and, on Windows, the sideloaded ConPTY
/// (`conpty.dll`, `x64/OpenConsole.exe` - see `src-tauri/conpty/`) to embed
/// at compile time.
/// `FLOWCODE_STAGE_DIR` (set by `.github/workflows/release.yml`'s staging
/// step, or by hand for a local release build) points at that directory.
/// Left unset - e.g. plain `cargo check`/local iteration on the installer's
/// own UI - this falls back to an empty placeholder so the crate still
/// compiles; that placeholder is never what should actually ship.
fn main() {
    tauri_build::build();

    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let stage_dir = match std::env::var("FLOWCODE_STAGE_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => {
            println!(
                "cargo:warning=FLOWCODE_STAGE_DIR not set - embedding an empty placeholder payload, not a real flowcode binary"
            );
            let dir = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("stage");
            std::fs::create_dir_all(dir.join("config")).unwrap();
            std::fs::write(dir.join("config").join("shortcuts.json"), b"{}").unwrap();
            if windows {
                std::fs::write(dir.join("flowcode.exe"), []).unwrap();
                std::fs::create_dir_all(dir.join("x64")).unwrap();
                std::fs::write(dir.join("conpty.dll"), []).unwrap();
                std::fs::write(dir.join("x64").join("OpenConsole.exe"), []).unwrap();
            } else {
                std::fs::write(dir.join("flowcode"), []).unwrap();
            }
            dir
        }
    };

    let stage_dir = std::fs::canonicalize(&stage_dir).expect("FLOWCODE_STAGE_DIR must point at an existing directory");
    println!("cargo:rustc-env=FLOWCODE_STAGE_DIR={}", stage_dir.display());
    println!("cargo:rerun-if-env-changed=FLOWCODE_STAGE_DIR");
}
