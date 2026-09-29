//! Taskbar / Dock hints for agent activity (see src/notifications): a badge
//! that says "an agent needs you" or "an agent finished", per window.
//!
//! Each OS gets what it can actually show - a coloured overlay on the
//! Windows taskbar button, a text/number badge on the macOS Dock, a launcher
//! count on Linux (only honoured by desktops that implement it, e.g. KDE).

use tauri::{AppHandle, Manager};

/// What the window's badge should say. `waiting` (agents that need input)
/// outranks `done` (an agent finished while nobody was looking); both zero
/// clears it.
#[tauri::command]
pub fn attention_set(app: AppHandle, label: String, waiting: u32, done: bool, flash: bool) {
    let Some(window) = app.get_webview_window(&label) else {
        return;
    };

    #[cfg(target_os = "windows")]
    {
        let icon = if waiting > 0 {
            Some(overlay_icon(AMBER, Some(waiting.min(9) as u8)))
        } else if done {
            Some(overlay_icon(GREEN, None))
        } else {
            None
        };
        let _ = window.set_overlay_icon(icon);
    }

    #[cfg(target_os = "macos")]
    {
        let text = if waiting > 0 {
            Some(waiting.to_string())
        } else if done {
            Some("•".to_string())
        } else {
            None
        };
        let _ = window.set_badge_label(text);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = window.set_badge_count(if waiting > 0 { Some(waiting as i64) } else { None });
    }

    if flash && waiting > 0 {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

#[cfg(target_os = "windows")]
const AMBER: [u8; 3] = [245, 158, 11];
#[cfg(target_os = "windows")]
const GREEN: [u8; 3] = [34, 197, 94];

/// 3x5 bitmaps of the digits 0-9, one row per entry, top bit = left pixel.
#[cfg(target_os = "windows")]
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// A filled circle with a white rim, and optionally a white digit inside.
/// Drawn by hand so no image assets (or fonts) have to ship per state.
/// Windows stretches the whole image over the badge slot, so the circle only
/// fills only part of the canvas - that is what keeps the badge
/// small.
#[cfg(target_os = "windows")]
fn overlay_icon(rgb: [u8; 3], digit: Option<u8>) -> tauri::image::Image<'static> {
    const SIZE: usize = 32;
    const SCALE: usize = 2; // each digit pixel is 2x2 -> 6x10 glyph
    const RADIUS: f32 = 8.0;
    let mut rgba = vec![0u8; SIZE * SIZE * 4];
    // Right of centre and a bit above it: Windows puts the slot's corner
    // out past the icon's, so hugging the canvas corner leaves the badge
    // floating beside the icon instead of over it.
    let (cx, cy) = (SIZE as f32 - RADIUS - 3.0, SIZE as f32 / 2.0 - 1.0);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            // Soft 1px edge instead of a hard cut, so it doesn't look jagged
            // once Windows scales it down.
            let coverage = (RADIUS - dist).clamp(0.0, 1.0);
            if coverage == 0.0 {
                continue;
            }
            let colour = if dist > RADIUS - 1.5 { [255, 255, 255] } else { rgb };
            let i = (y * SIZE + x) * 4;
            rgba[i..i + 3].copy_from_slice(&colour);
            rgba[i + 3] = (coverage * 255.0) as u8;
        }
    }
    if let Some(d) = digit {
        let glyph = DIGITS[(d % 10) as usize];
        let (gw, gh) = (3 * SCALE, 5 * SCALE);
        let (ox, oy) = (cx as usize - gw / 2, cy as usize - gh / 2);
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for py in 0..SCALE {
                    for px in 0..SCALE {
                        let i = ((oy + row * SCALE + py) * SIZE + ox + col * SCALE + px) * 4;
                        rgba[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}
