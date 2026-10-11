// Hides the console window in release builds on Windows (desktop test mode).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flowcode_mobile_lib::run()
}
