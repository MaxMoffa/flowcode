//! Language of the backend's own user-facing text (errors shown in the UI,
//! native dialogs, the uninstaller's prompts). The frontend reports the
//! language it renders in (`set_ui_language`, see src/i18n/index.tsx); until
//! it does - or where there's no frontend at all, like the uninstaller - it
//! falls back to the operating system's language. Italian or English, same
//! as the frontend: anything that isn't Italian gets English.

use std::sync::atomic::{AtomicU8, Ordering};

const UNSET: u8 = 0;
const ITALIAN: u8 = 1;
const ENGLISH: u8 = 2;

static LANGUAGE: AtomicU8 = AtomicU8::new(UNSET);

/// Sets the language from a BCP 47 tag / base code ("it", "en", "it-IT"...).
pub fn set_language(code: &str) {
    let value = if code.to_ascii_lowercase().starts_with("it") { ITALIAN } else { ENGLISH };
    LANGUAGE.store(value, Ordering::Relaxed);
}

pub fn is_italian() -> bool {
    match LANGUAGE.load(Ordering::Relaxed) {
        ITALIAN => true,
        ENGLISH => false,
        _ => system_is_italian(),
    }
}

/// Picks the Italian or English wording of a fixed message.
pub fn tr(italian: &'static str, english: &'static str) -> &'static str {
    if is_italian() {
        italian
    } else {
        english
    }
}

#[cfg(target_os = "windows")]
fn system_is_italian() -> bool {
    use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
    // Primary language id: the low 10 bits of the LANGID. LANG_ITALIAN = 0x10.
    (unsafe { GetUserDefaultUILanguage() } & 0x3ff) == 0x10
}

#[cfg(not(target_os = "windows"))]
fn system_is_italian() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .find(|value| !value.is_empty())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("it"))
}
