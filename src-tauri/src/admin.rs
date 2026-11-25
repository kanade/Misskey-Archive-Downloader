//! Commands of the admin app (Cargo feature `admin`).

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::io::AsyncBufReadExt;

use crate::{error_chain, with_headers};

#[derive(Deserialize)]
pub struct DbConfig {
    host: String,
    port: u16,
    database: String,
    user: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUser {
    id: String,
    username: String,
    token: Option<String>,
    is_suspended: bool,
    is_deleted: bool,
}

/// Look up a local user of Misskey's `user` table by username (case-insensitive). Read-only.
#[tauri::command]
pub async fn admin_find_user(db: DbConfig, username: String) -> Result<Option<LocalUser>, String> {
    let mut config = tokio_postgres::Config::new();
    config
        .host(&db.host)
        .port(db.port)
        .dbname(&db.database)
        .user(&db.user)
        .password(&db.password)
        .connect_timeout(Duration::from_secs(10));
    let (client, connection) = config
        .connect(tokio_postgres::NoTls)
        .await
        .map_err(|e| format!("PostgreSQL に接続できませんでした: {}", error_chain(&e)))?;
    let connection = tauri::async_runtime::spawn(connection);

    let row = client
        .query_opt(
            r#"SELECT id, username, token, "isSuspended", "isDeleted" FROM "user" WHERE "usernameLower" = $1 AND host IS NULL"#,
            &[&username.to_lowercase()],
        )
        .await
        .map_err(|e| format!("ユーザーを検索できませんでした: {}", error_chain(&e)));
    // Dropping the client ends the connection task.
    drop(client);
    let _ = connection.await;

    let Some(row) = row? else {
        return Ok(None);
    };
    let column = |e: tokio_postgres::Error| format!("列を読み取れませんでした: {}", error_chain(&e));
    let user = LocalUser {
        id: row.try_get(0).map_err(column)?,
        username: row.try_get(1).map_err(column)?,
        token: row.try_get(2).map_err(column)?,
        is_suspended: row.try_get(3).map_err(column)?,
        is_deleted: row.try_get(4).map_err(column)?,
    };
    Ok(Some(user))
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: Option<serde_json::Value>,
}

/// POST `body` as JSON to `url` and return the status with the parsed JSON body (None when empty).
/// Sent from Rust so that the webview's mixed-content and private-network rules do not apply.
#[tauri::command]
pub async fn admin_post_json(
    url: String,
    body: serde_json::Value,
    headers: Option<HashMap<String, String>>,
) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| error_chain(&e))?;
    let resp = with_headers(client.post(&url), headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| error_chain(&e))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| error_chain(&e))?;
    let body: Option<serde_json::Value> = if bytes.is_empty() {
        None
    } else if status.is_success() {
        Some(serde_json::from_slice(&bytes).map_err(|e| format!("{url}: invalid JSON: {e}"))?)
    } else {
        serde_json::from_slice(&bytes).ok()
    };
    Ok(HttpResponse { status: status.as_u16(), body })
}

/// The `ssh` process started by `admin_tunnel_open`.
#[derive(Default)]
pub struct TunnelState(tokio::sync::Mutex<Option<tokio::process::Child>>);

#[derive(Deserialize)]
pub struct Forward {
    host: String,
    port: u16,
}

/// Start `ssh -N -L ...` to `destination` and return the local port of each forward once all of them
/// accept connections. A previous tunnel is stopped first.
/// The PC's `ssh` command is used, so keys, ssh-agent, `~/.ssh/config` and Tailscale SSH work as in a terminal.
/// Its stderr is emitted line by line as `admin-tunnel-log`, and `admin-tunnel-closed` when it exits.
#[tauri::command]
pub async fn admin_tunnel_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, TunnelState>,
    destination: String,
    ssh_port: u16,
    forwards: Vec<Forward>,
) -> Result<Vec<u16>, String> {
    let destination = destination.trim();
    if destination.is_empty() || destination.starts_with('-') {
        return Err(format!("SSH の接続先が正しくありません: {destination}"));
    }

    let mut guard = state.0.lock().await;
    if let Some(mut previous) = guard.take() {
        let _ = previous.kill().await;
    }

    // The listeners are held until every port is chosen so that the OS hands out distinct ports.
    let mut listeners = Vec::new();
    for _ in &forwards {
        listeners.push(std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| error_chain(&e))?);
    }
    let local_ports = listeners
        .iter()
        .map(|l| l.local_addr().map(|a| a.port()))
        .collect::<Result<Vec<u16>, _>>()
        .map_err(|e| error_chain(&e))?;
    drop(listeners);

    let mut command = tokio::process::Command::new("ssh");
    command.args([
        "-N",
        "-T",
        // No prompts: there is no terminal to answer them.
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
    ]);
    command.arg("-p").arg(ssh_port.to_string());
    for (forward, local) in forwards.iter().zip(&local_ports) {
        let host = if forward.host.contains(':') {
            format!("[{}]", forward.host)
        } else {
            forward.host.clone()
        };
        command.arg("-L").arg(format!("127.0.0.1:{local}:{host}:{}", forward.port));
    }
    command
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // CREATE_NO_WINDOW: no console window for the child of a GUI app
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = command.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            "ssh コマンドが見つかりません。Windows の「オプション機能」で OpenSSH クライアントを追加してください".to_string()
        }
        _ => format!("ssh を起動できませんでした: {}", error_chain(&e)),
    })?;

    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&line).trim_end().to_string();
                        if !text.is_empty() {
                            let _ = app.emit("admin-tunnel-log", text);
                        }
                    }
                }
            }
            let _ = app.emit("admin-tunnel-closed", ());
        });
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| error_chain(&e))? {
            return Err(format!("ssh が終了しました（{status}）。理由はログ欄を参照してください"));
        }
        let mut ready = true;
        for port in &local_ports {
            if tokio::net::TcpStream::connect(("127.0.0.1", *port)).await.is_err() {
                ready = false;
                break;
            }
        }
        if ready {
            break;
        }
        if tokio::time::Instant::now() > deadline {
            let _ = child.kill().await;
            return Err("SSH のポート転送が 30 秒以内に使えるようになりませんでした。理由はログ欄を参照してください".into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    *guard = Some(child);
    Ok(local_ports)
}

/// Stop the tunnel started by `admin_tunnel_open`, if any.
#[tauri::command]
pub async fn admin_tunnel_close(state: tauri::State<'_, TunnelState>) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().await.take() {
        let _ = child.kill().await;
    }
    Ok(())
}

/// Stop the tunnel when the app exits.
pub fn close_tunnel(app: &tauri::AppHandle) {
    if let Ok(mut guard) = app.state::<TunnelState>().0.try_lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.start_kill();
        }
    }
}
