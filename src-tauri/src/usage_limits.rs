use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum QuotaPeriod {
    FiveHours,
    Week,
    Month,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageWindow {
    pub period: QuotaPeriod,
    pub percent_used: f64,
    pub resets_at: Option<Value>,
}

impl UsageWindow {
    pub fn new(period: QuotaPeriod, percent: &Value, reset: &Value) -> Option<Self> {
        let percent_used = percent.as_f64().filter(|p| p.is_finite() && *p >= 0.0)?;
        Some(Self {
            period,
            percent_used: percent_used.min(100.0),
            resets_at: reset_time(reset),
        })
    }
}

/// OpenCode uses epoch milliseconds. Cline uses an ISO timestamp.
pub(crate) fn reset_time(value: &Value) -> Option<Value> {
    match value {
        Value::Number(n) if n.as_u64().is_some_and(|ts| ts > 0) => Some(value.clone()),
        Value::String(s) if !s.trim().is_empty() && s.len() <= 64 => Some(value.clone()),
        _ => None,
    }
}
