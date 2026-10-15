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
    /// `name`, `color`), `delete` (`id`, optional `deleteFiles`) or `login`
    /// (`id`, `cli`: opens that CLI's sign-in in a new desktop terminal tab).
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
    Ready { device_name: String, host_name: String },
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
    /// The account profiles, as a JSON array of
    /// `{id, name, color, loggedIn: {claude, codex, vibe}}`. Sent after `ready`
    /// once the desktop has published them, and again on every change.
    Profiles { profiles: serde_json::Value },
    /// A desktop notification mirrored to phones; `tab_id` matches
    /// `Tab::tab_id` when it is about a tab.
    Notify {
        title: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<String>,
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
    /// `busy` / `idle` / `waiting`, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<TabContext>,
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
        let json = serde_json::to_value(ServerMsg::Profiles { profiles: serde_json::json!([]) }).unwrap();
        assert_eq!(json, serde_json::json!({ "t": "profiles", "profiles": [] }));
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
    }
}
