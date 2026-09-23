fn main() {
    copy_sideloaded_conpty();
    tauri_build::build()
}

/// Puts `conpty/` (see its README) next to the built `flowcode.exe`, so
/// `tauri dev` / `cargo run` get the same ConPTY a release install does.
/// Best-effort: a running dev instance keeps `OpenConsole.exe` locked, and
/// failing the whole build over that would be worse than keeping the copy
/// that's already there.
fn copy_sideloaded_conpty() {
    println!("cargo:rerun-if-changed=conpty");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    // OUT_DIR is target/<profile>/build/<crate>-<hash>/out
    let Some(profile_dir) = out_dir.ancestors().nth(3) else { return };
    for rel in ["conpty.dll", "x64/OpenConsole.exe"] {
        let dest = profile_dir.join(rel);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::copy(std::path::Path::new("conpty").join(rel), dest);
    }
}
