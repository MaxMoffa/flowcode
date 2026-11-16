//! The models and thinking levels an agent offers.

use super::*;

/// The extension event that tells every view a chat's model changed; its
/// params are the normalized models (`ChatModels::to_json`).
pub(super) const MODEL_EXT_METHOD: &str = "_flowcode/model";

/// One model the agent offers.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelChoice {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) description: Option<String>,
    /// The caption of the group it is listed under (grouped config options).
    pub(super) group: Option<String>,
}

/// Which ACP API changes the model: the two coexist while the protocol moves
/// from the unstable `models` to the session config options.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum ModelVia {
    /// `session/set_model` (the `models` of `session/new` / `session/load`).
    Models,
    /// `session/set_config_option` on the option with this id.
    ConfigOption { config_id: String },
}

/// The models a chat's agent offers, whichever API announced them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ChatModels {
    pub(super) current: String,
    pub(super) available: Vec<ModelChoice>,
    pub(super) via: ModelVia,
}

impl ChatModels {
    /// What the frontend gets: the shape of ACP's `models`, plus `group`.
    pub(super) fn to_json(&self) -> Value {
        let available: Vec<Value> = self
            .available
            .iter()
            .map(|m| {
                let mut entry = json!({ "modelId": m.id, "name": m.name });
                if let Some(description) = &m.description {
                    entry["description"] = json!(description);
                }
                if let Some(group) = &m.group {
                    entry["group"] = json!(group);
                }
                entry
            })
            .collect();
        json!({ "currentModelId": self.current, "availableModels": available })
    }

    pub(super) fn offers(&self, model_id: &str) -> bool {
        self.available.iter().any(|m| m.id == model_id)
    }
}

pub(super) fn opt_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The unstable ACP `models` object: `{ currentModelId, availableModels:
/// [{ modelId, name, description? }] }`. Entries without an id are skipped,
/// a name falls back to the id; `None` when nothing usable is left.
pub(super) fn models_from_models(models: &Value) -> Option<ChatModels> {
    let current = opt_str(models, "currentModelId")?;
    let available: Vec<ModelChoice> = models
        .get("availableModels")?
        .as_array()?
        .iter()
        .filter_map(|m| {
            let id = opt_str(m, "modelId")?;
            Some(ModelChoice { name: opt_str(m, "name").unwrap_or_else(|| id.clone()), id, description: opt_str(m, "description"), group: None })
        })
        .collect();
    (!available.is_empty()).then_some(ChatModels { current, available, via: ModelVia::Models })
}

/// The model option of ACP session config options: the `select` option of
/// category `model` (else the one with id `model`). Its options may be flat
/// (`{ value, name, description? }`) or grouped (`{ group, name, options }`);
/// groups are flattened, their name kept as each model's caption.
pub(super) fn models_from_config_options(options: &Value) -> Option<ChatModels> {
    let options = options.as_array()?;
    let is_model = |o: &&Value| o.get("category").and_then(Value::as_str) == Some("model");
    let option = options
        .iter()
        .find(is_model)
        .or_else(|| options.iter().find(|o| o.get("id").and_then(Value::as_str) == Some("model")))?;
    if option.get("type").and_then(Value::as_str).is_some_and(|t| t != "select") {
        return None;
    }
    let config_id = opt_str(option, "id")?;
    let current = opt_str(option, "currentValue")?;
    let available = select_choices(option)?;
    Some(ChatModels { current, available, via: ModelVia::ConfigOption { config_id } })
}

/// The choices of a `select` config option, flat (`{ value, name,
/// description? }`) or grouped (`{ group, name, options }`, flattened with the
/// group's name as each choice's caption); `None` when there are none.
pub(super) fn select_choices(option: &Value) -> Option<Vec<ModelChoice>> {
    let choice = |v: &Value, group: Option<&String>| {
        let id = opt_str(v, "value")?;
        Some(ModelChoice {
            name: opt_str(v, "name").unwrap_or_else(|| id.clone()),
            id,
            description: opt_str(v, "description"),
            group: group.cloned(),
        })
    };
    let mut available = Vec::new();
    for entry in option.get("options")?.as_array()? {
        match entry.get("options").and_then(Value::as_array) {
            Some(grouped) => {
                let caption = opt_str(entry, "name").or_else(|| opt_str(entry, "group"));
                available.extend(grouped.iter().filter_map(|v| choice(v, caption.as_ref())));
            }
            None => available.extend(choice(entry, None)),
        }
    }
    (!available.is_empty()).then_some(available)
}

/// The models a `session/new` / `session/load` result announces: its config
/// options when they have a model option (the newer API), else its `models`.
pub(super) fn normalize_models(result: &Value) -> Option<ChatModels> {
    result
        .get("configOptions")
        .and_then(models_from_config_options)
        .or_else(|| result.get("models").and_then(models_from_models))
}

/// The models after the agent accepted `model_id`: a `set_config_option`
/// answer carries every option anew (the agent may have changed the list),
/// otherwise only the current model moved.
pub(super) fn models_after_set(before: &ChatModels, result: &Value, model_id: &str) -> ChatModels {
    let fresh = match before.via {
        ModelVia::ConfigOption { .. } => result.get("configOptions").and_then(models_from_config_options),
        ModelVia::Models => None,
    };
    fresh.unwrap_or_else(|| ChatModels { current: model_id.to_string(), ..before.clone() })
}

/// The models after a `config_option_update`: `Some(new)` when they changed.
/// An update without a model option only matters to models that came from
/// config options (they're gone); `session/set_model` ones stay.
pub(super) fn models_after_config_update(before: Option<&ChatModels>, options: &Value) -> Option<Option<ChatModels>> {
    let next = match models_from_config_options(options) {
        Some(models) => Some(models),
        None if matches!(before, Some(ChatModels { via: ModelVia::ConfigOption { .. }, .. })) => None,
        None => return None,
    };
    (next.as_ref() != before).then_some(next)
}

/// The extension event that tells every view a chat's thinking level changed;
/// its params are the normalized levels (`ThoughtLevels::to_json`).
pub(super) const THOUGHT_EXT_METHOD: &str = "_flowcode/thought";

/// The thinking levels a chat's agent offers: its `thought_level` config
/// option. They depend on the model, so they come and go with it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ThoughtLevels {
    pub(super) config_id: String,
    pub(super) current: String,
    pub(super) available: Vec<ModelChoice>,
}

impl ThoughtLevels {
    /// What the frontend gets: `{ currentId, available: [{ id, name, description? }] }`.
    pub(super) fn to_json(&self) -> Value {
        let available: Vec<Value> = self
            .available
            .iter()
            .map(|c| {
                let mut entry = json!({ "id": c.id, "name": c.name });
                if let Some(description) = &c.description {
                    entry["description"] = json!(description);
                }
                entry
            })
            .collect();
        json!({ "currentId": self.current, "available": available })
    }

    pub(super) fn offers(&self, value: &str) -> bool {
        self.available.iter().any(|c| c.id == value)
    }
}

/// The thinking levels of ACP session config options: the `select` option of
/// category `thought_level`, flat or grouped like the model option.
pub(super) fn thought_from_config_options(options: &Value) -> Option<ThoughtLevels> {
    let option = options
        .as_array()?
        .iter()
        .find(|o| o.get("category").and_then(Value::as_str) == Some("thought_level"))?;
    if option.get("type").and_then(Value::as_str).is_some_and(|t| t != "select") {
        return None;
    }
    Some(ThoughtLevels {
        config_id: opt_str(option, "id")?,
        current: opt_str(option, "currentValue")?,
        available: select_choices(option)?,
    })
}

/// The levels after a `config_option_update`: `Some(new)` when they changed
/// (`Some(None)`: the agent no longer offers any).
pub(super) fn thought_after_config_update(before: Option<&ThoughtLevels>, options: &Value) -> Option<Option<ThoughtLevels>> {
    let next = thought_from_config_options(options);
    (next.as_ref() != before).then_some(next)
}

/// The levels after a `session/set_config_option` answer (the model's or the
/// level's own): its `configOptions`, when it has them, are authoritative;
/// otherwise only the level `asked` moved. `Some(new)` when they changed.
pub(super) fn thought_after_set(before: Option<&ThoughtLevels>, result: &Value, asked: Option<&str>) -> Option<Option<ThoughtLevels>> {
    if result.get("configOptions").is_some_and(Value::is_array) {
        return thought_after_config_update(before, &result["configOptions"]);
    }
    let before = before?;
    // The levels may have moved meanwhile (a model switch): only one they still offer.
    let asked = asked.filter(|v| *v != before.current && before.offers(v))?;
    Some(Some(ThoughtLevels { current: asked.to_string(), ..before.clone() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_unstable_models_object() {
        let result = json!({ "models": {
            "currentModelId": "sonnet",
            "availableModels": [
                { "modelId": "sonnet", "name": "Sonnet", "description": "Everyday" },
                { "modelId": "opus" },
                { "name": "no id" },
            ],
        } });
        let models = normalize_models(&result).unwrap();
        assert_eq!(models.via, ModelVia::Models);
        assert_eq!(
            models.to_json(),
            json!({ "currentModelId": "sonnet", "availableModels": [
                { "modelId": "sonnet", "name": "Sonnet", "description": "Everyday" },
                { "modelId": "opus", "name": "opus" },
            ] })
        );
    }

    #[test]
    fn prefers_the_model_config_option() {
        let result = json!({
            "models": { "currentModelId": "a", "availableModels": [{ "modelId": "a", "name": "A" }] },
            "configOptions": [
                { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "ask",
                  "options": [{ "value": "ask", "name": "Ask" }] },
                { "id": "llm", "name": "Model", "category": "model", "type": "select", "currentValue": "gpt-5",
                  "options": [{ "value": "gpt-5", "name": "GPT-5", "description": "Smart" }, { "value": "gpt-5-mini", "name": "Mini" }] },
            ],
        });
        let models = normalize_models(&result).unwrap();
        assert_eq!(models.via, ModelVia::ConfigOption { config_id: "llm".into() });
        assert_eq!(models.current, "gpt-5");
        assert_eq!(models.available.len(), 2);
        assert_eq!(models.available[0].description.as_deref(), Some("Smart"));

        // No model option among the config options: the `models` object it is.
        let result = json!({
            "models": { "currentModelId": "a", "availableModels": [{ "modelId": "a", "name": "A" }] },
            "configOptions": [{ "id": "mode", "category": "mode", "type": "select", "currentValue": "x", "options": [{ "value": "x", "name": "X" }] }],
        });
        assert_eq!(normalize_models(&result).unwrap().via, ModelVia::Models);
    }

    #[test]
    fn falls_back_to_the_option_called_model_and_flattens_groups() {
        let options = json!([{ "id": "model", "name": "Model", "type": "select", "currentValue": "b", "options": [
            { "group": "fast", "name": "Fast", "options": [{ "value": "a", "name": "A" }] },
            { "group": "smart", "options": [{ "value": "b", "name": "B" }, { "value": "c" }] },
        ] }]);
        let models = models_from_config_options(&options).unwrap();
        assert_eq!(
            models.to_json(),
            json!({ "currentModelId": "b", "availableModels": [
                { "modelId": "a", "name": "A", "group": "Fast" },
                { "modelId": "b", "name": "B", "group": "smart" },
                { "modelId": "c", "name": "c", "group": "smart" },
            ] })
        );
    }

    #[test]
    fn no_or_malformed_models_give_none() {
        assert!(normalize_models(&json!({ "sessionId": "s" })).is_none());
        assert!(normalize_models(&json!({ "models": null })).is_none());
        assert!(normalize_models(&json!({ "models": { "currentModelId": "a", "availableModels": [] } })).is_none());
        assert!(normalize_models(&json!({ "models": { "availableModels": [{ "modelId": "a" }] } })).is_none());
        assert!(normalize_models(&json!({ "models": { "currentModelId": "a", "availableModels": "a" } })).is_none());
        assert!(normalize_models(&json!({ "configOptions": { "id": "model" } })).is_none());
        let not_select = json!([{ "id": "model", "category": "model", "type": "boolean", "currentValue": "a", "options": [{ "value": "a" }] }]);
        assert!(models_from_config_options(&not_select).is_none());
        let no_current = json!([{ "id": "model", "category": "model", "type": "select", "options": [{ "value": "a" }] }]);
        assert!(models_from_config_options(&no_current).is_none());
        let no_options = json!([{ "id": "model", "category": "model", "type": "select", "currentValue": "a", "options": [{ "name": "x" }] }]);
        assert!(models_from_config_options(&no_options).is_none());
    }

    #[test]
    fn a_set_model_answer_updates_the_models() {
        let flat = models_from_models(&json!({ "currentModelId": "a", "availableModels": [{ "modelId": "a" }, { "modelId": "b" }] })).unwrap();
        assert!(flat.offers("b") && !flat.offers("z"));
        let after = models_after_set(&flat, &Value::Null, "b");
        assert_eq!((after.current.as_str(), after.available.len()), ("b", 2));

        let option = |current: &str| json!([{ "id": "model", "category": "model", "type": "select", "currentValue": current,
            "options": [{ "value": "a" }, { "value": "b" }, { "value": "c" }] }]);
        let config = models_from_config_options(&option("a")).unwrap();
        // The answer's options win (here the agent picked "c" for "b")...
        let after = models_after_set(&config, &json!({ "configOptions": option("c") }), "b");
        assert_eq!(after.current, "c");
        // ...and without any, the asked model is the current one.
        assert_eq!(models_after_set(&config, &json!({}), "b").current, "b");
    }

    #[test]
    fn config_option_updates_change_the_models_only_when_they_moved() {
        let option = |current: &str| json!([{ "id": "model", "category": "model", "type": "select", "currentValue": current,
            "options": [{ "value": "a" }, { "value": "b" }] }]);
        let config = models_from_config_options(&option("a")).unwrap();
        assert_eq!(models_after_config_update(Some(&config), &option("a")), None);
        assert_eq!(models_after_config_update(Some(&config), &option("b")).unwrap().unwrap().current, "b");
        assert_eq!(models_after_config_update(None, &option("a")), Some(Some(config.clone())));
        // The model option went away.
        assert_eq!(models_after_config_update(Some(&config), &json!([])), Some(None));
        // Models announced by `models` aren't config options: untouched.
        let flat = models_from_models(&json!({ "currentModelId": "a", "availableModels": [{ "modelId": "a" }] })).unwrap();
        assert_eq!(models_after_config_update(Some(&flat), &json!([])), None);
        assert_eq!(models_after_config_update(None, &json!([])), None);
    }

    fn effort(current: &str, levels: &[&str]) -> Value {
        let options: Vec<Value> = levels.iter().map(|l| json!({ "value": l, "name": l.to_uppercase() })).collect();
        json!({ "id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": current, "options": options })
    }

    #[test]
    fn normalizes_the_thought_level_option() {
        let flat = json!([{ "id": "model", "category": "model", "type": "select", "currentValue": "a", "options": [{ "value": "a" }] },
            effort("medium", &["low", "medium"])]);
        let thought = thought_from_config_options(&flat).unwrap();
        assert_eq!(thought.config_id, "effort");
        assert_eq!(
            thought.to_json(),
            json!({ "currentId": "medium", "available": [{ "id": "low", "name": "LOW" }, { "id": "medium", "name": "MEDIUM" }] })
        );
        assert!(thought.offers("low") && !thought.offers("max"));

        let mut grouped = effort("deep", &[]);
        grouped["options"] = json!([{ "group": "g", "name": "Levels", "options": [{ "value": "deep", "name": "Deep", "description": "Slow" }] }]);
        let thought = thought_from_config_options(&json!([grouped])).unwrap();
        assert_eq!(thought.to_json(), json!({ "currentId": "deep", "available": [{ "id": "deep", "name": "Deep", "description": "Slow" }] }));
    }

    #[test]
    fn no_or_malformed_thought_levels_give_none() {
        assert!(thought_from_config_options(&json!([])).is_none());
        assert!(thought_from_config_options(&json!({ "id": "effort" })).is_none());
        // Only the thought_level category counts.
        let mut other = effort("low", &["low"]);
        other["category"] = json!("mode");
        assert!(thought_from_config_options(&json!([other])).is_none());
        let mut not_select = effort("low", &["low"]);
        not_select["type"] = json!("boolean");
        assert!(thought_from_config_options(&json!([not_select])).is_none());
        let mut no_current = effort("low", &["low"]);
        no_current.as_object_mut().unwrap().remove("currentValue");
        assert!(thought_from_config_options(&json!([no_current])).is_none());
        assert!(thought_from_config_options(&json!([effort("low", &[])])).is_none());
    }

    #[test]
    fn thought_updates_only_when_it_moved() {
        let options = |current: &str| json!([effort(current, &["low", "high"])]);
        let before = thought_from_config_options(&options("low")).unwrap();
        assert_eq!(thought_after_config_update(Some(&before), &options("low")), None);
        assert_eq!(thought_after_config_update(Some(&before), &options("high")).unwrap().unwrap().current, "high");
        assert_eq!(thought_after_config_update(None, &options("low")), Some(Some(before.clone())));
        // The option went away.
        assert_eq!(thought_after_config_update(Some(&before), &json!([])), Some(None));
        assert_eq!(thought_after_config_update(None, &json!([])), None);
    }

    #[test]
    fn a_set_config_option_answer_updates_the_thought_levels() {
        let before = thought_from_config_options(&json!([effort("low", &["low", "high"])])).unwrap();
        // A level switch without options in the answer: the asked one is current.
        assert_eq!(thought_after_set(Some(&before), &json!({}), Some("high")).unwrap().unwrap().current, "high");
        assert_eq!(thought_after_set(Some(&before), &Value::Null, Some("low")), None);
        assert_eq!(thought_after_set(None, &json!({}), Some("high")), None);
        // A model switch whose answer has no options doesn't touch them...
        assert_eq!(thought_after_set(Some(&before), &json!({}), None), None);
        // ...one that changes the model and the levels does...
        let answer = json!({ "configOptions": [
            { "id": "model", "category": "model", "type": "select", "currentValue": "b", "options": [{ "value": "a" }, { "value": "b" }] },
            effort("medium", &["medium", "max"]),
        ] });
        let after = thought_after_set(Some(&before), &answer, None).unwrap().unwrap();
        assert_eq!((after.current.as_str(), after.available.len()), ("medium", 2));
        assert_eq!(models_after_set(&models_from_config_options(&answer["configOptions"]).unwrap(), &answer, "b").current, "b");
        // ...and one that drops them is authoritative, whatever was asked.
        let dropped = json!({ "configOptions": [] });
        assert_eq!(thought_after_set(Some(&before), &dropped, Some("high")), Some(None));
    }
}
