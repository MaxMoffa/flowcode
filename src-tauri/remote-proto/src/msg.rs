//! Message types. Both enums are tagged by `"t"` (lowercase variant name) and
//! their fields are camelCase on the wire.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum ClientMsg {
    /// First message of a new device: trades the pairing code for a token.
    Pair { code: String, device_name: String },
    /// First message of a known device.
    Auth { token: String },
    List,
    /// What this phone can do beyond the base protocol, sent once after `ready`
    /// to a desktop that listed the matching capability. `compress`: it reads
    /// deflated frames (see `write_frame_with`), so the desktop may send them.
    Hello { caps: Vec<String> },
    /// Start streaming a pty (snapshot first). With `cols`/`rows` the pty is
    /// resized to the phone's screen while it stays open.
    Open {
        pty_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cols: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rows: Option<u16>,
    },
    Resize { pty_id: String, cols: u16, rows: u16 },
    Close { pty_id: String },
    /// Keystrokes, at most `MAX_INPUT_BYTES`.
    Input { pty_id: String, data: String },
    /// Run one of the actions the desktop published in `actions`.
    Action {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pty_id: Option<String>,
    },
    /// Rename the desktop tab showing `pty_id`, as the user would on the desktop. At most 128 bytes; blank is ignored.
    Rename { pty_id: String, label: String },
    /// Close the desktop tab showing `pty_id`, as the user would on the desktop. The last tab of a window is left open.
    CloseTab { pty_id: String },
    /// List a directory under the tab's working directory.
    Ls {
        pty_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    /// Read a text file under the tab's working directory.
    Read { pty_id: String, path: String },
    /// Change one desktop setting the phone mirrors (see `ServerMsg::Settings`).
    /// The desktop validates `key` and the value's type and ignores anything else.
    Set { key: String, value: serde_json::Value },
    /// Manage the account profiles (see `ServerMsg::Profiles`). `op` is
    /// `create` (`name`, `color`, optional `copySettings`), `update` (`id`,
    /// `name`, `color`), `delete` (`id`, optional `deleteFiles`), `login`
    /// (`id`, `cli`: opens that CLI's sign-in in a new desktop terminal tab) or
    /// `logout` (`id`, `cli`). For `login` / `logout` an `id` of `""` is the
    /// default profile.
    Profile {
        op: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        copy_settings: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delete_files: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli: Option<String>,
    },
    /// Open a new terminal tab on the desktop, in `cwd` (else the shell's
    /// start folder) and, with `cli` (`claude`, `codex`, `vibe`), starting
    /// that agent in it. The phone sees it in the next `tabs`.
    NewTab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli: Option<String>,
        /// Account profile id to start the tab under; `""` = the default
        /// profile; absent = automatic (the folder's project default).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
    },
    /// Follow a chat: the desktop answers with its events after `after_seq`
    /// (`ServerMsg::ChatEvents` with `replay`), then streams the new ones.
    ChatOpen { chat_id: String, after_seq: u64 },
    ChatClose { chat_id: String },
    /// A prompt for the chat's agent, at most `MAX_INPUT_BYTES`.
    ChatPrompt { chat_id: String, text: String },
    ChatCancel { chat_id: String },
    /// Answer an agent's permission request; `option_id: None` cancels it.
    ChatPermission { chat_id: String, request_id: serde_json::Value, option_id: Option<String> },
    ChatMode { chat_id: String, mode_id: String },
    /// Switch the chat's agent to another of the models it offers (`ChatInfo::models`).
    ChatModel { chat_id: String, model_id: String },
    /// Switch the chat's agent to another of the thinking levels it offers (`ChatInfo::thought`).
    ChatThought { chat_id: String, value: String },
    /// Hand the chat's session over to a desktop terminal tab, as Ctrl+` does there.
    ChatTerminal { chat_id: String },
    /// Reopen the agent running in the terminal tab of `pty_id` as a chat tab on the same session (the reverse of `ChatTerminal`).
    TerminalChat { pty_id: String },
    /// Rename the chat tab, at most 128 characters.
    ChatRename { chat_id: String, label: String },
    /// Close the chat tab (not the last tab of its window).
    ChatCloseTab { chat_id: String },
    /// Start a fresh conversation in the chat's tab, as `/clear` does on the desktop (the tab keeps its id, the chat gets a new one).
    ChatClear { chat_id: String },
    /// Open a new desktop chat tab for `cli`, in `cwd` (else the shell's start folder).
    NewChat {
        cli: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// Account profile id; `""` = the default profile; absent = automatic.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
    },
    /// List the agent view plugins a phone may show (answered with `ServerMsg::Views`).
    Views,
    /// Ask the desktop to check GitHub for a newer release (answered by `ServerMsg::Update`).
    UpdateCheck,
    /// Install the release the desktop last found, only if the user allowed it on the desktop.
    UpdateInstall,
    /// One file of a view plugin, answered with its `ServerMsg::ViewFile` chunks.
    ViewFile { view_id: String, path: String },
    /// The preview of a link in a chat (answered with `ServerMsg::LinkPreview`).
    LinkPreview { url: String },
    /// An image of a chat (answered with `ServerMsg::ChatImage` chunks): a stored
    /// one by `id`, or a file the agent mentioned by `path` (resolved in the
    /// chat `chat_id`'s folder), or a web image by `url` (fetched by the desktop,
    /// only if its setting allows). Exactly one of `id`, `path` and `url`.
    ChatImage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// The phone is in the background: send only notifications until it says
    /// otherwise (`on: false`).
    Background { on: bool },
    Ping,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum ServerMsg {
    /// Reply to `pair`. The token is shown to the phone once; keep it.
    Paired { token: String, device_name: String },
    /// Reply to a successful `auth` (or to `pair`, right after `paired`).
    /// `app_version`, `proto` and `caps` tell the phone what this desktop can
    /// do (see `PROTOCOL_VERSION` / `CAPABILITIES`); a desktop that predates
    /// them sends none, which the phone reads as "old".
    Ready {
        device_name: String,
        host_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proto: Option<u32>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        caps: Vec<String>,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pty_id: Option<String>,
        /// The server closes the connection after a fatal error.
        fatal: bool,
    },
    Tabs { tabs: Vec<Tab> },
    /// The desktop's current screen for a pty, sent right after `open`.
    Snapshot { pty_id: String, data: String, cols: u16, rows: u16 },
    Output { pty_id: String, data: String },
    Exit { pty_id: String },
    Usage { items: Vec<UsageItem> },
    Actions { actions: Vec<Action> },
    Ls { pty_id: String, path: String, entries: Vec<LsEntry> },
    File { pty_id: String, path: String, text: String, truncated: bool },
    /// The desktop settings the phone mirrors, as one JSON object. Sent after
    /// `ready` once the desktop has published them, and again on every change.
    Settings { settings: serde_json::Value },
    /// The desktop's update state, as one JSON object:
    /// `{state, version?, currentVersion?, notes?, size?, stage?, downloaded?, total?, error?, allowed}`.
    /// `allowed` tells whether the user lets phones install updates.
    Update { update: serde_json::Value },
    /// The account profiles, as a JSON array of
    /// `{id, name, color, loggedIn: {claude, codex, vibe, gemini}}`. Sent after `ready`
    /// once the desktop has published them, and again on every change.
    /// `default_logged_in` is the default profile's `{claude, codex, vibe, gemini}`
    /// login state, when the desktop knows it.
    Profiles {
        profiles: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_logged_in: Option<serde_json::Value>,
    },
    /// A desktop notification mirrored to phones; `tab_id` matches
    /// `Tab::tab_id` when it is about a tab.
    Notify {
        title: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<String>,
    },
    /// Every chat tab of the desktop, sent after `ready` and on every change.
    Chats { chats: Vec<ChatInfo> },
    /// Events of a chat followed with `chatopen`, in `seq` order. `replay`
    /// marks the answer to `chatopen` (possibly split over several messages),
    /// `false` the live ones after it. Each event is a `ChatEvent` of src/chat.
    ChatEvents { chat_id: String, events: Vec<serde_json::Value>, replay: bool },
    /// The agent view plugins a phone may show.
    Views { views: Vec<ViewPackage> },
    /// One chunk of a view plugin file (base64), `offset` and `total` in raw
    /// bytes; the chunks of a file arrive in order.
    ViewFile { view_id: String, hash: String, path: String, offset: u64, total: u64, data: String },
    /// Reply to `linkpreview`: what the desktop read from the page (the JSON
    /// shape of the shared `LinkPreview`), or null if there is none.
    LinkPreview { url: String, preview: Option<serde_json::Value> },
    /// One chunk of a chat image (base64), `offset` and `total` in raw bytes,
    /// in order. `key` is the requested `id` (else `path`), verbatim. `mime` is
    /// known for files only. `missing`: no such image (one chunk, no data).
    ChatImage {
        key: String,
        offset: u64,
        total: u64,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        missing: bool,
    },
    Pong,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub pty_id: String,
    pub tab_id: String,
    /// Label of the desktop window showing the tab.
    pub window: String,
    pub label: String,
    pub cwd: String,
    /// Agent running in the tab (`claude`, `codex`, `vibe`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    /// Account profile the agent runs under (absent: the default one, or no agent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// `busy` / `idle` / `waiting`, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<TabContext>,
}

/// A desktop chat tab (an agent hosted over ACP) a phone can follow.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatInfo {
    pub chat_id: String,
    pub tab_id: String,
    /// Label of the desktop window showing the tab.
    pub window: String,
    pub label: String,
    /// `claude`, `codex`, `vibe` or `gemini`.
    pub agent: String,
    pub cwd: String,
    /// Account profile the agent runs under (absent: the default one).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// `starting` / `idle` / `busy` / `waiting` / `exited`, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// The ACP `modes` object the agent announced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<serde_json::Value>,
    /// The models the agent offers, normalized from either ACP API:
    /// `{ currentModelId, availableModels: [{ modelId, name, description?, group? }] }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<serde_json::Value>,
    /// The thinking levels the agent offers (they follow the model):
    /// `{ currentId, available: [{ id, name, description? }] }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought: Option<serde_json::Value>,
}

/// An installed agent view plugin: its manifest plus what a phone needs to
/// cache it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewPackage {
    pub id: String,
    pub kind: String,
    pub api_version: u32,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub entry: String,
    pub transport: String,
    pub devices: Vec<String>,
    pub permissions: Vec<String>,
    /// SHA-256 (hex) over the package's files: a phone re-downloads only when it changes.
    pub hash: String,
    pub files: Vec<ViewFileInfo>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewFileInfo {
    pub path: String,
    pub size: u64,
}

/// How full an agent's context window is (tokens).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabContext {
    pub used: u64,
    pub window: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageItem {
    pub plugin_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// The profile's display name, so the phone can title its usage group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    /// The profile's color (CSS value), for the group's dot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_color: Option<String>,
    pub metrics: Vec<UsageMetric>,
}

/// Mirrors the desktop's usage metric; every field but `kind` is optional and
/// a client should ignore a `kind` it doesn't know.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetric {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 0-1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// When the window resets, as the CLI worded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// The agent CLI the action launches ("claude", "codex", "vibe", "gemini"): the phone draws its logo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LsEntry {
    pub name: String,
    pub dir: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shape_is_tagged_camel_case() {
        let json = serde_json::to_value(ClientMsg::Open { pty_id: "p1".into(), cols: Some(50), rows: None }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "open", "ptyId": "p1", "cols": 50 }));
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"pair","code":"c","deviceName":"Pixel"}"#).unwrap();
        assert_eq!(msg, ClientMsg::Pair { code: "c".into(), device_name: "Pixel".into() });
        let json = serde_json::to_value(ServerMsg::Error { message: "no".into(), pty_id: None, fatal: true }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "error", "message": "no", "fatal": true }));
        assert_eq!(serde_json::to_string(&ServerMsg::Pong).unwrap(), r#"{"t":"pong"}"#);
        let json = serde_json::to_value(ServerMsg::Notify { title: "T".into(), body: "B".into(), tab_id: Some("t1".into()) }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "notify", "title": "T", "body": "B", "tabId": "t1" }));
        let msg: ServerMsg = serde_json::from_str(r#"{"t":"notify","title":"T","body":"B"}"#).unwrap();
        assert_eq!(msg, ServerMsg::Notify { title: "T".into(), body: "B".into(), tab_id: None });
    }

    #[test]
    fn settings_messages_carry_free_form_json() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"set","key":"palette","value":"ocean"}"#).unwrap();
        assert_eq!(msg, ClientMsg::Set { key: "palette".into(), value: serde_json::json!("ocean") });
        let json = serde_json::to_value(ServerMsg::Settings { settings: serde_json::json!({ "a": 1 }) }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "settings", "settings": { "a": 1 } }));
    }

    #[test]
    fn update_messages_round_trip() {
        assert_eq!(serde_json::to_string(&ClientMsg::UpdateCheck).unwrap(), r#"{"t":"updatecheck"}"#);
        assert_eq!(serde_json::to_string(&ClientMsg::UpdateInstall).unwrap(), r#"{"t":"updateinstall"}"#);
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"updateinstall"}"#).unwrap();
        assert_eq!(msg, ClientMsg::UpdateInstall);
        let update = serde_json::json!({ "state": "available", "version": "1.2.3", "allowed": false });
        let json = serde_json::to_value(ServerMsg::Update { update: update.clone() }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "update", "update": update }));
        let back: ServerMsg = serde_json::from_value(json).unwrap();
        assert_eq!(back, ServerMsg::Update { update });
    }

    #[test]
    fn profile_messages_round_trip() {
        let msg: ClientMsg = serde_json::from_str(r##"{"t":"profile","op":"create","name":"Work","color":"#112233","copySettings":true}"##).unwrap();
        assert_eq!(
            msg,
            ClientMsg::Profile {
                op: "create".into(),
                id: None,
                name: Some("Work".into()),
                color: Some("#112233".into()),
                copy_settings: Some(true),
                delete_files: None,
                cli: None
            }
        );
        let json = serde_json::to_value(ServerMsg::Profiles { profiles: serde_json::json!([]), default_logged_in: None }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "profiles", "profiles": [] }));
        let json = serde_json::to_value(ServerMsg::Profiles { profiles: serde_json::json!([]), default_logged_in: Some(serde_json::json!({ "claude": true })) }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "profiles", "profiles": [], "defaultLoggedIn": { "claude": true } }));
    }

    #[test]
    fn ready_advertises_version_and_caps_but_old_ones_omit_them() {
        let old: ServerMsg = serde_json::from_str(r#"{"t":"ready","deviceName":"d","hostName":"h"}"#).unwrap();
        assert_eq!(old, ServerMsg::Ready { device_name: "d".into(), host_name: "h".into(), app_version: None, proto: None, caps: vec![] });
        let json = serde_json::to_value(ServerMsg::Ready {
            device_name: "d".into(),
            host_name: "h".into(),
            app_version: Some("0.10.0".into()),
            proto: Some(2),
            caps: vec!["rename".into()],
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "t": "ready", "deviceName": "d", "hostName": "h", "appVersion": "0.10.0", "proto": 2, "caps": ["rename"] }));
    }

    #[test]
    fn background_hint_round_trips() {
        let json = serde_json::to_value(ClientMsg::Background { on: true }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "background", "on": true }));
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"background","on":false}"#).unwrap();
        assert_eq!(msg, ClientMsg::Background { on: false });
    }

    #[test]
    fn newtab_round_trips() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"newtab","cwd":"C:\\x","cli":"claude","profile":"p1"}"#).unwrap();
        assert_eq!(msg, ClientMsg::NewTab { cwd: Some("C:\\x".into()), cli: Some("claude".into()), profile: Some("p1".into()) });
        let json = serde_json::to_value(ClientMsg::NewTab { cwd: None, cli: None, profile: None }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "newtab" }));
    }

    #[test]
    fn optional_fields_may_be_absent() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"open","ptyId":"p"}"#).unwrap();
        assert_eq!(msg, ClientMsg::Open { pty_id: "p".into(), cols: None, rows: None });
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"action","id":"git"}"#).unwrap();
        assert_eq!(msg, ClientMsg::Action { id: "git".into(), pty_id: None });
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"rename","ptyId":"p","label":"x"}"#).unwrap();
        assert_eq!(msg, ClientMsg::Rename { pty_id: "p".into(), label: "x".into() });
    }

    #[test]
    fn chat_messages_round_trip() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"chatopen","chatId":"c1","afterSeq":12}"#).unwrap();
        assert_eq!(msg, ClientMsg::ChatOpen { chat_id: "c1".into(), after_seq: 12 });
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"chatpermission","chatId":"c1","requestId":"a1","optionId":null}"#).unwrap();
        assert_eq!(msg, ClientMsg::ChatPermission { chat_id: "c1".into(), request_id: serde_json::json!("a1"), option_id: None });
        let json = serde_json::to_value(ClientMsg::ChatMode { chat_id: "c1".into(), mode_id: "plan".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "chatmode", "chatId": "c1", "modeId": "plan" }));
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"chatmodel","chatId":"c1","modelId":"opus"}"#).unwrap();
        assert_eq!(msg, ClientMsg::ChatModel { chat_id: "c1".into(), model_id: "opus".into() });
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"chatthought","chatId":"c1","value":"high"}"#).unwrap();
        assert_eq!(msg, ClientMsg::ChatThought { chat_id: "c1".into(), value: "high".into() });
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"newchat","cli":"claude"}"#).unwrap();
        assert_eq!(msg, ClientMsg::NewChat { cli: "claude".into(), cwd: None, profile: None });
        let events = vec![serde_json::json!({ "seq": 1 })];
        let json = serde_json::to_value(ServerMsg::ChatEvents { chat_id: "c1".into(), events, replay: true }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "chatevents", "chatId": "c1", "events": [{ "seq": 1 }], "replay": true }));
        let info = ChatInfo {
            chat_id: "c1".into(),
            tab_id: "chat-1".into(),
            window: "main".into(),
            label: "Claude".into(),
            agent: "claude".into(),
            cwd: "/work".into(),
            profile: None,
            session_id: Some("s1".into()),
            status: Some("idle".into()),
            modes: None,
            models: None,
            thought: None,
        };
        let json = serde_json::to_value(ServerMsg::Chats { chats: vec![info] }).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "t": "chats", "chats": [{
                "chatId": "c1", "tabId": "chat-1", "window": "main", "label": "Claude", "agent": "claude",
                "cwd": "/work", "sessionId": "s1", "status": "idle"
            }] })
        );
    }

    #[test]
    fn view_messages_round_trip() {
        assert_eq!(serde_json::to_string(&ClientMsg::Views).unwrap(), r#"{"t":"views"}"#);
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"viewfile","viewId":"timeline","path":"index.html"}"#).unwrap();
        assert_eq!(msg, ClientMsg::ViewFile { view_id: "timeline".into(), path: "index.html".into() });
        let chunk = ServerMsg::ViewFile {
            view_id: "timeline".into(),
            hash: "ab".into(),
            path: "index.html".into(),
            offset: 0,
            total: 5,
            data: "aGVsbG8=".into(),
        };
        assert_eq!(
            serde_json::to_value(chunk).unwrap(),
            serde_json::json!({ "t": "viewfile", "viewId": "timeline", "hash": "ab", "path": "index.html", "offset": 0, "total": 5, "data": "aGVsbG8=" })
        );
        let package = ViewPackage {
            id: "timeline".into(),
            kind: "agentView".into(),
            api_version: 1,
            label: "Timeline".into(),
            labels: None,
            description: None,
            version: None,
            author: None,
            entry: "index.html".into(),
            transport: "acp".into(),
            devices: vec!["phone".into()],
            permissions: vec![],
            hash: "ab".into(),
            files: vec![ViewFileInfo { path: "index.html".into(), size: 5 }],
        };
        let json = serde_json::to_value(&package).unwrap();
        assert_eq!(json["apiVersion"], 1);
        assert_eq!(json["files"], serde_json::json!([{ "path": "index.html", "size": 5 }]));
        assert!(json.get("labels").is_none());
        assert_eq!(serde_json::from_value::<ViewPackage>(json).unwrap(), package);
    }

    #[test]
    fn link_preview_messages_round_trip() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"linkpreview","url":"https://a.b"}"#).unwrap();
        assert_eq!(msg, ClientMsg::LinkPreview { url: "https://a.b".into() });
        let reply = ServerMsg::LinkPreview { url: "https://a.b".into(), preview: Some(serde_json::json!({ "url": "https://a.b", "title": "T" })) };
        assert_eq!(
            serde_json::to_value(reply).unwrap(),
            serde_json::json!({ "t": "linkpreview", "url": "https://a.b", "preview": { "url": "https://a.b", "title": "T" } })
        );
        let none = ServerMsg::LinkPreview { url: "https://a.b".into(), preview: None };
        assert_eq!(serde_json::to_value(none).unwrap(), serde_json::json!({ "t": "linkpreview", "url": "https://a.b", "preview": null }));
    }

    #[test]
    fn chat_image_messages_round_trip() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"chatimage","chatId":"c","path":"a.png"}"#).unwrap();
        assert_eq!(msg, ClientMsg::ChatImage { chat_id: Some("c".into()), id: None, path: Some("a.png".into()), url: None });
        assert_eq!(serde_json::to_value(&msg).unwrap(), serde_json::json!({ "t": "chatimage", "chatId": "c", "path": "a.png" }));
        let by_id: ClientMsg = serde_json::from_str(r#"{"t":"chatimage","id":"ab"}"#).unwrap();
        assert_eq!(by_id, ClientMsg::ChatImage { chat_id: None, id: Some("ab".into()), path: None, url: None });
        let by_url: ClientMsg = serde_json::from_str(r#"{"t":"chatimage","url":"https://a.b/i.png"}"#).unwrap();
        assert_eq!(by_url, ClientMsg::ChatImage { chat_id: None, id: None, path: None, url: Some("https://a.b/i.png".into()) });
        assert_eq!(serde_json::to_value(&by_url).unwrap(), serde_json::json!({ "t": "chatimage", "url": "https://a.b/i.png" }));
        let chunk = ServerMsg::ChatImage { key: "a.png".into(), offset: 0, total: 5, data: "aGVsbG8=".into(), mime: Some("image/png".into()), missing: false };
        assert_eq!(
            serde_json::to_value(chunk).unwrap(),
            serde_json::json!({ "t": "chatimage", "key": "a.png", "offset": 0, "total": 5, "data": "aGVsbG8=", "mime": "image/png" })
        );
        let gone = ServerMsg::ChatImage { key: "ab".into(), offset: 0, total: 0, data: String::new(), mime: None, missing: true };
        assert_eq!(
            serde_json::to_value(gone).unwrap(),
            serde_json::json!({ "t": "chatimage", "key": "ab", "offset": 0, "total": 0, "data": "", "missing": true })
        );
    }

    #[test]
    fn chat_tab_messages_round_trip() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"terminalchat","ptyId":"p"}"#).unwrap();
        assert_eq!(msg, ClientMsg::TerminalChat { pty_id: "p".into() });
        let json = serde_json::to_value(ClientMsg::ChatRename { chat_id: "c1".into(), label: "Notes".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "chatrename", "chatId": "c1", "label": "Notes" }));
    }

    #[test]
    fn chat_close_tab_round_trips() {
        let json = serde_json::to_value(ClientMsg::ChatCloseTab { chat_id: "c1".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "chatclosetab", "chatId": "c1" }));
        let msg: ClientMsg = serde_json::from_value(json).unwrap();
        assert_eq!(msg, ClientMsg::ChatCloseTab { chat_id: "c1".into() });
    }

    #[test]
    fn closetab_round_trips() {
        let msg: ClientMsg = serde_json::from_str(r#"{"t":"closetab","ptyId":"p"}"#).unwrap();
        assert_eq!(msg, ClientMsg::CloseTab { pty_id: "p".into() });
        let json = serde_json::to_value(ClientMsg::CloseTab { pty_id: "p".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "closetab", "ptyId": "p" }));
    }
}
