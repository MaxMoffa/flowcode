//! Parsing what the agent writes and sorting its errors.

use super::*;

/// What a request sent to the agent does with its answer.
pub(super) enum Pending {
    /// Someone is blocked waiting for it.
    Waiter(mpsc::Sender<Result<Value, String>>),
    /// A `session/prompt`: its answer ends (or fails) the turn.
    Prompt,
    /// A `session/prompt` on ACP v2: its answer only says the prompt was taken in (`{messageId}`) or
    /// rejected; the turn ends with the agent's `idle` state.
    PromptV2,
}

pub(super) struct RpcError {
    pub(super) code: i64,
    pub(super) message: String,
    /// The error's `data`: where the adapters put what the failure was
    /// (Claude `errorKind`, Codex `codexErrorInfo`) and its readable text.
    pub(super) data: Option<Value>,
}

/// One line the agent wrote, sorted by what it is.
pub(super) enum Incoming {
    Response { id: u64, result: Result<Value, RpcError> },
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

/// Parses a stdout line; `None` for anything that isn't a JSON-RPC message
/// (some adapters print logs to stdout).
pub(super) fn parse_line(line: &str) -> Option<Incoming> {
    let mut value: Value = serde_json::from_str(line.trim()).ok()?;
    let params = value.as_object_mut()?.remove("params").unwrap_or(Value::Null);
    let obj = value.as_object()?;
    let method = obj.get("method").and_then(Value::as_str);
    let id = obj.get("id").filter(|id| !id.is_null());
    match (method, id) {
        (Some(method), Some(id)) => Some(Incoming::Request { id: id.clone(), method: method.to_string(), params }),
        (Some(method), None) => Some(Incoming::Notification { method: method.to_string(), params }),
        (None, Some(id)) => {
            // Our own ids are integers; anything else isn't an answer to us.
            let id = id.as_u64()?;
            let result = match obj.get("error") {
                Some(err) => Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err.get("message").and_then(Value::as_str).unwrap_or("unknown error").to_string(),
                    data: err.get("data").filter(|d| !d.is_null()).cloned(),
                }),
                None => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
            };
            Some(Incoming::Response { id, result })
        }
        (None, None) => None,
    }
}

/// ACP signals "sign in first" with code -32000 / "Authentication required".
pub(super) fn is_auth_error(err: &RpcError) -> bool {
    let message = err.message.to_lowercase();
    message.contains("authenticat") || message.contains("auth_required") || message.contains("unauthorized") || message.contains("not logged in")
        || (err.code == -32000 && (message.contains("sign in") || message.contains("log in")))
}

/// The failure as the user should read it. The adapters wrap it in JSON-RPC's
/// "Internal error[: detail]": the detail is the text, and a bare "Internal
/// error" (Codex) keeps its text in `data.message` / `data.details`.
pub(super) fn readable_error(err: &RpcError) -> String {
    let message = err.message.trim();
    if let Some(detail) = message.strip_prefix("Internal error:").map(str::trim).filter(|d| !d.is_empty()) {
        return detail.to_string();
    }
    if message == "Internal error" {
        let data = err.data.as_ref();
        let text = ["message", "details", "additionalDetails"]
            .iter()
            .find_map(|key| data.and_then(|d| d.get(key)).and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()));
        if let Some(text) = text {
            return text.to_string();
        }
    }
    err.message.clone()
}

pub(super) fn error_text(err: &RpcError) -> String {
    if is_auth_error(err) { format!("auth_required: {}", err.message) } else { readable_error(err) }
}

/// Whether a failed prompt says the agent's session is gone for good while its
/// process lives on (Claude's adapter: "The Claude Agent session has ended. /
/// process exited unexpectedly. Please start a new session."). Nothing more
/// can run in it, so the chat ends as if the agent had exited.
pub(super) fn is_session_gone(err: &RpcError) -> bool {
    let message = err.message.to_lowercase();
    ["session has ended", "process exited unexpectedly", "please start a new session"].iter().any(|p| message.contains(p))
}

/// Whether a failed prompt hit the plan's usage limit, a quota or the credits
/// running out - for every agent. Claude's adapter says so in
/// `data.errorKind`, Codex's in `data.codexErrorInfo`; Gemini, OpenCode and
/// Vibe only in the provider's wording, matched loosely here.
pub(super) fn is_limit_error(err: &RpcError) -> bool {
    let data = err.data.as_ref();
    let kind = data.and_then(|d| d.get("errorKind")).and_then(Value::as_str);
    if matches!(kind, Some("rate_limit" | "billing_error")) {
        return true;
    }
    let codex = data.and_then(|d| d.get("codexErrorInfo"));
    if codex.is_some_and(|info| info.as_str() == Some("usageLimitExceeded") || info.get("usageLimitExceeded").is_some()) {
        return true;
    }
    if is_auth_error(err) {
        return false;
    }
    let mut text = err.message.to_lowercase();
    if let Some(data) = data {
        text.push(' ');
        text.push_str(&data.to_string().to_lowercase());
    }
    const PATTERNS: &[&str] = &[
        "usage limit", "usagelimitexceeded", "rate limit", "rate_limit", "ratelimit", "quota", "resource_exhausted",
        "insufficient credits", "insufficient_credits", "out of credits", "out of usage", "extra usage", "usage credits",
        "credit balance", "insufficient balance", "payment required", "too many requests",
    ];
    PATTERNS.iter().any(|p| text.contains(p))
        || ["hit your", "reached your"].iter().any(|p| text.split(p).skip(1).any(|rest| rest.chars().take(40).collect::<String>().contains("limit")))
}

/// Appends to a ring buffer holding the last `cap` bytes.
pub(super) fn push_tail(buf: &mut Vec<u8>, chunk: &[u8], cap: usize) {
    buf.extend_from_slice(chunk);
    if buf.len() > cap {
        buf.drain(..buf.len() - cap);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_lines_into_responses_requests_and_notifications() {
        let Some(Incoming::Response { id: 3, result: Ok(result) }) =
            parse_line(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#)
        else {
            panic!("not a response");
        };
        assert_eq!(result["stopReason"], "end_turn");

        let Some(Incoming::Response { id: 4, result: Err(err) }) =
            parse_line(r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"Authentication required"}}"#)
        else {
            panic!("not an error response");
        };
        assert_eq!((err.code, err.message.as_str()), (-32000, "Authentication required"));

        // Agent request ids may be strings.
        let Some(Incoming::Request { id, method, .. }) =
            parse_line(r#"{"jsonrpc":"2.0","id":"a1","method":"fs/read_text_file","params":{}}"#)
        else {
            panic!("not a request");
        };
        assert_eq!((id, method.as_str()), (json!("a1"), "fs/read_text_file"));

        assert!(matches!(
            parse_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{}}}"#),
            Some(Incoming::Notification { .. })
        ));
    }

    #[test]
    fn skips_lines_that_are_not_jsonrpc() {
        assert!(parse_line("").is_none());
        assert!(parse_line("INFO starting up").is_none());
        assert!(parse_line("{ broken").is_none());
        assert!(parse_line("[1,2]").is_none());
        assert!(parse_line(r#"{"hello":"world"}"#).is_none());
        // A response whose id isn't one of ours.
        assert!(parse_line(r#"{"id":"x","result":{}}"#).is_none());
    }

    #[test]
    fn recognizes_usage_limits_from_every_agent() {
        let err = |message: &str, data: Value| RpcError { code: -32603, message: message.to_string(), data: (!data.is_null()).then_some(data) };
        // Claude: categorical errorKind, the text after "Internal error: ".
        let claude = err("Internal error: You've hit your 5-hour limit · resets 6pm (Europe/Rome)", json!({ "errorKind": "rate_limit" }));
        assert!(is_limit_error(&claude));
        assert_eq!(error_text(&claude), "You've hit your 5-hour limit · resets 6pm (Europe/Rome)");
        // Codex: a bare "Internal error", the text and the kind in data.
        let codex = err("Internal error", json!({ "message": "You've hit your usage limit. Try again at 3:45 PM.", "codexErrorInfo": "usageLimitExceeded" }));
        assert!(is_limit_error(&codex));
        assert_eq!(error_text(&codex), "You've hit your usage limit. Try again at 3:45 PM.");
        // Gemini / OpenCode / Vibe: only the provider's wording.
        assert!(is_limit_error(&err("Internal error: [429] RESOURCE_EXHAUSTED: Quota exceeded for model", Value::Null)));
        assert!(is_limit_error(&err("Internal error", json!({ "details": "Insufficient credits. Add more using https://openrouter.ai" }))));
        assert!(is_limit_error(&err("Rate limit exceeded, retry later", Value::Null)));
        // Not limits.
        assert!(!is_limit_error(&err("Internal error: The Claude Agent session has ended. Please start a new session.", Value::Null)));
        assert!(!is_limit_error(&err("Internal error", json!({ "errorKind": "server_error" }))));
        assert!(!is_limit_error(&err("Authentication required", Value::Null)));
    }

    #[test]
    fn recognizes_a_session_that_is_gone() {
        let err = |message: &str| RpcError { code: -32603, message: message.to_string(), data: None };
        assert!(is_session_gone(&err("Internal error: The Claude Agent session has ended. Please start a new session.")));
        assert!(is_session_gone(&err("Internal error: The Claude Agent process exited unexpectedly. Please start a new session.")));
        assert!(!is_session_gone(&err("Internal error: You've hit your 5-hour limit")));
        assert!(!is_session_gone(&err("Invalid params")));
    }

    #[test]
    fn recognizes_authentication_errors() {
        let err = |code, message: &str| RpcError { code, message: message.to_string(), data: None };
        assert_eq!(error_text(&err(-32000, "Authentication required")), "auth_required: Authentication required");
        assert!(is_auth_error(&err(1, "please authenticate first")));
        assert!(!is_auth_error(&err(-32000, "server is busy")));
        assert_eq!(error_text(&err(-32602, "Invalid params")), "Invalid params");
    }

    #[test]
    fn keeps_only_the_tail_of_stderr() {
        let mut buf = Vec::new();
        push_tail(&mut buf, b"abcdef", 4);
        assert_eq!(buf, b"cdef");
        push_tail(&mut buf, b"gh", 4);
        assert_eq!(buf, b"efgh");
    }
}
