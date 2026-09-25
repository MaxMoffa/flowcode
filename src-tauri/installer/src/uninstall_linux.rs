//! Linux counterpart of `uninstall.rs`: entered from `main.rs` when the copy
//! of this installer left in the install dir (`uninstall`, see
//! `install::perform_install`) runs with `--uninstall` - which is what the
//! menu entry's "Uninstall Flowcode" action does.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::Command;

use crate::install::{desktop_dir, xdg_data_home, DESKTOP_FILE};
use flowcode_shared::i18n::tr;

fn title() -> &'static str {
    tr("Disinstalla Flowcode", "Uninstall Flowcode")
}

fn question() -> &'static str {
    tr("Vuoi disinstallare Flowcode da questo computer?", "Do you want to uninstall Flowcode from this computer?")
}

fn done() -> &'static str {
    tr("Flowcode è stato disinstallato.", "Flowcode has been uninstalled.")
}

/// A native yes/no where a dialog tool exists (GNOME/most distros ship
/// `zenity`, KDE `kdialog`), a terminal prompt when run from one.
fn confirm() -> bool {
    if let Ok(status) = Command::new("zenity").args(["--question", "--title", title(), "--text", question()]).status() {
        return status.success();
    }
    if let Ok(status) = Command::new("kdialog").args(["--title", title(), "--yesno", question()]).status() {
        return status.success();
    }
    if std::io::stdin().is_terminal() {
        println!("{} {}", question(), tr("[s/N]", "[y/N]"));
        let mut answer = String::new();
        let _ = std::io::stdin().read_line(&mut answer);
        return matches!(answer.trim().to_lowercase().as_str(), "s" | "si" | "sì" | "y" | "yes");
    }
    // Launched from the menu action with no dialog tool at all: that click
    // was already an explicit "uninstall".
    true
}

fn notify_done() {
    if Command::new("zenity").args(["--info", "--title", title(), "--text", done()]).status().is_ok() {
        return;
    }
    if Command::new("kdialog").args(["--title", title(), "--msgbox", done()]).status().is_ok() {
        return;
    }
    println!("{}", done());
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
