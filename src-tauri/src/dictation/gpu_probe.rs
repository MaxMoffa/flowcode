//! Hidden CLI mode of this executable: lists the GPUs ggml sees and prints them
//! as JSON. Initializing ggml loads the Vulkan driver, which on some PCs crashes
//! in native code; run here, that kills only this child (see `engine::gpu_devices`).

/// Argument that selects the probe.
pub const ARGUMENT: &str = "--flowcode-gpu-probe";

/// Runs the probe and exits if the first argument asks for it.
pub fn run_gpu_probe_if_requested() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some(ARGUMENT) {
        use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX};
        // A driver crash must not pop a Windows error dialog in the user's face.
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX) };
        let devices = super::engine::enumerate_gpus_in_process();
        println!("{}", serde_json::to_string(&devices).unwrap_or_else(|_| "[]".into()));
        std::process::exit(0);
    }
}
