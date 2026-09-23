//! Linux counterpart of `uninstall.rs`: entered from `main.rs` when the copy
//! of this installer left in the install dir (`uninstall`, see
//! `install::perform_install`) runs with `--uninstall` - which is what the
//! menu entry's "Disinstalla Flowcode" action does.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::Command;

use crate::install::{desktop_dir, xdg_data_home, DESKTOP_FILE};

const TITLE: &str = "Disinstalla Flowcode";
const QUESTION: &str = "Vuoi disinstallare Flowcode da questo computer?";
const DONE: &str = "Flowcode è stato disinstallato.";

/// A native yes/no where a dialog tool exists (GNOME/most distros ship
/// `zenity`, KDE `kdialog`), a terminal prompt when run from one.
fn confirm() -> bool {
    if let Ok(status) = Command::new("zenity").args(["--question", "--title", TITLE, "--text", QUESTION]).status() {
        return status.success();
    }
    if let Ok(status) = Command::new("kdialog").args(["--title", TITLE, "--yesno", QUESTION]).status() {
        return status.success();
    }
    if std::io::stdin().is_terminal() {
        println!("{QUESTION} [s/N]");
        let mut answer = String::new();
        let _ = std::io::stdin().read_line(&mut answer);
        return matches!(answer.trim().to_lowercase().as_str(), "s" | "si" | "sì" | "y" | "yes");
    }
    // Launched from the menu action with no dialog tool at all: that click
    // was already an explicit "uninstall".
    true
}

fn notify_done() {
    if Command::new("zenity").args(["--info", "--title", TITLE, "--text", DONE]).status().is_ok() {
        return;
    }
    if Command::new("kdialog").args(["--title", TITLE, "--msgbox", DONE]).status().is_ok() {
        return;
    }
    println!("{DONE}");
}

pub fn run() {
    if !confirm() {
        return;
    }

    let _ = std::fs::remove_file(xdg_data_home().join("applications").join(DESKTOP_FILE));
    let _ = std::fs::remove_file(desktop_dir().join(DESKTOP_FILE));

    // This binary lives inside the install dir; Linux lets a running
    // executable be unlinked, so removing the whole folder still works.
    let install_dir: Option<PathBuf> = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from));
    if let Some(dir) = install_dir {
        // Only a folder that actually looks like a Flowcode install - never
        // wherever a stray copy of the installer happened to be run from.
        if dir.join("flowcode").is_file() && dir.join("uninstall").is_file() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    notify_done();
}
