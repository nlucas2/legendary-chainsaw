use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use github_copilot_sdk::handler::{
    AutoModeSwitchHandler, AutoModeSwitchResponse, ElicitationHandler, ExitPlanModeHandler,
    ExitPlanModeResult, UserInputHandler, UserInputResponse,
};
use github_copilot_sdk::types::{
    ElicitationRequest, ElicitationResult, ExitPlanModeData, RequestId, SessionId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::{APPROVAL_TIMEOUT, EventBus, Result, ServiceError};
use crate::native_user_input::NativeUserInput;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    UserInput,
    Elicitation,
    ExitPlanMode,
    AutoModeSwitch,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInteraction {
    pub request_id: String,
    pub session_id: String,
    pub kind: InteractionKind,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionResponse {
    pub session_id: String,
    pub request_id: String,
    pub kind: InteractionKind,
    pub response: Value,
}

pub(crate) struct Pending {
    pub(crate) interaction: PendingInteraction,
    pub(crate) sender: oneshot::Sender<Value>,
}

pub(crate) struct InteractionBroker {
    pub(crate) events: Arc<EventBus>,
    pub(crate) pending: Mutex<HashMap<String, Pending>>,
    pub(crate) native: Mutex<NativeUserInput>,
    pub(crate) recovery_gate: tokio::sync::Mutex<()>,
    next_id: AtomicU64,
    instance_id: u128,
}

impl InteractionBroker {
    pub(crate) fn new(events: Arc<EventBus>) -> Self {
        Self {
            events,
            pending: Mutex::new(HashMap::new()),
            native: Mutex::new(NativeUserInput::default()),
            recovery_gate: tokio::sync::Mutex::new(()),
            next_id: AtomicU64::new(1),
            instance_id: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        }
    }

    pub(crate) fn list(&self, session_id: &str) -> Vec<PendingInteraction> {
        self.with_pending(|pending, native| native.list(pending, Some(session_id)))
    }

    pub(crate) fn respond(&self, response: InteractionResponse) -> Result<()> {
        self.prepare_response(response, false).map(|_| ())
    }

    fn remove(&self, request_id: &str) {
        self.with_pending(|pending, native| {
            if let Some(entry) = pending.remove(request_id) {
                native.callback_changed(&entry.interaction);
            }
            native.close_callback(request_id);
        });
    }

    pub(crate) fn clear_session(&self, session_id: &str) {
        self.with_pending(|pending, native| {
            pending.retain(|_, entry| entry.interaction.session_id != session_id);
            native.clear_session(session_id);
        });
    }

    pub(crate) fn clear_callbacks(&self, session_id: &str) {
        self.with_pending(|pending, native| {
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, entry)| entry.interaction.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                pending.remove(&id);
                native.close_callback(&id);
            }
            // Losing an SDK connection cancels its callback futures, not
            // notification-only prompts that still belong to the external CLI.
            native.invalidate_recovery(session_id);
        });
    }

    pub(crate) fn clear(&self) {
        self.with_pending(|pending, native| {
            pending.clear();
            native.clear();
        });
    }

    async fn ask(
        &self,
        session_id: SessionId,
        kind: InteractionKind,
        data: Value,
    ) -> Option<Value> {
        // Three SDK callbacks omit the native request id. These opaque UI ids map
        // to the actual SDK callback future; no second wire response is sent.
        let request_id = format!(
            "interaction-{}-{}",
            self.instance_id,
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let interaction = PendingInteraction {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            kind,
            data,
        };
        let (sender, receiver) = oneshot::channel();
        self.with_pending(|pending, native| {
            native.callback_changed(&interaction);
            pending.insert(
                request_id.clone(),
                Pending {
                    interaction: interaction.clone(),
                    sender,
                },
            );
        });
        let _guard = PendingGuard {
            broker: self,
            request_id,
        };
        tokio::time::timeout(APPROVAL_TIMEOUT, receiver)
            .await
            .ok()?
            .ok()
    }
}

struct PendingGuard<'a> {
    broker: &'a InteractionBroker,
    request_id: String,
}
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.broker.remove(&self.request_id);
    }
}

pub(crate) fn validate_response(interaction: &PendingInteraction, response: &Value) -> Result<()> {
    let invalid =
        || ServiceError::InvalidArgument(format!("invalid {:?} response", interaction.kind));
    match interaction.kind {
        InteractionKind::UserInput => {
            let object = response.as_object().ok_or_else(invalid)?;
            if response.get("noResponse") == Some(&Value::Bool(true)) {
                return if object.len() == 1 {
                    Ok(())
                } else {
                    Err(invalid())
                };
            }
            if object.len() != 2
                || !object.contains_key("answer")
                || !object.contains_key("wasFreeform")
            {
                return Err(invalid());
            }
            let answer = response
                .get("answer")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            let freeform = response
                .get("wasFreeform")
                .and_then(Value::as_bool)
                .ok_or_else(invalid)?;
            let preset = interaction
                .data
                .get("choices")
                .and_then(Value::as_array)
                .is_some_and(|choices| {
                    choices.iter().any(|choice| choice.as_str() == Some(answer))
                });
            if (!freeform && !preset)
                || (freeform && interaction.data.get("allowFreeform") == Some(&Value::Bool(false)))
            {
                return Err(invalid());
            }
        }
        InteractionKind::Elicitation => {
            if !matches!(
                response.get("action").and_then(Value::as_str),
                Some("accept" | "decline" | "cancel")
            ) {
                return Err(invalid());
            }
            if response.get("action").and_then(Value::as_str) == Some("accept") {
                if interaction
                    .data
                    .get("mode")
                    .is_some_and(|mode| !mode.is_string())
                {
                    return Err(unsupported_schema("unsupported elicitation mode"));
                }
                match interaction.data.get("mode").and_then(Value::as_str) {
                    Some("url") => {
                        if response.get("content").is_some() {
                            return Err(ServiceError::InvalidArgument(
                                "URL elicitation responses must omit content".into(),
                            ));
                        }
                    }
                    None | Some("form") => {
                        let schema = interaction.data.get("requestedSchema").ok_or_else(|| {
                            unsupported_schema("form mode requires requestedSchema")
                        })?;
                        let validator = compile_elicitation_schema(schema)?;
                        let content = response
                            .get("content")
                            .filter(|v| v.is_object())
                            .ok_or_else(|| {
                                ServiceError::InvalidArgument(
                                    "form elicitation requires object content".into(),
                                )
                            })?;
                        validator.validate(content).map_err(|error| {
                            // Report the field/constraint, not potentially sensitive answer values.
                            ServiceError::InvalidArgument(format!(
                                "elicitation content violates {} at {}",
                                error.schema_path(),
                                error.instance_path(),
                            ))
                        })?;
                    }
                    Some(_) => return Err(unsupported_schema("unsupported elicitation mode")),
                }
            }
        }
        InteractionKind::ExitPlanMode => {
            if response
                .get("autoApproveEdits")
                .is_some_and(|value| value != &Value::Bool(false))
            {
                return Err(ServiceError::InvalidArgument(
                    "plan approval cannot override tool permission policy".into(),
                ));
            }
            let approved = response
                .get("approved")
                .and_then(Value::as_bool)
                .ok_or_else(invalid)?;
            if response
                .get("selectedAction")
                .is_some_and(|value| !value.is_null() && !value.is_string())
            {
                return Err(invalid());
            }
            if approved {
                let action = response
                    .get("selectedAction")
                    .and_then(Value::as_str)
                    .ok_or_else(invalid)?;
                if !interaction
                    .data
                    .get("actions")
                    .and_then(Value::as_array)
                    .is_some_and(|actions| {
                        actions.iter().any(|value| value.as_str() == Some(action))
                    })
                {
                    return Err(invalid());
                }
            }
            if response
                .get("feedback")
                .is_some_and(|v| !v.is_null() && !v.is_string())
            {
                return Err(invalid());
            }
        }
        InteractionKind::AutoModeSwitch => {
            serde_json::from_value::<AutoModeSwitchResponse>(
                response.get("response").unwrap_or(response).clone(),
            )
            .map_err(|_| invalid())?;
        }
    }
    Ok(())
}

fn unsupported_schema(message: &str) -> ServiceError {
    ServiceError::CapabilityUnavailable(format!("unsupported elicitation schema: {message}"))
}

fn schema_object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| unsupported_schema("expected a schema object"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(unsupported_schema(&format!(
            "keyword {key:?} is not supported"
        )));
    }
    Ok(object)
}

fn check_enum(schema: &serde_json::Map<String, Value>, titled_key: &str) -> Result<()> {
    if let Some(values) = schema.get("enum") {
        let values = values
            .as_array()
            .filter(|v| !v.is_empty() && v.iter().all(Value::is_string))
            .ok_or_else(|| unsupported_schema("enum must contain string choices"))?;
        if schema.contains_key(titled_key) {
            return Err(unsupported_schema("mixed enum encodings are not supported"));
        }
        if let Some(names) = schema.get("enumNames")
            && !names.as_array().is_some_and(|names| {
                names.len() == values.len() && names.iter().all(Value::is_string)
            })
        {
            return Err(unsupported_schema(
                "enumNames must label every string choice",
            ));
        }
    } else if schema.contains_key("enumNames") {
        return Err(unsupported_schema("enumNames requires enum"));
    }
    if let Some(choices) = schema.get(titled_key) {
        let choices = choices
            .as_array()
            .filter(|choices| !choices.is_empty())
            .ok_or_else(|| unsupported_schema("titled enum requires choices"))?;
        for choice in choices {
            let choice = schema_object(choice, &["const", "title"])?;
            if !choice.get("const").is_some_and(Value::is_string)
                || choice.get("title").is_some_and(|title| !title.is_string())
            {
                return Err(unsupported_schema(
                    "titled enum choices must have string const/title",
                ));
            }
        }
    }
    Ok(())
}

fn compile_elicitation_schema(schema: &Value) -> Result<jsonschema::Validator> {
    // The pinned SDK exposes an object with properties/required. Property
    // definitions use MCP's flat primitive/enum form profile, not arbitrary
    // JSON Schema. This checks support only; jsonschema evaluates constraints.
    let root = schema_object(
        schema,
        &[
            "$schema",
            "type",
            "properties",
            "required",
            "title",
            "description",
            "additionalProperties",
        ],
    )?;
    if root.get("type").and_then(Value::as_str) != Some("object") {
        return Err(unsupported_schema("form root must be an object"));
    }
    if root.get("$schema").is_some_and(|value| {
        !matches!(
            value.as_str(),
            Some(
                "https://json-schema.org/draft/2020-12/schema"
                    | "https://json-schema.org/draft/2020-12/schema#"
            )
        )
    }) {
        return Err(unsupported_schema(
            "only the JSON Schema 2020-12 form dialect is supported",
        ));
    }
    if root
        .get("additionalProperties")
        .is_some_and(|value| value != &Value::Bool(false))
    {
        return Err(unsupported_schema(
            "only declared form fields are supported",
        ));
    }
    let properties = root
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| unsupported_schema("properties must be an object"))?;
    if let Some(required) = root.get("required")
        && !required.as_array().is_some_and(|fields| {
            fields.iter().all(|name| {
                name.as_str()
                    .is_some_and(|name| properties.contains_key(name))
            })
        })
    {
        return Err(unsupported_schema("required must name declared fields"));
    }
    for field in properties.values() {
        let kind = field.get("type").and_then(Value::as_str);
        let allowed: &[&str] = match kind {
            Some("string") => &[
                "type",
                "title",
                "description",
                "default",
                "minLength",
                "maxLength",
                "pattern",
                "format",
                "enum",
                "enumNames",
                "oneOf",
            ],
            Some("number" | "integer") => &[
                "type",
                "title",
                "description",
                "default",
                "minimum",
                "maximum",
            ],
            Some("boolean") => &["type", "title", "description", "default"],
            Some("array") => &[
                "type",
                "title",
                "description",
                "default",
                "minItems",
                "maxItems",
                "items",
            ],
            _ => {
                return Err(unsupported_schema(
                    "only primitive fields and string-enum arrays are supported",
                ));
            }
        };
        let field = schema_object(field, allowed)?;
        if kind == Some("string") {
            check_enum(field, "oneOf")?;
            if field.get("format").is_some_and(|format| {
                !matches!(
                    format.as_str(),
                    Some("email" | "uri" | "date" | "date-time")
                )
            }) {
                return Err(unsupported_schema("unsupported string format"));
            }
        }
        if kind == Some("array") {
            let items = schema_object(
                field
                    .get("items")
                    .ok_or_else(|| unsupported_schema("array fields require enum items"))?,
                &["type", "enum", "enumNames", "anyOf"],
            )?;
            check_enum(items, "anyOf")?;
            if items.contains_key("enum") {
                if items.get("type").and_then(Value::as_str) != Some("string") {
                    return Err(unsupported_schema("enum items must have string type"));
                }
            } else if !items.contains_key("anyOf")
                || items
                    .get("type")
                    .is_some_and(|value| value.as_str() != Some("string"))
            {
                return Err(unsupported_schema("array items must be a string enum"));
            }
        }
    }
    let mut normalized = schema.clone();
    normalized["additionalProperties"] = Value::Bool(false);
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .should_validate_formats(true)
        .should_ignore_unknown_formats(false)
        .with_pattern_options(jsonschema::PatternOptions::fancy_regex().backtrack_limit(10_000))
        .build(&normalized)
        .map_err(|error| {
            unsupported_schema(&format!(
                "invalid or unsupported constraint at {}",
                error.schema_path()
            ))
        })
}

#[async_trait]
impl UserInputHandler for InteractionBroker {
    async fn handle(
        &self,
        session_id: SessionId,
        question: String,
        choices: Option<Vec<String>>,
        allow_freeform: Option<bool>,
    ) -> Option<UserInputResponse> {
        let response = self.ask(session_id, InteractionKind::UserInput, json!({ "question": question, "choices": choices, "allowFreeform": allow_freeform })).await?;
        Some(UserInputResponse {
            answer: response.get("answer")?.as_str()?.to_string(),
            was_freeform: response.get("wasFreeform")?.as_bool()?,
        })
    }
}

#[async_trait]
impl ElicitationHandler for InteractionBroker {
    async fn handle(
        &self,
        session_id: SessionId,
        _request_id: RequestId,
        request: ElicitationRequest,
    ) -> ElicitationResult {
        self.ask(session_id, InteractionKind::Elicitation, json!(request))
            .await
            .and_then(|response| serde_json::from_value(response).ok())
            .unwrap_or(ElicitationResult {
                action: "cancel".into(),
                content: None,
            })
    }
}

#[async_trait]
impl ExitPlanModeHandler for InteractionBroker {
    async fn handle(&self, session_id: SessionId, data: ExitPlanModeData) -> ExitPlanModeResult {
        let response = self
            .ask(session_id, InteractionKind::ExitPlanMode, json!(data))
            .await;
        ExitPlanModeResult {
            approved: response
                .as_ref()
                .and_then(|v| v.get("approved"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            selected_action: response
                .as_ref()
                .and_then(|v| v.get("selectedAction"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            feedback: response
                .as_ref()
                .and_then(|v| v.get("feedback"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

#[async_trait]
impl AutoModeSwitchHandler for InteractionBroker {
    async fn handle(
        &self,
        session_id: SessionId,
        error_code: Option<String>,
        retry_after_seconds: Option<f64>,
    ) -> AutoModeSwitchResponse {
        self.ask(
            session_id,
            InteractionKind::AutoModeSwitch,
            json!({ "errorCode": error_code, "retryAfterSeconds": retry_after_seconds }),
        )
        .await
        .and_then(|response| {
            serde_json::from_value(response.get("response").unwrap_or(&response).clone()).ok()
        })
        .unwrap_or(AutoModeSwitchResponse::No)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppEvent;

    fn validation_cases() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("tests")
            .join("interaction-validation.cases.json");
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn native_form_constraints_match_shared_cases() {
        let cases = validation_cases();
        for case in cases["cases"].as_array().unwrap() {
            let validator = compile_elicitation_schema(&case["schema"])
                .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            for valid in case["valid"].as_array().unwrap() {
                assert!(
                    validator.is_valid(valid),
                    "{}: valid input rejected",
                    case["name"]
                );
            }
            for invalid in case["invalid"].as_array().unwrap() {
                assert!(
                    !validator.is_valid(invalid),
                    "{}: invalid input accepted",
                    case["name"]
                );
            }
        }
        for case in cases["unsupported"].as_array().unwrap() {
            assert!(
                compile_elicitation_schema(&case["schema"]).is_err(),
                "{}: unsupported schema accepted",
                case["name"]
            );
        }
    }

    #[tokio::test]
    async fn invalid_elicitation_answers_never_consume_pending_requests() {
        let cases = validation_cases();
        for case in cases["cases"].as_array().unwrap() {
            let bus = EventBus::new();
            let broker = Arc::new(InteractionBroker::new(bus.clone()));
            let mut events = bus.subscribe(None);
            let task = {
                let broker = broker.clone();
                let schema = case["schema"].clone();
                tokio::spawn(async move {
                    broker
                        .ask(
                            SessionId::new("s"),
                            InteractionKind::Elicitation,
                            json!({"requestedSchema":schema}),
                        )
                        .await
                })
            };
            let AppEvent::InteractionRequested { interaction } = events.recv().await.unwrap().event
            else {
                panic!()
            };
            for content in case["invalid"].as_array().unwrap() {
                assert!(
                    broker
                        .respond(InteractionResponse {
                            session_id: "s".into(),
                            request_id: interaction.request_id.clone(),
                            kind: InteractionKind::Elicitation,
                            response: json!({"action":"accept","content":content}),
                        })
                        .is_err(),
                    "{}: invalid reply accepted",
                    case["name"]
                );
                assert_eq!(broker.list("s").len(), 1);
                assert!(!task.is_finished());
            }
            let content = &case["valid"][0];
            broker
                .respond(InteractionResponse {
                    session_id: "s".into(),
                    request_id: interaction.request_id.clone(),
                    kind: InteractionKind::Elicitation,
                    response: json!({"action":"accept","content":content}),
                })
                .unwrap();
            assert_eq!(task.await.unwrap().unwrap()["content"], *content);
            assert!(broker.list("s").is_empty());
            assert!(matches!(
                events.recv().await.unwrap().event,
                AppEvent::InteractionResolved { .. }
            ));
        }
    }

    #[tokio::test]
    async fn unsupported_form_can_be_declined_without_consuming_invalid_acceptance() {
        for case in validation_cases()["unsupported"].as_array().unwrap() {
            let bus = EventBus::new();
            let broker = Arc::new(InteractionBroker::new(bus.clone()));
            let mut events = bus.subscribe(None);
            let task = {
                let broker = broker.clone();
                let schema = case["schema"].clone();
                tokio::spawn(async move {
                    broker
                        .ask(
                            SessionId::new("s"),
                            InteractionKind::Elicitation,
                            json!({"requestedSchema":schema}),
                        )
                        .await
                })
            };
            let AppEvent::InteractionRequested { interaction } = events.recv().await.unwrap().event
            else {
                panic!()
            };
            assert!(matches!(
                broker.respond(InteractionResponse {
                    session_id: "s".into(),
                    request_id: interaction.request_id.clone(),
                    kind: InteractionKind::Elicitation,
                    response: json!({"action":"accept","content":{}}),
                }),
                Err(ServiceError::CapabilityUnavailable(_))
            ));
            assert_eq!(broker.list("s").len(), 1);
            broker
                .respond(InteractionResponse {
                    session_id: "s".into(),
                    request_id: interaction.request_id,
                    kind: InteractionKind::Elicitation,
                    response: json!({"action":"decline"}),
                })
                .unwrap();
            assert_eq!(task.await.unwrap().unwrap()["action"], "decline");
        }
    }

    #[test]
    fn required_false_is_valid_but_defaults_are_not_implicit_answers() {
        let validator = compile_elicitation_schema(&json!({
            "type":"object", "properties":{"agree":{"type":"boolean","default":false}}, "required":["agree"]
        })).unwrap();
        assert!(validator.is_valid(&json!({"agree":false})));
        assert!(!validator.is_valid(&json!({})));
        assert!(!validator.is_valid(&json!({"agree":"false"})));
    }

    #[test]
    fn url_elicitation_is_not_a_form_and_unknown_modes_fail_explicitly() {
        let mut request = PendingInteraction {
            session_id: "s".into(),
            request_id: "r".into(),
            kind: InteractionKind::Elicitation,
            data: json!({"mode":"url"}),
        };
        assert!(validate_response(&request, &json!({"action":"accept"})).is_ok());
        assert!(validate_response(&request, &json!({"action":"accept","content":{}})).is_err());
        request.data =
            json!({"mode":"unsupported","requestedSchema":{"type":"object","properties":{}}});
        assert!(matches!(
            validate_response(&request, &json!({"action":"accept","content":{}})),
            Err(ServiceError::CapabilityUnavailable(_))
        ));
        assert!(validate_response(&request, &json!({"action":"cancel"})).is_ok());
    }

    #[test]
    fn interaction_events_match_ui_contract() {
        let requested = json!(AppEvent::InteractionRequested {
            interaction: PendingInteraction {
                request_id: "r".into(),
                session_id: "s".into(),
                kind: InteractionKind::ExitPlanMode,
                data: json!({"summary":"Plan"}),
            },
        });
        assert_eq!(requested["type"], "interaction_requested");
        assert_eq!(requested["interaction"]["sessionId"], "s");
        assert_eq!(requested["interaction"]["requestId"], "r");
        assert_eq!(requested["interaction"]["kind"], "exit_plan_mode");
        let resolved = json!(AppEvent::InteractionResolved {
            session_id: "s".into(),
            request_id: "r".into()
        });
        assert_eq!(
            resolved,
            json!({"type":"interaction_resolved","sessionId":"s","requestId":"r"})
        );
    }

    #[tokio::test]
    async fn callback_waits_and_resolves_exactly_once() {
        let bus = EventBus::new();
        let broker = Arc::new(InteractionBroker::new(bus.clone()));
        let mut events = bus.subscribe(None);
        let task = {
            let broker = broker.clone();
            tokio::spawn(async move {
                UserInputHandler::handle(
                    &*broker,
                    SessionId::new("s"),
                    "Question?".into(),
                    None,
                    Some(true),
                )
                .await
            })
        };
        let requested = events.recv().await.unwrap();
        let AppEvent::InteractionRequested { interaction } = requested.event else {
            panic!()
        };
        assert!(!task.is_finished());
        let response = || InteractionResponse {
            session_id: "s".into(),
            request_id: interaction.request_id.clone(),
            kind: InteractionKind::UserInput,
            response: json!({"answer":"yes","wasFreeform":true}),
        };
        broker.respond(response()).unwrap();
        assert!(broker.respond(response()).is_err());
        assert_eq!(task.await.unwrap().unwrap().answer, "yes");
        assert!(broker.list("s").is_empty());
        assert!(matches!(
            events.recv().await.unwrap().event,
            AppEvent::InteractionResolved { .. }
        ));
    }

    #[tokio::test]
    async fn disconnect_cancels_without_approval() {
        let broker = Arc::new(InteractionBroker::new(EventBus::new()));
        let task = {
            let broker = broker.clone();
            tokio::spawn(async move {
                ExitPlanModeHandler::handle(
                    &*broker,
                    SessionId::new("s"),
                    ExitPlanModeData::default(),
                )
                .await
            })
        };
        tokio::task::yield_now().await;
        broker.clear_session("s");
        assert!(!task.await.unwrap().approved);
        assert!(broker.list("s").is_empty());
    }

    #[tokio::test]
    async fn wrong_session_or_kind_cannot_consume_pending_answer() {
        let broker = Arc::new(InteractionBroker::new(EventBus::new()));
        let task = {
            let broker = broker.clone();
            tokio::spawn(async move {
                UserInputHandler::handle(
                    &*broker,
                    SessionId::new("s"),
                    "Question?".into(),
                    None,
                    Some(true),
                )
                .await
            })
        };
        tokio::task::yield_now().await;
        let interaction = broker.list("s").pop().unwrap();
        for (session, kind) in [
            ("other", InteractionKind::UserInput),
            ("s", InteractionKind::ExitPlanMode),
        ] {
            assert!(
                broker
                    .respond(InteractionResponse {
                        session_id: session.into(),
                        request_id: interaction.request_id.clone(),
                        kind,
                        response: json!({"answer":"answer","wasFreeform":true}),
                    })
                    .is_err()
            );
        }
        assert_eq!(broker.list("s").len(), 1);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(broker.list("s").is_empty());
    }

    #[test]
    fn invalid_elicitation_and_plan_actions_are_rejected() {
        let mut interaction = PendingInteraction {
            request_id: "r".into(),
            session_id: "s".into(),
            kind: InteractionKind::Elicitation,
            data: json!({"requestedSchema":{"type":"object"}}),
        };
        assert!(validate_response(&interaction, &json!({"action":"unknown"})).is_err());
        assert!(
            validate_response(
                &interaction,
                &json!({"action":"accept","content":"not an object"})
            )
            .is_err()
        );
        interaction.kind = InteractionKind::ExitPlanMode;
        interaction.data = json!({"actions":["interactive"]});
        assert!(
            validate_response(
                &interaction,
                &json!({"approved":true,"selectedAction":"autopilot"})
            )
            .is_err()
        );
        assert!(
            validate_response(
                &interaction,
                &json!({"approved":true,"selectedAction":"interactive","autoApproveEdits":true})
            )
            .is_err()
        );
        assert!(validate_response(&interaction, &json!({"approved":false})).is_ok());
    }
}
