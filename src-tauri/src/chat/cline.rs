//! Cline (`cline --acp`): its tool calls come with raw titles, JSON-string outputs and in a
//! different order than the other agents. Normalized here, before they reach the views.

use std::collections::HashSet;

use serde_json::{json, Value};

/// `"run_commands"` -> `"Run commands"`.
fn humanize(word: &str) -> String {
    let spaced = word.replace('_', " ");
    let mut chars = spaced.chars();
    chars.next().into_iter().flat_map(char::to_uppercase).chain(chars).collect()
}

/// Splits a raw `"<word>: <rest>"` title, `<word>` being `[a-z_]+`.
fn split_title(title: &str) -> Option<(&str, &str)> {
    let (word, rest) = title.split_once(": ")?;
    (!word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')).then_some((word, rest))
}

fn strings(value: &Value) -> Vec<&str> {
    value.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

/// The readable title and, for commands, the joined command line.
fn readable_title(word: &str, rest: &str, kind: &str, raw_input: Option<&Value>) -> String {
    let verb = match kind {
        "edit" => "Edit".to_string(),
        "read" => "Read".to_string(),
        _ => humanize(word),
    };
    if let Some(input) = raw_input {
        let commands = strings(&input["commands"]);
        if !commands.is_empty() {
            return commands.join(" && ");
        }
        if let Some(path) = input["path"].as_str().filter(|p| !p.is_empty()) {
            return format!("{verb} {path}");
        }
        for key in ["paths", "files"] {
            let list = strings(&input[key]);
            if !list.is_empty() {
                return format!("{verb} {}", list.join(", "));
            }
        }
    }
    let rest = rest.trim();
    if rest.is_empty() || rest.starts_with('{') || rest.starts_with('[') {
        humanize(word)
    } else {
        rest.to_string()
    }
}

/// The text of a tool's results: `{result}` or `[{query, result}]`.
fn output_text(raw: &Value) -> Option<String> {
    let results: Vec<&str> = match raw {
        Value::Object(_) => raw["result"].as_str().or_else(|| raw["text"].as_str()).into_iter().collect(),
        Value::Array(items) => items.iter().filter_map(|i| i["result"].as_str()).collect(),
        _ => return None,
    };
    let text = results.join("\n");
    (!text.is_empty()).then_some(text)
}

/// Normalizes one Cline `tool_call` / `tool_call_update`. `seen` holds the tool call ids already
/// sent in this session: Cline sends the `tool_call` after its first updates (starting again from
/// `pending`), so a `tool_call` for a known id becomes an update without status.
pub(super) fn normalize_cline_tool(update: &mut Value, seen: &mut HashSet<String>) {
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("").to_string();
    let kind = kind.as_str();
    if kind != "tool_call" && kind != "tool_call_update" {
        return;
    }
    let Some(obj) = update.as_object_mut() else { return };
    if let Some(id) = obj.get("toolCallId").and_then(Value::as_str).map(str::to_string) {
        if !seen.insert(id) && kind == "tool_call" {
            obj.insert("sessionUpdate".into(), json!("tool_call_update"));
            obj.remove("status");
        }
    }
    if let Some(Value::String(raw)) = obj.get("rawOutput") {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            obj.insert("rawOutput".into(), parsed);
        }
    }
    if let Some(title) = obj.get("title").and_then(Value::as_str).map(str::to_string) {
        if let Some((word, rest)) = split_title(&title) {
            let tool_kind = obj.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
            let new_title = readable_title(word, rest, &tool_kind, obj.get("rawInput"));
            if obj.get("toolName").is_none() {
                obj.insert("toolName".into(), json!(word));
            }
            if let Some(Value::Object(input)) = obj.get_mut("rawInput") {
                if !strings(input.get("commands").unwrap_or(&Value::Null)).is_empty() {
                    input.insert("command".into(), json!(new_title));
                }
            }
            obj.insert("title".into(), json!(new_title));
        }
    }
    if !obj.contains_key("content") {
        if let Some(text) = obj.get("rawOutput").and_then(output_text) {
            obj.insert("content".into(), json!([{ "type": "content", "content": { "type": "text", "text": text } }]));
        }
    }
}

/// Cline sub-agents (`spawn_agent`): the child's text and tool calls arrive on the parent session with
/// nothing marking them, while the spawn call is `in_progress`.
#[derive(Default)]
pub(super) struct Spawns {
    /// Ids of the spawn calls seen.
    known: HashSet<String>,
    /// Spawn calls running (in_progress, not finished), oldest first.
    active: Vec<String>,
}

/// Marks sub-agent traffic of a (normalized) Cline update: the spawn call becomes a launch the chat
/// model recognizes (`rawInput.subagent_type` + `description` / `prompt` from `task`), and while one runs
/// every other update of the session is stamped `_meta.claudeCode.parentToolUseId` = the spawn call.
/// Limitation: Cline may run several spawns in parallel and nothing tells their output apart, so the
/// updates go to the OLDEST running one.
pub(super) fn mark_spawns(update: &mut Value, spawns: &mut Spawns) {
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("").to_string();
    let is_tool = kind == "tool_call" || kind == "tool_call_update";
    if !is_tool && kind != "agent_message_chunk" && kind != "agent_thought_chunk" {
        return;
    }
    let Some(obj) = update.as_object_mut() else { return };
    let id = obj.get("toolCallId").and_then(Value::as_str).map(str::to_string);
    if is_tool {
        let is_spawn = obj.get("toolName").and_then(Value::as_str) == Some("spawn_agent")
            || id.as_ref().is_some_and(|i| spawns.known.contains(i));
        if is_spawn {
            let Some(id) = id else { return };
            spawns.known.insert(id.clone());
            if let Some(Value::Object(input)) = obj.get_mut("rawInput") {
                if let Some(task) = input.get("task").and_then(Value::as_str).map(str::to_string) {
                    input.entry("description").or_insert_with(|| json!(task));
                    input.entry("prompt").or_insert_with(|| json!(task));
                }
                input.entry("subagent_type").or_insert_with(|| json!("Cline"));
            }
            match obj.get("status").and_then(Value::as_str) {
                Some("in_progress") if !spawns.active.contains(&id) => spawns.active.push(id),
                Some("completed" | "failed") => spawns.active.retain(|a| *a != id),
                _ => {}
            }
            return;
        }
    }
    let Some(parent) = spawns.active.first() else { return };
    let meta = obj.entry("_meta").or_insert_with(|| json!({}));
    if !meta.is_object() {
        *meta = json!({});
    }
    let code = &mut meta["claudeCode"];
    if !code.is_object() {
        *code = json!({});
    }
    code["parentToolUseId"] = json!(parent);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(update: Value) -> Value {
        let mut u = update;
        normalize_cline_tool(&mut u, &mut HashSet::new());
        u
    }

    #[test]
    fn commands_become_the_title_and_the_command() {
        let u = run(json!({"sessionUpdate": "tool_call_update", "toolCallId": "a", "kind": "execute", "title": "run_commands: dir",
            "rawInput": {"commands": ["dir", "echo hi"]}}));
        assert_eq!(u["title"], "dir && echo hi");
        assert_eq!(u["toolName"], "run_commands");
        assert_eq!(u["rawInput"]["command"], "dir && echo hi");
        assert_eq!(u["rawInput"]["commands"], json!(["dir", "echo hi"]));
    }

    #[test]
    fn edit_path_title() {
        let u = run(json!({"sessionUpdate": "tool_call", "toolCallId": "a", "kind": "edit",
            "title": "editor: {\"path\":\"C:\\\\x\\\\note.txt\", \"new_text\":\"hel...", "rawInput": {"path": "C:\\x\\note.txt", "new_text": "hello"}}));
        assert_eq!(u["title"], "Edit C:\\x\\note.txt");
        assert_eq!(u["toolName"], "editor");
    }

    #[test]
    fn paths_and_other_verbs() {
        let u = run(json!({"sessionUpdate": "tool_call", "toolCallId": "a", "kind": "read", "title": "read_files: {\"files\":[...", "rawInput": {"files": ["a", "b"]}}));
        assert_eq!(u["title"], "Read a, b");
        let u = run(json!({"sessionUpdate": "tool_call", "toolCallId": "a", "kind": "search", "title": "search_codebase: {\"path\":\"src\"}", "rawInput": {"path": "src"}}));
        assert_eq!(u["title"], "Search codebase src");
    }

    #[test]
    fn fallback_titles() {
        let u = run(json!({"sessionUpdate": "tool_call", "toolCallId": "a", "kind": "other", "title": "web_fetch: example page"}));
        assert_eq!(u["title"], "example page");
        let u = run(json!({"sessionUpdate": "tool_call", "toolCallId": "a", "kind": "other", "title": "web_fetch: {\"url\":\"x\"..."}));
        assert_eq!(u["title"], "Web fetch");
        // Not a raw title, or no title at all: untouched.
        let u = run(json!({"sessionUpdate": "tool_call", "toolCallId": "a", "title": "Read a.ts"}));
        assert_eq!(u["title"], "Read a.ts");
        assert!(u.get("toolName").is_none());
        let u = run(json!({"sessionUpdate": "tool_call_update", "toolCallId": "a", "status": "completed"}));
        assert_eq!(u, json!({"sessionUpdate": "tool_call_update", "toolCallId": "a", "status": "completed"}));
    }

    #[test]
    fn existing_tool_name_is_kept() {
        let u = run(json!({"sessionUpdate": "tool_call", "toolCallId": "a", "toolName": "mine", "title": "editor: x"}));
        assert_eq!(u["toolName"], "mine");
    }

    #[test]
    fn raw_output_string_is_parsed_and_shown() {
        let out = "[{\"query\":\"dir\",\"result\":\"a.txt\",\"success\":true},{\"query\":\"x\",\"result\":\"b\",\"success\":true}]";
        let u = run(json!({"sessionUpdate": "tool_call_update", "toolCallId": "a", "status": "completed", "rawOutput": out}));
        assert_eq!(u["rawOutput"][0]["query"], "dir");
        assert_eq!(u["content"], json!([{"type": "content", "content": {"type": "text", "text": "a.txt\nb"}}]));
        let u = run(json!({"sessionUpdate": "tool_call_update", "toolCallId": "a", "rawOutput": {"result": "done"}}));
        assert_eq!(u["content"][0]["content"]["text"], "done");
        // Plain text stays a string; existing content is kept.
        let u = run(json!({"sessionUpdate": "tool_call_update", "toolCallId": "a", "rawOutput": "not json", "content": []}));
        assert_eq!(u["rawOutput"], "not json");
        assert_eq!(u["content"], json!([]));
    }

    #[test]
    fn late_tool_call_never_resets_status() {
        let mut seen = HashSet::new();
        let mut first = json!({"sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "in_progress"});
        normalize_cline_tool(&mut first, &mut seen);
        assert_eq!(first["status"], "in_progress");
        let mut late = json!({"sessionUpdate": "tool_call", "toolCallId": "t", "status": "pending", "title": "editor: {\"path\":\"p\"", "kind": "edit", "rawInput": {"path": "p"}});
        normalize_cline_tool(&mut late, &mut seen);
        assert_eq!(late["sessionUpdate"], "tool_call_update");
        assert!(late.get("status").is_none());
        assert_eq!(late["title"], "Edit p");
        // Normal order (replay): the first sighting stays a tool_call.
        let mut fresh = json!({"sessionUpdate": "tool_call", "toolCallId": "u", "status": "pending"});
        normalize_cline_tool(&mut fresh, &mut seen);
        assert_eq!(fresh["sessionUpdate"], "tool_call");
        assert_eq!(fresh["status"], "pending");
    }

    fn spawn_flow(parallel: bool) -> (Spawns, Vec<Value>) {
        let mut sp = Spawns::default();
        let mut seen = HashSet::new();
        let mut out = vec![];
        let mut feed = |mut u: Value, sp: &mut Spawns, out: &mut Vec<Value>| {
            normalize_cline_tool(&mut u, &mut seen);
            mark_spawns(&mut u, sp);
            out.push(u);
        };
        let call = |id: &str| json!({"sessionUpdate": "tool_call", "toolCallId": id, "title": "spawn_agent: reply with the word PONG", "kind": "think", "status": "pending",
            "rawInput": {"systemPrompt": "s", "task": "reply with the word PONG"}});
        feed(call("s1"), &mut sp, &mut out);
        feed(json!({"sessionUpdate": "tool_call_update", "toolCallId": "s1", "status": "in_progress"}), &mut sp, &mut out);
        if parallel {
            feed(call("s2"), &mut sp, &mut out);
            feed(json!({"sessionUpdate": "tool_call_update", "toolCallId": "s2", "status": "in_progress"}), &mut sp, &mut out);
        }
        feed(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "PONG"}}), &mut sp, &mut out);
        feed(json!({"sessionUpdate": "tool_call_update", "toolCallId": "s1", "status": "completed", "rawOutput": {"text": "PONG", "iterations": 1}}), &mut sp, &mut out);
        feed(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "DONE"}}), &mut sp, &mut out);
        (sp, out)
    }

    #[test]
    fn spawn_child_chunk_is_parented_and_parent_chunk_is_not() {
        let (_, out) = spawn_flow(false);
        assert_eq!(out[2]["_meta"]["claudeCode"]["parentToolUseId"], "s1");
        assert!(out[4].get("_meta").is_none());
        // The spawn call itself is never re-parented.
        assert!(out[1].get("_meta").is_none());
    }

    #[test]
    fn spawn_call_is_a_launch_with_report() {
        let (_, out) = spawn_flow(false);
        assert_eq!(out[0]["rawInput"]["subagent_type"], "Cline");
        assert_eq!(out[0]["rawInput"]["description"], "reply with the word PONG");
        assert_eq!(out[0]["rawInput"]["task"], "reply with the word PONG");
        assert_eq!(out[0]["title"], "reply with the word PONG");
        assert_eq!(out[3]["content"][0]["content"]["text"], "PONG");
    }

    #[test]
    fn parallel_spawns_go_to_the_oldest() {
        let (sp, out) = spawn_flow(true);
        assert_eq!(out[4]["_meta"]["claudeCode"]["parentToolUseId"], "s1");
        // s1 done, s2 still running: the next chunk is s2's.
        assert_eq!(out[6]["_meta"]["claudeCode"]["parentToolUseId"], "s2");
        assert_eq!(sp.active, vec!["s2".to_string()]);
    }
}
