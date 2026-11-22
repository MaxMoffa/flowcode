//! The `#[tauri::command]`s of chat mode.

use super::*;

/// Whether the agent can start without downloading its adapter: it has its
/// own binary, or the managed install is in place.
#[tauri::command]
pub fn chat_adapter_ready(app: AppHandle, agent: String) -> bool {
    crate::acp_adapters::package(&agent).is_none() || crate::acp_adapters::installed_entry(&app, &agent).is_some()
}

#[tauri::command]
pub async fn chat_start(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, ChatState>,
    agent: String,
    cwd: String,
    profile: Option<String>,
    resume_session_id: Option<String>,
    strict_resume: Option<bool>,
    shell: Option<String>,
    tools: Option<ToolsConfig>,
    diagnosis: Option<String>,
) -> Result<ChatStarted, String> {
    let owner = window.label().to_string();
    // A diagnosis chat (the id of the crash report it investigates) gets the diagnosis tool whatever the settings say.
    if diagnosis.as_deref().is_some_and(|id| !crate::crash::report_pending(id)) {
        return Err("this crash report no longer exists".to_string());
    }
    let tools = ToolsConfig { diagnosis: diagnosis.clone(), ..tools.unwrap_or_default() };
    let extras = Extras { tools, link: None };
    let (chat, started) = {
        let app = app.clone();
        crate::blocking(move || start_blocking(app, owner, agent, cwd, profile, resume_session_id, strict_resume.unwrap_or(false), shell, extras))
            .await?
    };
    if diagnosis.is_some() {
        if let Err(error) = delegate::set_diagnosis_mode(&chat) {
            chat.kill();
            return Err(error);
        }
    }
    state.adopt(&app, chat)?;
    Ok(started)
}

/// The commands that write to the agent run on the blocking pool: a write to
/// an agent that stopped reading its stdin blocks until it reads again.
#[tauri::command]
pub async fn chat_prompt(app: AppHandle, chat_id: String, text: String, attachments: Option<Vec<Attachment>>) -> Result<(), String> {
    crate::blocking(move || {
        let attachments = attachments
            .unwrap_or_default()
            .into_iter()
            .map(|a| match a.upload.as_deref() {
                Some(id) => uploaded_attachment(id, &a.name, &a.mime),
                None => Ok(a),
            })
            .collect::<Result<Vec<_>, _>>()?;
        app.state::<ChatState>().prompt(&chat_id, text, attachments)
    })
    .await
}

/// Stores a file the composer attached, sent as raw bytes (the body) with
/// `x-name` (percent-encoded) as a header; returns the id `chat_prompt` takes
/// as `upload`. Big files as base64 inside a JSON invoke crashed the WebView.
#[tauri::command]
pub async fn chat_stage_attachment(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let name = crate::chat_images::percent_decode(name);
    let bytes = invoke_bytes(request.body())?;
    crate::blocking(move || stage_upload(&name, &bytes)).await
}

/// Deletes a file the composer staged but never sent.
#[tauri::command]
pub async fn chat_unstage_attachment(upload: String) -> Result<(), String> {
    crate::blocking(move || unstage_attachment(&upload)).await
}

/// The bytes of an upload invoke: the raw body, or `{"data": "<base64>"}` where
/// the webview can't send a raw body (Android's IPC goes through postMessage,
/// which turns everything into JSON).
pub(super) fn invoke_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    use base64::Engine;
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Json(value) => {
            let data = value.get("data").and_then(serde_json::Value::as_str).ok_or("expected the file's bytes")?;
            base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("bad file data: {e}"))
        }
    }
}

#[tauri::command]
pub async fn chat_resume_schedule(app: AppHandle, chat_id: String, at: u64, text: String, limit_id: String) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().schedule_resume(&chat_id, at, text, limit_id)).await
}

#[tauri::command]
pub async fn chat_resume_update(app: AppHandle, chat_id: String, text: Option<String>) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().update_resume(&chat_id, text)).await
}

#[tauri::command]
pub async fn chat_resume_cancel_all(app: AppHandle) -> Result<(), String> {
    crate::blocking(move || {
        app.state::<ChatState>().cancel_all_resumes();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn chat_cancel(app: AppHandle, chat_id: String) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().cancel(&chat_id)).await
}

#[tauri::command]
pub async fn chat_permission(
    app: AppHandle,
    chat_id: String,
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().permission(&chat_id, &request_id, option_id.as_deref())).await
}

#[tauri::command]
pub async fn chat_ask(
    app: AppHandle,
    chat_id: String,
    request_id: Value,
    action: String,
    content: Option<Value>,
) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().ask(&chat_id, &request_id, &action, content)).await
}

#[tauri::command]
pub async fn chat_set_mode(state: State<'_, ChatState>, chat_id: String, mode_id: String) -> Result<(), String> {
    state.set_mode(&chat_id, mode_id).await
}

#[tauri::command]
pub async fn chat_set_model(state: State<'_, ChatState>, chat_id: String, model_id: String) -> Result<(), String> {
    state.set_model(&chat_id, model_id).await
}

#[tauri::command]
pub async fn chat_set_thought(state: State<'_, ChatState>, chat_id: String, value: String) -> Result<(), String> {
    state.set_thought(&chat_id, value).await
}

#[tauri::command]
pub async fn chat_goal(state: State<'_, ChatState>, chat_id: String, action: String) -> Result<(), String> {
    state.goal_action(&chat_id, action).await
}

/// Resolves only once the agent is dead: the terminal handoff awaits it
/// before running `claude --resume` on the same session, which must not find
/// the chat's agent still holding it.
#[tauri::command]
pub async fn chat_close(app: AppHandle, chat_id: String) -> Result<(), String> {
    let state = app.state::<ChatState>();
    let session = lock(&state.sessions).remove(&chat_id);
    // Closing a chat closes the tasks it delegated.
    let children = session.as_ref().map_or_else(Vec::new, |session| state.take_children(&session.chat));
    state.changed();
    // Dropping the session kills the agent - `taskkill` / `kill` and the
    // wait for the exit included: not on an async worker.
    crate::blocking(move || {
        // What the chat showed last, for the next time this session opens.
        if let Some(session) = &session {
            if let Some(session_id) = session.chat.session_id.get() {
                persist_preview(&app, &lock(&session.chat.log), session_id);
            }
        }
        drop(session);
        drop(children);
        Ok(())
    })
    .await
}

/// Async: a whole log is cloned (and then serialized), not for the main thread.
#[tauri::command(async)]
pub fn chat_events(state: State<'_, ChatState>, chat_id: String, after_seq: u64) -> Result<Vec<ChatEvent>, String> {
    let chat = state.get(&chat_id)?;
    let events = lock(&chat.log).after(after_seq);
    Ok(events)
}

/// One page of a chat's log (`chat_events_page`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEventsPage {
    pub events: Vec<ChatEvent>,
    /// Older events exist: ask again with `before_seq` = `first_seq`.
    pub has_more: bool,
    /// `seq` of the page's first event (0 when empty).
    pub first_seq: u64,
}

/// The newest page of a chat's log, or the one before `before_seq`: starts at
/// a user turn (`Log::tail_page`). `limit` defaults to the first-page size.
/// Only the page is copied under the lock, so opening a long chat is fast.
#[tauri::command(async)]
pub fn chat_events_page(state: State<'_, ChatState>, chat_id: String, before_seq: Option<u64>, limit: Option<usize>) -> Result<ChatEventsPage, String> {
    let chat = state.get(&chat_id)?;
    let (events, has_more, first_seq) =
        lock(&chat.log).tail_page(before_seq, limit.unwrap_or(FIRST_PAGE_EVENTS).clamp(1, TAIL_PAGE_CAP), FIRST_PAGE_TURNS);
    Ok(ChatEventsPage { events, has_more, first_seq })
}

/// The saved preview of a session's last page (see `persist_preview`), raw
/// events as `chat_events` gives them; `None` when there is none.
#[tauri::command(async)]
pub fn chat_preview(app: AppHandle, session_id: String) -> Option<Vec<Value>> {
    read_preview(&app, &session_id)
}

/// Saves the chat's preview now (the view calls it when a turn ends).
#[tauri::command(async)]
pub fn chat_preview_save(state: State<'_, ChatState>, app: AppHandle, chat_id: String) -> Result<(), String> {
    let chat = state.get(&chat_id)?;
    if let Some(session_id) = chat.session_id.get() {
        persist_preview(&app, &lock(&chat.log), session_id);
    }
    Ok(())
}

/// The bytes of a stored chat image (an event's `flowcodeImageId` or a user
/// image's `id`), raw.
#[tauri::command]
pub async fn chat_image(id: String) -> Result<tauri::ipc::Response, String> {
    let bytes = crate::blocking(move || crate::chat_images::read(&id)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The bytes of an image file the agent mentioned by path, resolved in the
/// chat's folder (`chat_id`), raw.
#[tauri::command]
pub async fn chat_image_file(app: AppHandle, chat_id: Option<String>, path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = crate::blocking(move || {
        let file = app.state::<ChatState>().image_file(chat_id.as_deref(), &path)?;
        crate::chat_images::read_file(&file)
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The bytes of a web image (`https://...` in the agent's markdown), fetched by
/// the desktop with the hardened link-preview fetch, raw. The UI gates it behind
/// the user's setting; the command itself is not gated.
#[tauri::command]
pub async fn chat_image_url(url: String) -> Result<tauri::ipc::Response, String> {
    let (bytes, _) = crate::blocking(move || crate::link_preview::fetch_chat_image(url.trim())).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The absolute Windows path of a stored image (`id`) or of an image file the
/// agent mentioned (`chat_id` + `path`), for "open" and "show in folder".
#[tauri::command]
pub async fn chat_image_path(
    app: AppHandle,
    id: Option<String>,
    chat_id: Option<String>,
    path: Option<String>,
) -> Result<String, String> {
    crate::blocking(move || {
        let file = match (id, path) {
            (Some(id), None) => crate::chat_images::path_of(&id).ok_or_else(|| "missing".to_string())?,
            (None, Some(path)) => {
                let file = app.state::<ChatState>().image_file(chat_id.as_deref(), &path)?;
                // As `read_file` does: no stat of a network share (it would leak the user's NTLM hash).
                if !crate::fs::is_local_path(&file, false) || !crate::fs::links_stay_local(&file) || !file.is_file() {
                    return Err("missing".into());
                }
                file
            }
            _ => return Err("give either an id or a path".into()),
        };
        Ok(file.to_string_lossy().into_owned())
    })
    .await
}
