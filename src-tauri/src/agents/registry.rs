//! Every agent CLI Flowcode supports and what each one can do here - the one
//! place to touch when an agent is added or gains a feature (mirrors
//! `shared/agentRegistry.ts`; see docs/agents-integration-map.md).

/// Ids of the supported agent CLIs.
pub(crate) const AGENT_CLIS: &[&str] = &["claude", "codex", "vibe", "gemini", "opencode"];

/// Whether `cli` is a supported agent (ids also end up in shell command lines: only these pass).
pub(crate) fn is_known(cli: &str) -> bool {
    AGENT_CLIS.contains(&cli)
}

/// Whether Flowcode reads `cli`'s session transcripts (context fill, agent insight).
pub(crate) fn reads_sessions(cli: &str) -> bool {
    matches!(cli, "claude" | "codex" | "opencode")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_agents_and_capabilities() {
        assert!(AGENT_CLIS.iter().all(|c| is_known(c)));
        assert!(!is_known("bash"));
        assert!(reads_sessions("claude") && reads_sessions("codex") && reads_sessions("opencode"));
        assert!(!reads_sessions("vibe") && !reads_sessions("gemini"));
    }
}
