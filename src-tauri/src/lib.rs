use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;
use tauri::Emitter;

#[cfg(feature = "admin")]
mod admin;

/// `e` followed by its causes. reqwest and tokio-postgres leave the cause out of `Display`.
pub(crate) fn error_chain(e: &dyn std::error::Error) -> String {
    let mut message = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        message.push_str(&format!(": {s}"));
        source = s.source();
    }
    message
}

/// Adds the extra request headers (name → value) the frontend passed. Their values are not logged.
pub(crate) fn with_headers(
    mut request: reqwest::RequestBuilder,
    headers: Option<HashMap<String, String>>,
) -> reqwest::RequestBuilder {
    for (name, value) in headers.unwrap_or_default() {
        request = request.header(name, value);
    }
    request
}

/// Fetch a URL from Rust (no CORS) and return the raw bytes.
#[tauri::command]
async fn fetch_bytes(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<tauri::ipc::Response, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = with_headers(client.get(&url), headers).send().await.map_err(|e| {
        let message = error_chain(&e);
        log::warn!("fetch_bytes: error for {}: {}", url, message);
        message
    })?;
    if !resp.status().is_success() {
        log::warn!("fetch_bytes: HTTP {} for {}", resp.status(), url);
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| error_chain(&e))?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

struct SaveSession {
    path: PathBuf,
    file: File,
}

/// The file opened by `save_begin`, written by `save_write` and closed by `save_finish` / `save_abort`.
#[derive(Default)]
struct SaveState(Mutex<Option<SaveSession>>);

/// Ask for a destination with the native save dialog and open it for writing.
/// Returns the chosen path, or None if cancelled.
#[tauri::command]
async fn save_begin(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SaveState>,
    default_filename: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(&default_filename);
    if let Some(ext) = std::path::Path::new(&default_filename)
        .extension()
        .and_then(|e| e.to_str())
    {
        dialog = dialog.add_filter(ext.to_uppercase(), &[ext]);
    }
    let Some(path) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let file = File::create(&path).map_err(|e| e.to_string())?;

    let previous = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .replace(SaveSession { path: path.clone(), file });
    if let Some(prev) = previous {
        drop(prev.file);
        let _ = std::fs::remove_file(&prev.path);
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Append the raw request body to the file opened by `save_begin`.
#[tauri::command]
async fn save_write(
    state: tauri::State<'_, SaveState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("save_write expects a binary body".into());
    };
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = guard.as_mut().ok_or("no file is open for writing")?;
    session.file.write_all(data).map_err(|e| e.to_string())
}

/// Close the file opened by `save_begin` / `folder_open_file`.
#[tauri::command]
async fn save_finish(state: tauri::State<'_, SaveState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.take();
    Ok(())
}

/// Close and delete the partially written file.
#[tauri::command]
async fn save_abort(state: tauri::State<'_, SaveState>) -> Result<(), String> {
    let session = state.0.lock().map_err(|e| e.to_string())?.take();
    if let Some(session) = session {
        drop(session.file);
        std::fs::remove_file(&session.path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The folder created by `folder_begin` that `folder_open_file` writes into.
#[derive(Default)]
struct FolderState(Mutex<Option<PathBuf>>);

/// A single path segment: no separators, no drive/stream colon, not `.` or `..`.
fn is_plain_segment(s: &str) -> bool {
    let mut parts = Path::new(s).components();
    matches!((parts.next(), parts.next()), (Some(Component::Normal(_)), None))
        && !s.contains(['/', '\\', ':'])
}

/// Ask for a parent folder with the native dialog and create `dir_name` inside it.
/// Returns the created folder, or None if cancelled.
#[tauri::command]
async fn folder_begin(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FolderState>,
    dir_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    if !is_plain_segment(&dir_name) {
        return Err(format!("invalid folder name: {dir_name}"));
    }
    let Some(parent) = window.dialog().file().set_parent(&window).blocking_pick_folder() else {
        return Ok(None);
    };
    let root = parent.into_path().map_err(|e| e.to_string())?.join(&dir_name);
    if root.exists() {
        return Err(format!("{} は既に存在します", root.display()));
    }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(root.clone());
    Ok(Some(root.to_string_lossy().into_owned()))
}

/// Create `rel_path` (forward slashes, relative to the folder from `folder_begin`) and open it
/// for `save_write` / `save_finish`.
#[tauri::command]
async fn folder_open_file(
    folder: tauri::State<'_, FolderState>,
    save: tauri::State<'_, SaveState>,
    rel_path: String,
) -> Result<(), String> {
    let root = folder
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("no output folder is open")?;
    let mut path = root;
    for segment in rel_path.split('/') {
        if !is_plain_segment(segment) {
            return Err(format!("invalid path: {rel_path}"));
        }
        path.push(segment);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let file = File::create(&path).map_err(|e| e.to_string())?;
    let previous = save
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .replace(SaveSession { path, file });
    if let Some(prev) = previous {
        drop(prev.file);
        let _ = std::fs::remove_file(&prev.path);
    }
    Ok(())
}

/// Forget the output folder once everything has been written.
#[tauri::command]
async fn folder_finish(state: tauri::State<'_, FolderState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.take();
    Ok(())
}

/// Delete the folder created by `folder_begin` with everything written into it.
#[tauri::command]
async fn folder_abort(
    folder: tauri::State<'_, FolderState>,
    save: tauri::State<'_, SaveState>,
) -> Result<(), String> {
    if let Some(session) = save.0.lock().map_err(|e| e.to_string())?.take() {
        drop(session.file);
    }
    if let Some(root) = folder.0.lock().map_err(|e| e.to_string())?.take() {
        std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a Misskey auth page in an embedded window.
/// Intercepts the misskey-archive:// callback, emits "miauth-callback" with the session ID,
/// then closes the auth window automatically.
#[tauri::command]
async fn open_auth_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    // If an auth window is already open, bring it to front
    if let Some(w) = app.get_webview_window("auth") {
        let _ = w.set_focus();
        return Ok(());
    }

    let handle = app.clone();
    WebviewWindowBuilder::new(
        &app,
        "auth",
        tauri::WebviewUrl::External(url.parse().map_err(|e: url::ParseError| e.to_string())?),
    )
    .title("Misskey 認証")
    .inner_size(860.0, 700.0)
    .on_navigation(move |nav_url| {
        let s = nav_url.to_string();
        if s.starts_with("misskey-archive://") {
            // Extract session=<uuid>
            if let Some(session) = s
                .split("session=")
                .nth(1)
                .map(|p| p.split('&').next().unwrap_or(p).to_string())
            {
                let _ = handle.emit("miauth-callback", session);
            }
            // Close the auth window
            if let Some(w) = handle.get_webview_window("auth") {
                let _ = w.close();
            }
            return false; // block navigation to the custom scheme
        }
        true
    })
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Toggle the WebView DevTools open/closed.
#[tauri::command]
fn toggle_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
    Ok(())
}

/// The commands of both apps, followed by `$extra` (comma-separated, may be empty).
macro_rules! invoke_handler {
    ($($extra:tt)*) => {
        tauri::generate_handler![
            fetch_bytes,
            save_begin,
            save_write,
            save_finish,
            save_abort,
            folder_begin,
            folder_open_file,
            folder_finish,
            folder_abort,
            open_auth_window,
            toggle_devtools,
            $($extra)*
        ]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SaveState::default())
        .manage(FolderState::default())
        .setup(|app| {
            // Forward deep-link URLs to the webview as a custom event
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = handle.emit("deep-link-url", url.to_string());
                    }
                });
            }
            Ok(())
        });

    // The handler closure is passed to invoke_handler directly so that its argument type is inferred.
    #[cfg(feature = "admin")]
    let builder = builder
        .manage(admin::TunnelState::default())
        .invoke_handler(invoke_handler![
            admin::admin_find_user,
            admin::admin_post_json,
            admin::admin_tunnel_open,
            admin::admin_tunnel_close,
        ]);
    #[cfg(not(feature = "admin"))]
    let builder = builder.invoke_handler(invoke_handler![]);

    #[cfg(not(feature = "admin"))]
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    #[cfg(feature = "admin")]
    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                admin::close_tunnel(app);
            }
        });
}
