// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flowcode_lib::run_provider_cli();
    flowcode_lib::run()
}
