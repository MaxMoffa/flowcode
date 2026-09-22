use std::path::PathBuf;

/// The installer embeds the main app's already-built output (see
/// `src/payload.rs`) - it needs a real filesystem directory containing
/// `flowcode.exe` and `config/shortcuts.json` to embed at compile time.
/// `FLOWCODE_STAGE_DIR` (set by `.github/workflows/release.yml`'s staging
/// step, or by hand for a local release build) points at that directory.
/// Left unset - e.g. plain `cargo check`/local iteration on the installer's
/// own UI - this falls back to an empty placeholder so the crate still
/// compiles; that placeholder is never what should actually ship.
fn main() {
    tauri_build::build();

    let stage_dir = match std::env::var("FLOWCODE_STAGE_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => {
            println!(
                "cargo:warning=FLOWCODE_STAGE_DIR not set - embedding an empty placeholder payload, not a real flowcode.exe"
            );
            let dir = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("stage");
            std::fs::create_dir_all(dir.join("config")).unwrap();
            std::fs::write(dir.join("flowcode.exe"), []).unwrap();
            std::fs::write(dir.join("config").join("shortcuts.json"), b"{}").unwrap();
            dir
        }
    };

    let stage_dir = std::fs::canonicalize(&stage_dir).expect("FLOWCODE_STAGE_DIR must point at an existing directory");
    println!("cargo:rustc-env=FLOWCODE_STAGE_DIR={}", stage_dir.display());
    println!("cargo:rerun-if-env-changed=FLOWCODE_STAGE_DIR");
}
