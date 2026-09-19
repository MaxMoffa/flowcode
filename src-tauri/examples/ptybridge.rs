// Dev-only helper for scripts/codex-status-check.mjs on Windows: the
// original bridge (scripts/_ptybridge.py) uses POSIX-only modules (pty,
// fcntl, termios) and can't run here. This does the same job - stdin bytes
// to the pty, pty output to stdout - through the exact same `portable-pty`
// backend the real app uses, so what this sees is what the app would see.
// Usage: ptybridge <cols> <rows> [cwd]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cols: u16 = args[1].parse().expect("cols");
    let rows: u16 = args[2].parse().expect("rows");
    let cwd = args.get(3).cloned();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    let mut cmd = CommandBuilder::new(default_shell());
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let stdout = std::io::stdout();
                    let mut lock = stdout.lock();
                    if lock.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = lock.flush();
                }
            }
        }
    });

    let mut buf = [0u8; 4096];
    loop {
        match std::io::stdin().read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if writer.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = child.kill();
}
