//! Pairs with a running Flowcode desktop and walks the protocol once:
//!   cargo run --example smoke -- "flowcode://pair?t=..."
//! Uses a throwaway key, so it shows up on the desktop as a new device named
//! "smoke-test" (revoke it afterwards). Exits 0 on success, 1 with a message
//! on any failure.

use flowcode_mobile_lib::link;
use flowcode_remote_proto::{read_frame, write_frame, ClientMsg, PairingTicket, ServerMsg};
use std::time::{Duration, Instant};

fn step(msg: &str) {
    eprintln!("[smoke] {msg}");
}

async fn run(url: &str) -> Result<(), String> {
    let ticket = PairingTicket::parse(url).map_err(|e| format!("bad ticket: {e}"))?;
    step(&format!("ticket ok, desktop \"{}\"", ticket.host));
    let key = iroh::SecretKey::generate();
    step(&format!("device id {}", key.public()));
    let endpoint = link::bind(key).await?;
    step("endpoint up, dialing and pairing...");
    let started = Instant::now();
    let mut session = link::handshake(
        &endpoint,
        &ticket.node,
        ClientMsg::Pair { code: ticket.code.clone(), device_name: "smoke-test".into() },
    )
    .await
    .map_err(|e| format!("handshake failed: {}", e.message()))?;
    step(&format!("ready after {:?}: host \"{}\", device \"{}\"", started.elapsed(), session.host_name, session.device_name));
    println!("ready");
    println!("token issued: {}", if session.token.is_some() { "yes" } else { "NO" });

    write_frame(&mut session.send, &ClientMsg::List).await.map_err(|e| e.to_string())?;
    let mut tabs = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while tabs.is_none() {
        let left = deadline.saturating_duration_since(Instant::now());
        let msg = tokio::time::timeout(left, read_frame::<_, ServerMsg>(&mut session.recv))
            .await
            .map_err(|_| "no tabs list within 10 s".to_string())?
            .map_err(|e| e.to_string())?;
        match msg {
            ServerMsg::Tabs { tabs: t } => tabs = Some(t),
            ServerMsg::Error { message, .. } => return Err(format!("server error: {message}")),
            other => step(&format!("(early) {}", brief(&other))),
        }
    }
    let tabs = tabs.unwrap_or_default();
    println!("tabs ({}):", tabs.len());
    for t in &tabs {
        println!(
            "  {} [{}] window=\"{}\" label=\"{}\" cwd={} {}x{} cli={:?} status={:?}",
            t.pty_id, t.tab_id, t.window, t.label, t.cwd, t.cols, t.rows, t.cli, t.status
        );
    }
    let first = tabs.first().ok_or("the desktop has no terminal tab to open")?;
    write_frame(&mut session.send, &ClientMsg::Open { pty_id: first.pty_id.clone(), cols: Some(80), rows: Some(24) })
        .await
        .map_err(|e| e.to_string())?;
    step(&format!("opened {} at 80x24, listening for 2 s", first.pty_id));

    let end = Instant::now() + Duration::from_secs(2);
    let (mut snapshots, mut outputs, mut bytes) = (0, 0, 0usize);
    loop {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let Ok(msg) = tokio::time::timeout(left, read_frame::<_, ServerMsg>(&mut session.recv)).await else { break };
        match msg.map_err(|e| e.to_string())? {
            ServerMsg::Snapshot { cols, rows, data, .. } => {
                snapshots += 1;
                bytes += data.len();
                println!("snapshot {cols}x{rows}, {} bytes", data.len());
            }
            ServerMsg::Output { data, .. } => {
                outputs += 1;
                bytes += data.len();
                println!("output: {:?}", data.chars().take(120).collect::<String>());
            }
            ServerMsg::Error { message, fatal, .. } => return Err(format!("server error (fatal={fatal}): {message}")),
            other => step(&format!("(other) {}", brief(&other))),
        }
    }
    println!("got {snapshots} snapshot(s), {outputs} output frame(s), {bytes} bytes");
    if snapshots == 0 {
        return Err("no snapshot after open".into());
    }

    write_frame(&mut session.send, &ClientMsg::Close { pty_id: first.pty_id.clone() })
        .await
        .map_err(|e| e.to_string())?;
    step("closed, bye");
    session.conn.close(0u32.into(), b"bye");
    endpoint.close().await;
    Ok(())
}

fn brief(msg: &ServerMsg) -> String {
    let s = serde_json::to_string(msg).unwrap_or_default();
    s.chars().take(160).collect()
}

#[tokio::main]
async fn main() {
    let Some(url) = std::env::args().nth(1) else {
        eprintln!("usage: smoke \"<flowcode://pair?t=... ticket>\"");
        std::process::exit(2);
    };
    if let Err(e) = run(&url).await {
        eprintln!("[smoke] FAILED: {e}");
        std::process::exit(1);
    }
    println!("OK");
}
