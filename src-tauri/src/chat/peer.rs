//! The chat side of the messages between tabs (`agent_messages.rs`): how a chat is found by its tab, and how a
//! message is handed to its agent as a prompt.

use super::*;
use crate::agent_messages::PeerPrompt;

/// A running chat as the tab directory sees it.
pub(crate) struct PeerChat {
    pub chat_id: String,
    pub agent: String,
    /// It carries out a delegated task (no tab of its own to message).
    pub child: bool,
    pub status: &'static str,
    /// It was started with the message tools: it can answer.
    pub can_reply: bool,
    /// Neither closed nor exited.
    pub live: bool,
}

/// Whether a chat takes a peer prompt now.
pub(crate) enum PeerReady {
    /// Closed or exited: what waits for it fails.
    Gone,
    /// Not now: a scheduled resume goes first (a peer prompt would hit the same usage limit).
    Wait,
    Ready,
}

/// The gate of a peer prompt: idle only. Unlike the user's prompt it never merges into a turn the agent started by
/// itself, whose cycle (a background task's report...) it could cut short; it waits for that turn's end instead.
pub(super) fn peer_gate(status: ChatStatus, _autonomous: bool) -> Result<(), String> {
    prompt_gate(status, false)
}

impl ChatState {
    /// The running chat of a chat tab, by the agent session the tab reported.
    pub(crate) fn peer_chat_by_session(&self, session_id: &str) -> Option<PeerChat> {
        let chat = lock(&self.sessions).values().find(|s| lock(&s.chat.session_id).as_deref() == Some(session_id)).map(|s| Arc::clone(&s.chat))?;
        let status = *lock(&chat.status);
        Some(PeerChat {
            chat_id: chat.id.clone(),
            agent: chat.agent.clone(),
            child: chat.link.is_some(),
            status: status.as_str(),
            can_reply: crate::chat_mcp::enabled_tools(&chat.tools, chat.depth()).contains(&crate::chat_mcp::SEND_MESSAGE),
            live: !chat.closed.load(Ordering::Relaxed) && !chat.exited.load(Ordering::Acquire) && status != ChatStatus::Exited,
        })
    }

    /// An extension event into a chat's log (nothing when the chat is gone).
    pub(crate) fn peer_emit(&self, chat_id: &str, method: &str, params: Value) {
        if let Ok(chat) = self.get(chat_id) {
            chat.emit(ChatBody::Ext { method: method.to_string(), params });
        }
    }

    /// Alerts the phones that a chat waits for the user's consent to a message (`title` says from whom).
    pub(crate) fn peer_alert(&self, chat_id: &str, title: String) {
        let Ok(chat) = self.get(chat_id) else { return };
        let Some(session_id) = lock(&chat.session_id).clone() else { return };
        let _ = self.alerts.send(ChatAlert { agent: chat.agent.clone(), session_id, kind: AlertKind::Permission { tool: title } });
    }

    pub(crate) fn peer_ready(&self, chat_id: &str) -> PeerReady {
        let Ok(chat) = self.get(chat_id) else { return PeerReady::Gone };
        if chat.closed.load(Ordering::Relaxed) || chat.exited.load(Ordering::Acquire) {
            return PeerReady::Gone;
        }
        if lock(&chat.resume).is_some() {
            return PeerReady::Wait;
        }
        PeerReady::Ready
    }

    /// Hands a chat another agent's message as a prompt: the `User` event shows `text` with the sender (`meta`),
    /// the agent gets the framed text. Only when idle (`peer_gate`); unlike the user's prompt it leaves the
    /// scheduled resume armed. `delivered` runs right after the `User` event is out, before the request is sent.
    pub(crate) fn prompt_peer(&self, chat_id: &str, text: String, prompt: PeerPrompt, delivered: impl FnOnce()) -> Result<(), String> {
        self.prompt_with(chat_id, text, Vec::new(), Some(prompt), peer_gate, |_| delivered())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_prompt_waits_for_idle_even_in_an_autonomous_turn() {
        assert!(peer_gate(ChatStatus::Idle, false).is_ok());
        assert!(peer_gate(ChatStatus::Busy, true).unwrap_err().starts_with("agent_busy"), "no merge into the agent's own turn");
        assert!(peer_gate(ChatStatus::Busy, false).unwrap_err().starts_with("agent_busy"));
        assert!(peer_gate(ChatStatus::Waiting, true).unwrap_err().starts_with("agent_busy"));
        assert!(peer_gate(ChatStatus::Starting, false).unwrap_err().starts_with("agent_busy"));
        assert!(peer_gate(ChatStatus::Exited, false).unwrap_err().starts_with("agent_exited"));
        // The user's own prompt still merges.
        assert!(prompt_gate(ChatStatus::Busy, true).is_ok());
    }

    #[test]
    fn a_peer_user_event_carries_its_sender() {
        let event = ChatEvent {
            seq: 1,
            at: 2,
            body: ChatBody::User { text: "hi".into(), attachments: Vec::new(), images: Vec::new(), peer: Some(json!({ "id": "m-1", "fromTabId": "t7" })) },
        };
        assert_eq!(serde_json::to_value(&event).unwrap(), json!({ "seq": 1, "at": 2, "kind": "user", "text": "hi", "peer": { "id": "m-1", "fromTabId": "t7" } }));
    }
}
