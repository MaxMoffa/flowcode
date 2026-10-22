use base64::Engine;
use flowcode_shared::i18n::tr;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The picture behind the "Vetro" new tab layout. The frontend downscales the
/// user's image to a JPEG before handing it over, so one file is all it takes.
const FILE_NAME: &str = "newtab-background.jpg";
const MAX_BYTES: usize = 2 * 1024 * 1024;
const JPEG_MAGIC: [u8; 3] = [0xFF, 0xD8, 0xFF];

fn background_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE_NAME))
}

/// The JPEG inside `data_base64`, if it is one and fits.
fn decode_jpeg(data_base64: &str) -> Result<Vec<u8>, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.trim()).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err(tr("Immagine troppo grande (massimo 2 MB)", "Image is too large (2 MB at most)").to_string());
    }
    if !bytes.starts_with(&JPEG_MAGIC) {
        return Err(tr("L'immagine non è un JPEG", "The image is not a JPEG").to_string());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn newtab_background_set(app: AppHandle, data_base64: String) -> Result<(), String> {
    let path = background_path(&app)?;
    crate::blocking(move || {
        let bytes = decode_jpeg(&data_base64)?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())
    })
    .await
}

/// The stored picture as a `data:` URL, or None when there is none.
#[tauri::command]
pub async fn newtab_background_get(app: AppHandle) -> Result<Option<String>, String> {
    let path = background_path(&app)?;
    crate::blocking(move || match std::fs::read(path) {
        Ok(bytes) => Ok(Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
}

#[tauri::command]
pub fn newtab_background_clear(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(background_path(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_small_jpeg() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF, 0xE0, 0, 1]);
        assert_eq!(decode_jpeg(&encoded).unwrap(), vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 1]);
    }

    #[test]
    fn rejects_other_files_and_big_ones() {
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G']);
        assert!(decode_jpeg(&png).is_err());
        assert!(decode_jpeg("not base64!").is_err());
        let mut big = vec![0xFF, 0xD8, 0xFF];
        big.resize(MAX_BYTES + 1, 0);
        assert!(decode_jpeg(&base64::engine::general_purpose::STANDARD.encode(big)).is_err());
    }
}
