//! Keeps vulkan-1.dll out of the executable's imports: on a PC without it (no
//! GPU driver, a VM, Remote Desktop) Windows would refuse to start the app.
//!
//! ggml resolves nearly all of Vulkan through `vkGetInstanceProcAddr`; only the
//! three functions below are linked by name. Defining them here means the
//! linker never takes them from vulkan-1.lib, and the DLL is loaded on first
//! use instead. Without it the Vulkan version query fails, ggml leaves its
//! Vulkan backend out, and dictation runs on the CPU.
//!
//! If a whisper.cpp update links another Vulkan function by name, vulkan-1.dll
//! comes back in the imports: check with `llvm-readobj --coff-imports`.

#![allow(non_snake_case)]

use std::ffi::{c_char, c_void, CStr};
use std::sync::OnceLock;
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};

type Function = unsafe extern "system" fn();
type GetInstanceProcAddr = unsafe extern "system" fn(*mut c_void, *const c_char) -> Option<Function>;
type CmdCopyBuffer = unsafe extern "system" fn(*mut c_void, u64, u64, u32, *const c_void);
type GetPhysicalDeviceFeatures2 = unsafe extern "system" fn(*mut c_void, *mut c_void);

/// VK_ERROR_INITIALIZATION_FAILED.
const INITIALIZATION_FAILED: i32 = -3;

struct Loader {
    get_instance_proc_addr: GetInstanceProcAddr,
    cmd_copy_buffer: CmdCopyBuffer,
    get_physical_device_features2: GetPhysicalDeviceFeatures2,
}

fn open() -> Option<Loader> {
    let name: Vec<u16> = "vulkan-1.dll\0".encode_utf16().collect();
    // System32 only: that's where drivers install it, and nothing dropped in
    // the app's or the current folder gets loaded instead.
    let library = unsafe { LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
    if library.is_null() {
        return None;
    }
    let find = |symbol: &CStr| unsafe { GetProcAddress(library, symbol.as_ptr().cast()) };
    let (get_instance_proc_addr, cmd_copy_buffer, get_physical_device_features2) =
        (find(c"vkGetInstanceProcAddr")?, find(c"vkCmdCopyBuffer")?, find(c"vkGetPhysicalDeviceFeatures2")?);
    // SAFETY: the signatures are the ones the Vulkan specification gives these names.
    unsafe {
        Some(Loader {
            get_instance_proc_addr: std::mem::transmute::<_, GetInstanceProcAddr>(get_instance_proc_addr),
            cmd_copy_buffer: std::mem::transmute::<_, CmdCopyBuffer>(cmd_copy_buffer),
            get_physical_device_features2: std::mem::transmute::<_, GetPhysicalDeviceFeatures2>(get_physical_device_features2),
        })
    }
}

fn loader() -> Option<&'static Loader> {
    static LOADER: OnceLock<Option<Loader>> = OnceLock::new();
    LOADER.get_or_init(open).as_ref()
}

/// Stands in for `vkEnumerateInstanceVersion` when there's no usable Vulkan:
/// ggml calls it unchecked and takes this failure as "no Vulkan here".
unsafe extern "system" fn no_vulkan_version(_version: *mut u32) -> i32 {
    INITIALIZATION_FAILED
}

/// # Safety
/// As Vulkan's `vkGetInstanceProcAddr`: `name` is a NUL-terminated string.
#[no_mangle]
pub unsafe extern "system" fn vkGetInstanceProcAddr(instance: *mut c_void, name: *const c_char) -> Option<Function> {
    let found = loader().and_then(|l| (l.get_instance_proc_addr)(instance, name));
    if found.is_none() && CStr::from_ptr(name).to_bytes() == b"vkEnumerateInstanceVersion" {
        return Some(std::mem::transmute::<unsafe extern "system" fn(*mut u32) -> i32, Function>(no_vulkan_version));
    }
    found
}

/// # Safety
/// As Vulkan's `vkCmdCopyBuffer`. Only reachable with a device, so with a loader.
#[no_mangle]
pub unsafe extern "system" fn vkCmdCopyBuffer(command_buffer: *mut c_void, source: u64, target: u64, count: u32, regions: *const c_void) {
    if let Some(l) = loader() {
        (l.cmd_copy_buffer)(command_buffer, source, target, count, regions);
    }
}

/// # Safety
/// As Vulkan's `vkGetPhysicalDeviceFeatures2`. Only reachable with a device, so with a loader.
#[no_mangle]
pub unsafe extern "system" fn vkGetPhysicalDeviceFeatures2(device: *mut c_void, features: *mut c_void) {
    if let Some(l) = loader() {
        (l.get_physical_device_features2)(device, features);
    }
}
