use serde_json::{Map, Value, json};

use crate::{AppEvent, SequencedAppEvent};

const IDENTIFIERS: &[&str] = &[
    "model",
    "modelId",
    "turnId",
    "interactionId",
    "apiCallId",
    "providerCallId",
    "serviceRequestId",
    "source",
    "outcome",
    "status",
    "failureKind",
    "transport",
    "apiEndpoint",
    "interactionType",
    "initiator",
    "reasoningEffort",
    "finishReason",
];
const METRICS: &[&str] = &[
    "durationMs",
    "dispatchDurationMs",
    "latencyMs",
    "timeToFirstTokenMs",
    "firstTokenLatencyMs",
    "totalLatencyMs",
    "statusCode",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cachedTokens",
    "reasoningTokens",
    "maxOutputTokens",
    "maxPromptTokens",
    "editClassifierVersion",
    "totalResponseSizeBytes",
    "totalNanoAiu",
    "messageCount",
    "toolCallCount",
    "frontierTokens",
    "shortfallTokens",
    "survivedTokens",
    "retentionRatio",
];

/// Project one SSE delivery without changing the underlying event log, replay
/// buffer, or sequence numbering. Diagnostics is not an unredacted prompt dump.
pub fn project_app_event(
    mut envelope: SequencedAppEvent,
    diagnostics: bool,
) -> Option<SequencedAppEvent> {
    let AppEvent::SessionEvent { event, .. } = &mut envelope.event else {
        return Some(envelope);
    };
    match event.event_type.as_str() {
        "model.messages_snapshot" | "model.message" | "model.response" | "system.message" => {
            if !diagnostics {
                return None;
            }
            let mut projected = model_metrics(&event.data);
            projected.insert("payloadOmitted".into(), Value::Bool(true));
            if let Some(messages) = event.data.get("messages").and_then(Value::as_array) {
                projected.insert("messageCount".into(), json!(messages.len()));
            }
            event.data = Value::Object(projected);
        }
        "session.usage_checkpoint" | "prompt_cache_break" | "assistant.streaming_delta" => {
            if !diagnostics {
                return None;
            }
            event.data = Value::Object(model_metrics(&event.data));
        }
        name if name.starts_with("model.") => {
            // Includes call_start, call_finished/failure and legacy turn_ended.
            // Never forward modelInfo, provider errors, messages, or raw responses.
            event.data = Value::Object(model_metrics(&event.data));
        }
        _ => {}
    }
    Some(envelope)
}

fn model_metrics(data: &Value) -> Map<String, Value> {
    let mut projected = Map::new();
    for key in IDENTIFIERS {
        if let Some(value) = data.get(*key).and_then(Value::as_str)
            && value.len() <= 256
        {
            projected.insert((*key).into(), Value::String(value.into()));
        }
    }
    for key in METRICS {
        if let Some(value) = data.get(*key).filter(|value| value.is_number()) {
            projected.insert((*key).into(), value.clone());
        }
    }
    for key in ["isAuto", "isByok", "rte", "containsBuiltInFileEditRequest"] {
        if let Some(value) = data.get(key).filter(|value| value.is_boolean()) {
            projected.insert(key.into(), value.clone());
        }
    }
    if let Some(usage) = data.get("usage").filter(|value| value.is_object()) {
        let metrics = METRICS
            .iter()
            .filter_map(|key| {
                usage
                    .get(*key)
                    .filter(|value| value.is_number())
                    .map(|value| ((*key).into(), value.clone()))
            })
            .collect();
        projected.insert("usage".into(), Value::Object(metrics));
    }
    projected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EventBus;

    fn event(kind: &str, data: Value) -> AppEvent {
        AppEvent::SessionEvent {
            session_id: "s".into(),
            event: serde_json::from_value(json!({
                "id":"event-id", "timestamp":"2026-09-04T23:54:00Z",
                "parentId":null, "type":kind, "data":data,
            }))
            .unwrap(),
        }
    }

    fn envelope(kind: &str, data: Value) -> SequencedAppEvent {
        SequencedAppEvent {
            sequence: 17,
            event: event(kind, data),
        }
    }

    #[test]
    fn normal_stream_drops_heavy_diagnostics_not_conversation() {
        for kind in [
            "model.messages_snapshot",
            "model.message",
            "model.response",
            "system.message",
            "session.usage_checkpoint",
            "prompt_cache_break",
            "assistant.streaming_delta",
        ] {
            assert!(
                project_app_event(envelope(kind, json!({"raw":"x".repeat(100_000)})), false)
                    .is_none(),
                "{kind}"
            );
        }
        for kind in [
            "assistant.message_delta",
            "assistant.reasoning_delta",
            "assistant.reasoning",
            "assistant.tool_call_delta",
            "tool.execution_start",
            "tool.execution_complete",
            "user.message",
            "session.idle",
            "session.error",
            "session.tools_updated",
        ] {
            let input = envelope(kind, json!({"content":"visible output"}));
            let expected = json!(input);
            assert_eq!(
                json!(project_app_event(input, false).unwrap()),
                expected,
                "{kind}"
            );
        }
    }

    #[test]
    fn diagnostic_mode_never_exposes_model_or_system_content() {
        for kind in [
            "model.messages_snapshot",
            "model.message",
            "model.response",
            "system.message",
            "prompt_cache_break",
        ] {
            let result = project_app_event(envelope(kind, json!({
                "messages":[{"role":"assistant","content":"hidden-analysis"}],
                "content":"hidden-analysis", "modelInfo":{"systemPrompt":"hidden-analysis"},
                "beforeRequest":{"messages":"hidden-analysis"}, "response":"hidden-analysis",
                "inputTokens":12,
            })), true).unwrap();
            let encoded = serde_json::to_string(&result).unwrap();
            assert!(!encoded.contains("hidden-analysis"));
            assert!(encoded.len() < 512);
            assert_eq!(result.sequence, 17);
        }
    }

    #[test]
    fn model_latency_survives_without_private_metadata() {
        for diagnostics in [false, true] {
            let result = project_app_event(
                envelope(
                    "model.turn_ended",
                    json!({
                        "model":"model", "turnId":"t", "durationMs":123,
                        "modelInfo":{"prompt":"private"}, "errorMessage":"private",
                        "usage":{"inputTokens":4,"outputTokens":2,"rawResponse":"private"},
                    }),
                ),
                diagnostics,
            )
            .unwrap();
            let data = json!(result)["event"]["data"].clone();
            assert_eq!(data["durationMs"], 123);
            assert_eq!(data["usage"], json!({"inputTokens":4,"outputTokens":2}));
            assert!(data.get("modelInfo").is_none());
            assert!(data.get("errorMessage").is_none());
        }
        let result = project_app_event(
            envelope(
                "model.call_start",
                json!({"model":"m","turnId":"t","previousResponseId":"private"}),
            ),
            false,
        )
        .unwrap();
        assert_eq!(
            json!(result)["event"]["data"],
            json!({"model":"m","turnId":"t"})
        );
    }

    #[tokio::test]
    async fn projection_preserves_raw_sequences_replay_and_control_events() {
        let bus = EventBus::new();
        bus.emit(event(
            "model.response",
            json!({"response":"original-payload"}),
        ));
        bus.emit(event("user.message", json!({"content":"hello"})));
        let mut normal = bus.subscribe(Some(0));
        assert!(project_app_event(normal.recv().await.unwrap(), false).is_none());
        assert_eq!(
            project_app_event(normal.recv().await.unwrap(), false)
                .unwrap()
                .sequence,
            2
        );

        let mut diagnostic = bus.subscribe(Some(0));
        let raw = diagnostic.recv().await.unwrap();
        assert_eq!(json!(raw)["event"]["data"]["response"], "original-payload");
        assert_eq!(project_app_event(raw, true).unwrap().sequence, 1);
        assert_eq!(diagnostic.recv().await.unwrap().sequence, 2);
        let mut after = bus.subscribe(Some(1));
        assert_eq!(after.recv().await.unwrap().sequence, 2);

        let gap = SequencedAppEvent {
            sequence: 99,
            event: AppEvent::EventGap {
                session_id: None,
                skipped: 3,
            },
        };
        assert_eq!(
            json!(project_app_event(gap.clone(), false).unwrap()),
            json!(gap)
        );
    }
}
