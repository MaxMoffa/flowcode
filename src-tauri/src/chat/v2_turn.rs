//! What an ACP v2 chat keeps besides the codec's `V2State`: the rules that turn
//! the agent's `state_update`s into Flowcode's turns. Pure (no `Chat`, no I/O),
//! so the rules are tested here; `session.rs` wires them.

use std::collections::HashMap;

use serde_json::Value;

use super::acp_v2::V2State;

/// How long a stuck cancel waits for the agent's `idle` before the turn is ended locally.
pub(super) const CANCEL_GRACE_MS: u64 = 10_000;
/// The most often one tool call's terminal output is shown while it streams.
pub(super) const TERMINAL_MIN_GAP_MS: u64 = 1_000;

/// Everything a v2 chat keeps between messages (behind `Chat::v2`).
#[derive(Default)]
pub(super) struct V2Run {
    pub(super) state: V2State,
    pub(super) hold: Hold,
    pub(super) throttle: Throttle,
    /// The agent's foreground work is running (the last `running`/`requires_action` not yet followed by an `idle` with a reason).
    pub(super) running: bool,
    /// The select option to change to switch the mode (v2 has no `session/set_mode`).
    pub(super) mode_config: Option<String>,
    /// The cancel whose `idle` is awaited: its generation.
    pub(super) cancel: Option<u64>,
    cancel_gen: u64,
}

impl V2Run {
    /// A new session (`/clear`): nothing of the old one carries over.
    pub(super) fn reset(&mut self) {
        let (mode_config, cancel_gen) = (self.mode_config.take(), self.cancel_gen);
        *self = V2Run { mode_config, cancel_gen, ..V2Run::default() };
    }

    pub(super) fn arm_cancel(&mut self) -> u64 {
        self.cancel_gen += 1;
        self.cancel = Some(self.cancel_gen);
        self.cancel_gen
    }

    /// The turn ended (whatever the way): nothing is held or awaited any more.
    pub(super) fn turn_over(&mut self) {
        self.hold.clear();
        self.cancel = None;
    }
}

/// What an `idle` state means for the turn.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum IdleStep {
    /// A snapshot or repeat: nothing.
    Nothing,
    /// The work ended but background subagents run: the chat stays busy.
    Held,
    /// The turn ends with this stop reason; `true` when it is a held one being released.
    End(String, bool),
}

/// Keeps v1's behaviour for Claude: its prompt response waits for the background subagents it
/// spawned, so the chat stays busy until they end. v2 reports the end of the work at its result
/// (`idle`) and the subagents in `background`; an `idle` with a stop reason is held while that
/// list names a `subagent`. Terminals and tool calls never hold (a dev server would keep the chat busy forever).
#[derive(Default)]
pub(super) struct Hold {
    subagents: bool,
    held: Option<String>,
}

impl Hold {
    /// Notes the last `background` list (a complete snapshot) the agent reported.
    pub(super) fn observe(&mut self, background: Option<&[Value]>) {
        if let Some(list) = background {
            self.subagents = list.iter().any(|item| item.get("type").and_then(Value::as_str) == Some("subagent"));
        }
    }

    pub(super) fn on_idle(&mut self, stop_reason: Option<&str>, background: Option<&[Value]>) -> IdleStep {
        self.observe(background);
        match stop_reason {
            // A cancel ends the work for good: never wait for subagents then.
            Some("cancelled") => {
                self.held = None;
                IdleStep::End("cancelled".into(), false)
            }
            Some(reason) if self.subagents => {
                self.held = Some(reason.to_string());
                IdleStep::Held
            }
            Some(reason) => {
                let released = self.held.take().is_some();
                IdleStep::End(reason.to_string(), released)
            }
            None if !self.subagents => self.held.take().map_or(IdleStep::Nothing, |reason| IdleStep::End(reason, true)),
            None => IdleStep::Nothing,
        }
    }

    /// The agent is idle and only the subagents keep the turn open.
    pub(super) fn is_held(&self) -> bool {
        self.held.is_some()
    }

    pub(super) fn clear(&mut self) {
        self.held = None;
    }
}

/// What a `session/prompt` answer means on v2.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum PromptV2 {
    /// `{messageId}`: the agent took the prompt in. The turn ends with its `idle`, not now.
    Inserted,
    /// `-32800`: a cancel ended the prompt in the queue and the agent is not working: end the turn.
    EndCancelled,
    /// `-32800` while the agent works: its `idle` follows.
    WaitForIdle,
    /// Rejected before insertion: the error is shown; `reopen` when the agent is working on its own
    /// (the prompt queued behind it), so the views go on showing the work.
    Failed { reopen: bool },
}

/// `error_code`: the JSON-RPC error code of the answer, `None` for a success.
pub(super) fn prompt_v2_outcome(error_code: Option<i64>, foreground_running: bool) -> PromptV2 {
    match error_code {
        None => PromptV2::Inserted,
        Some(-32800) if foreground_running => PromptV2::WaitForIdle,
        Some(-32800) => PromptV2::EndCancelled,
        Some(_) => PromptV2::Failed { reopen: foreground_running },
    }
}

/// What to do with a terminal-output update of a tool call.
#[derive(Debug, PartialEq)]
pub(super) enum Offer {
    /// Show it now.
    Now(Value, Value),
    /// Kept as the latest; `first`: nothing was kept before, so a flush must be scheduled in `wait_ms`.
    Held { first: bool, wait_ms: u64 },
}

/// Coalesces a tool call's terminal output to one update a second (a command can write a lot):
/// the latest held update is flushed after the gap, and an exit always goes out at once.
#[derive(Default)]
pub(super) struct Throttle {
    last: HashMap<String, u64>,
    pending: HashMap<String, (Value, Value)>,
}

impl Throttle {
    pub(super) fn offer(&mut self, call_id: &str, params: Value, update: Value, now: u64) -> Offer {
        if let Some(last) = self.last.get(call_id).copied().filter(|last| now.saturating_sub(*last) < TERMINAL_MIN_GAP_MS) {
            let first = !self.pending.contains_key(call_id);
            self.pending.insert(call_id.to_string(), (params, update));
            return Offer::Held { first, wait_ms: TERMINAL_MIN_GAP_MS - now.saturating_sub(last) };
        }
        self.sent(call_id, now);
        Offer::Now(params, update)
    }

    /// An update of the call went out by another way (a status change, an exit): what was held is stale.
    pub(super) fn sent(&mut self, call_id: &str, now: u64) {
        self.pending.remove(call_id);
        if self.last.len() >= 256 {
            self.last.retain(|_, at| now.saturating_sub(*at) < 10 * TERMINAL_MIN_GAP_MS);
        }
        self.last.insert(call_id.to_string(), now);
    }

    /// The held update, once its gap is over.
    pub(super) fn take(&mut self, call_id: &str, now: u64) -> Option<(Value, Value)> {
        let held = self.pending.remove(call_id)?;
        self.last.insert(call_id.to_string(), now);
        Some(held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn subagent() -> Value {
        json!({ "type": "subagent", "sessionId": "kid" })
    }
    fn terminal() -> Value {
        json!({ "type": "terminal", "terminalId": "t1" })
    }

    #[test]
    fn an_idle_with_a_reason_ends_the_turn_when_nothing_runs_in_the_background() {
        let mut hold = Hold::default();
        assert_eq!(hold.on_idle(Some("end_turn"), None), IdleStep::End("end_turn".into(), false));
        assert_eq!(hold.on_idle(Some("end_turn"), Some(&[])), IdleStep::End("end_turn".into(), false));
        // A snapshot or repeat is no completion.
        assert_eq!(hold.on_idle(None, None), IdleStep::Nothing);
        assert_eq!(hold.on_idle(None, Some(&[])), IdleStep::Nothing);
    }

    #[test]
    fn background_subagents_hold_the_turn_terminals_and_calls_do_not() {
        let mut hold = Hold::default();
        let list = [terminal(), json!({ "type": "tool_call", "toolCallId": "c" })];
        assert_eq!(hold.on_idle(Some("end_turn"), Some(&list)), IdleStep::End("end_turn".into(), false));
        let with_subagent = [terminal(), subagent()];
        assert_eq!(hold.on_idle(Some("end_turn"), Some(&with_subagent)), IdleStep::Held);
        assert!(hold.is_held());
        // Still running: the repeat idle changes nothing.
        assert_eq!(hold.on_idle(None, Some(&with_subagent)), IdleStep::Nothing);
        assert!(hold.is_held());
        // The subagents are done: the repeat idle (no reason) releases the held one.
        assert_eq!(hold.on_idle(None, Some(&[terminal()])), IdleStep::End("end_turn".into(), true));
        assert!(!hold.is_held());
        assert_eq!(hold.on_idle(None, Some(&[])), IdleStep::Nothing);
    }

    #[test]
    fn the_follow_up_cycle_ends_a_held_turn_with_its_own_reason() {
        let mut hold = Hold::default();
        let list = [subagent()];
        assert_eq!(hold.on_idle(Some("end_turn"), Some(&list)), IdleStep::Held);
        // The follow-up cycle (running ... idle) ends it for good, with the list now empty.
        assert_eq!(hold.on_idle(Some("max_tokens"), Some(&[])), IdleStep::End("max_tokens".into(), true));
        assert!(!hold.is_held());
        // The list is remembered when a state doesn't carry it.
        assert_eq!(hold.on_idle(Some("end_turn"), Some(&list)), IdleStep::Held);
        assert_eq!(hold.on_idle(Some("end_turn"), None), IdleStep::Held);
    }

    #[test]
    fn a_cancel_is_never_held() {
        let mut hold = Hold::default();
        let list = [subagent()];
        assert_eq!(hold.on_idle(Some("end_turn"), Some(&list)), IdleStep::Held);
        assert_eq!(hold.on_idle(Some("cancelled"), Some(&list)), IdleStep::End("cancelled".into(), false));
        assert!(!hold.is_held());
    }

    #[test]
    fn the_prompt_answer_matrix() {
        assert_eq!(prompt_v2_outcome(None, false), PromptV2::Inserted);
        assert_eq!(prompt_v2_outcome(None, true), PromptV2::Inserted);
        assert_eq!(prompt_v2_outcome(Some(-32800), false), PromptV2::EndCancelled);
        assert_eq!(prompt_v2_outcome(Some(-32800), true), PromptV2::WaitForIdle);
        assert_eq!(prompt_v2_outcome(Some(-32603), false), PromptV2::Failed { reopen: false });
        assert_eq!(prompt_v2_outcome(Some(-32000), true), PromptV2::Failed { reopen: true });
    }

    #[test]
    fn terminal_output_goes_out_once_a_second_with_a_trailing_flush() {
        let mut throttle = Throttle::default();
        let params = json!({ "sessionId": "s" });
        let update = |n: u32| json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c", "n": n });
        assert!(matches!(throttle.offer("c", params.clone(), update(1), 0), Offer::Now(..)));
        assert_eq!(throttle.offer("c", params.clone(), update(2), 100), Offer::Held { first: true, wait_ms: 900 });
        // Later ones replace the held one; the flush is already scheduled.
        assert_eq!(throttle.offer("c", params.clone(), update(3), 400), Offer::Held { first: false, wait_ms: 600 });
        assert_eq!(throttle.take("c", 1000).map(|(_, u)| u["n"].clone()), Some(json!(3)));
        assert_eq!(throttle.take("c", 1000), None);
        // The flush counted as a send: the next one waits again.
        assert!(matches!(throttle.offer("c", params.clone(), update(4), 1200), Offer::Held { first: true, .. }));
        // Another call is independent; after the gap a call goes out at once.
        assert!(matches!(throttle.offer("d", params.clone(), update(5), 1200), Offer::Now(..)));
        assert!(matches!(throttle.offer("d", params, update(6), 2300), Offer::Now(..)));
    }

    #[test]
    fn an_update_sent_another_way_drops_the_held_one() {
        let mut throttle = Throttle::default();
        let params = json!({});
        assert!(matches!(throttle.offer("c", params.clone(), json!(1), 0), Offer::Now(..)));
        assert!(matches!(throttle.offer("c", params, json!(2), 10), Offer::Held { .. }));
        // The exit (or a status change) went out: the stale held output must not follow it.
        throttle.sent("c", 20);
        assert_eq!(throttle.take("c", 2000), None);
    }

    #[test]
    fn a_reset_forgets_the_session_but_keeps_the_mode_option() {
        let mut run = V2Run { running: true, mode_config: Some("mode".into()), ..V2Run::default() };
        run.hold.on_idle(Some("end_turn"), Some(&[subagent()]));
        let generation = run.arm_cancel();
        assert_eq!(run.cancel, Some(generation));
        run.reset();
        assert!(!run.running && !run.hold.is_held() && run.cancel.is_none());
        assert_eq!(run.mode_config.as_deref(), Some("mode"));
        run.arm_cancel();
        run.turn_over();
        assert!(run.cancel.is_none());
        assert!(run.arm_cancel() > generation, "generations never repeat");
    }
}
