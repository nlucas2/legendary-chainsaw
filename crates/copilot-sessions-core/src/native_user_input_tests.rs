use super::*;
use crate::EventBus;
use github_copilot_sdk::handler::{UserInputHandler, UserInputResponse};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::types::{ResumeSessionConfig, SessionId};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex as AsyncMutex, mpsc};

type Writer = Arc<AsyncMutex<tokio::io::WriteHalf<tokio::io::DuplexStream>>>;

struct Runtime {
    client: Client,
    _session: Arc<Session>,
    broker: Arc<InteractionBroker>,
    incoming: mpsc::UnboundedReceiver<Value>,
    writer: Writer,
    task: tokio::task::JoinHandle<()>,
}

async fn write(writer: &Writer, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut writer = writer.lock().await;
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
        .await
        .unwrap();
    writer.write_all(&bytes).await.unwrap();
}

impl Runtime {
    async fn new() -> Self {
        let (transport, server) = tokio::io::duplex(65536);
        let (read, write_half) = tokio::io::split(transport);
        let client = Client::from_streams(read, write_half, PathBuf::from(".")).unwrap();
        let (read, write_half) = tokio::io::split(server);
        let writer = Arc::new(AsyncMutex::new(write_half));
        let writer_clone = writer.clone();
        let (tx, incoming) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut read = BufReader::new(read);
            loop {
                let mut header = String::new();
                if read.read_line(&mut header).await.unwrap_or(0) == 0 {
                    break;
                }
                let size: usize = header
                    .trim()
                    .strip_prefix("Content-Length: ")
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut blank = String::new();
                read.read_line(&mut blank).await.unwrap();
                let mut bytes = vec![0; size];
                read.read_exact(&mut bytes).await.unwrap();
                let message: Value = serde_json::from_slice(&bytes).unwrap();
                match message["method"].as_str() {
                    Some("session.eventLog.tail") => {
                        write(
                            &writer_clone,
                            json!({"jsonrpc":"2.0","id":message["id"],
                            "result":{"cursor":"live-tail"}}),
                        )
                        .await;
                    }
                    Some("session.eventLog.read" | "session.ui.handlePendingUserInput") => {
                        tx.send(message).unwrap();
                    }
                    _ => {
                        write(
                            &writer_clone,
                            json!({"jsonrpc":"2.0","id":message["id"],
                        "result":{"sessionId":message["params"]["sessionId"]}}),
                        )
                        .await
                    }
                }
            }
        });
        let broker = Arc::new(InteractionBroker::new(EventBus::new()));
        let session = Arc::new(
            client
                .resume_session(
                    ResumeSessionConfig::new(SessionId::new("parent"))
                        .with_user_input_handler(broker.clone()),
                )
                .await
                .unwrap(),
        );
        Self {
            client,
            _session: session,
            broker,
            incoming,
            writer,
            task,
        }
    }

    async fn next(&mut self, method: &str) -> Value {
        let request = tokio::time::timeout(Duration::from_secs(2), self.incoming.recv())
            .await
            .expect("expected RPC")
            .unwrap();
        assert_eq!(request["method"], method);
        request
    }

    async fn reply(&self, request: &Value, result: Value) {
        write(
            &self.writer,
            json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
        )
        .await;
    }

    fn answer(&self, sid: &str, id: &str, value: Value) -> tokio::task::JoinHandle<Result<()>> {
        let broker = self.broker.clone();
        let client = self.client.clone();
        let response = response(sid, id, value);
        tokio::spawn(async move { broker.respond_native(response, &client).await })
    }

    fn recover(&self) -> tokio::task::JoinHandle<Result<()>> {
        let broker = self.broker.clone();
        let client = self.client.clone();
        tokio::spawn(async move { broker.recover_native("parent", &client).await })
    }

    fn service(&self) -> Arc<crate::SessionService> {
        use std::sync::{Mutex, atomic::AtomicBool};
        use tokio::sync::RwLock;
        Arc::new(crate::SessionService {
            client: RwLock::new(Some(self.client.clone())),
            accepting_work: AtomicBool::new(true),
            active: RwLock::new(HashMap::new()),
            warmed: RwLock::new(HashSet::new()),
            initializations: RwLock::new(Default::default()),
            turn_gates: RwLock::new(HashMap::new()),
            ask_gates: RwLock::new(HashMap::new()),
            last_submissions: RwLock::new(HashMap::new()),
            create_gate: AsyncMutex::new(()),
            runtime_gate: AsyncMutex::new(()),
            lifecycle_gate: RwLock::new(()),
            session_cache: RwLock::new(Vec::new()),
            events: self.broker.events.clone(),
            approvals: Arc::new(crate::ApprovalBroker {
                events: self.broker.events.clone(),
                pending: Mutex::new(HashMap::new()),
            }),
            interactions: self.broker.clone(),
            tool_state: RwLock::new(HashMap::new()),
            tool_catalog: crate::tool_catalog::ToolCatalog::default(),
            // This test only attaches/reads/answers mocked prompts; no metadata is written.
            metadata_path: PathBuf::from("target").join("native-user-input-unused.json"),
            metadata: RwLock::new(HashMap::new()),
            metadata_write_gate: AsyncMutex::new(()),
        })
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn requested(id: &str) -> Value {
    json!({"id":format!("event-{id}"),"type":"user_input.requested","ephemeral":true,
        "data":{"requestId":id,"question":"Continue?","choices":["Yes","No"],
            "allowFreeform":false,"toolCallId":format!("tool-{id}")}})
}

fn completed(id: &str) -> Value {
    json!({"type":"user_input.completed","data":{"requestId":id}})
}

fn response(sid: &str, id: &str, value: Value) -> InteractionResponse {
    InteractionResponse {
        session_id: sid.into(),
        request_id: id.into(),
        kind: InteractionKind::UserInput,
        response: value,
    }
}

fn yes() -> Value {
    json!({"answer":"Yes","wasFreeform":false})
}

#[tokio::test]
async fn service_forward_relay_and_async_endpoints_handle_notification_only_prompts() {
    let mut runtime = Runtime::new().await;
    let service = runtime.service();
    service.attach(runtime._session.clone()).await.unwrap();
    let poll = runtime.next("session.eventLog.read").await;
    assert_eq!(poll["params"]["waitMs"], 30000);
    let mut prompt = requested("native");
    prompt["timestamp"] = json!("2026-09-14T00:00:00Z");
    runtime
        .reply(
            &poll,
            json!({"cursor":"after-request","hasMore":false,"events":[prompt]}),
        )
        .await;
    let outstanding_poll = runtime.next("session.eventLog.read").await;
    assert_eq!(service.pending_interactions("parent").len(), 1);

    let list = {
        let service = service.clone();
        tokio::spawn(async move { service.pending_interactions_async("parent").await })
    };
    let recovery = runtime.next("session.eventLog.read").await;
    assert_eq!(recovery["params"]["types"], json!(RECOVERY_TYPES));
    runtime
        .reply(
            &recovery,
            json!({"cursor":"after-request","hasMore":false,
        "events":[requested("old"), completed("old"), requested("native")]}),
        )
        .await;
    let pending = list.await.unwrap().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request_id, "native");

    let answer = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .respond_interaction_async(response("parent", "native", yes()))
                .await
        })
    };
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    runtime.reply(&wire, json!({"handled":true})).await;
    answer.await.unwrap().unwrap();
    assert!(service.pending_interactions("parent").is_empty());
    service.active.write().await.clear();
    runtime
        .reply(
            &outstanding_poll,
            json!({"cursor":"end","hasMore":false,"events":[]}),
        )
        .await;
}

async fn callback(
    broker: &Arc<InteractionBroker>,
) -> (String, tokio::task::JoinHandle<Option<UserInputResponse>>) {
    let count = broker.pending.lock().unwrap().len();
    let cloned = broker.clone();
    let task = tokio::spawn(async move {
        UserInputHandler::handle(
            &*cloned,
            SessionId::new("parent"),
            "Continue?".into(),
            Some(vec!["Yes".into(), "No".into()]),
            Some(false),
        )
        .await
    });
    let id = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            {
                let pending = broker.pending.lock().unwrap();
                if pending.len() > count {
                    break pending.keys().max().unwrap().clone();
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    (id, task)
}

#[tokio::test]
async fn notification_only_uses_authoritative_id_and_exact_generated_rpc() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let listed = runtime.broker.list("parent");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].request_id, "native");
    assert!(runtime.broker.list("elsewhere").is_empty());
    let answer = runtime.answer("parent", "native", yes());
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    assert_eq!(
        wire["params"],
        json!({"sessionId":"parent","requestId":"native","response":yes()})
    );
    runtime.reply(&wire, json!({"handled":true})).await;
    answer.await.unwrap().unwrap();
    assert!(runtime.broker.list("parent").is_empty());
    assert!(matches!(
        runtime.answer("parent", "native", yes()).await.unwrap(),
        Err(ServiceError::InteractionNotPending(_))
    ));
    assert!(runtime.incoming.try_recv().is_err());
}

#[tokio::test]
async fn identical_request_ids_in_different_parents_use_the_right_wire_session() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("same"));
    runtime
        .broker
        .observe_native_event("other", &requested("same"));
    let answer = runtime.answer("other", "same", yes());
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    assert_eq!(wire["params"]["sessionId"], "other");
    runtime.reply(&wire, json!({"handled":true})).await;
    answer.await.unwrap().unwrap();
    assert!(runtime.broker.list("other").is_empty());
    assert_eq!(runtime.broker.list("parent").len(), 1);
}

#[tokio::test]
async fn freeform_and_legacy_success_result_are_supported_without_reissuing_rpc() {
    let mut runtime = Runtime::new().await;
    let mut prompt = requested("native");
    prompt["data"]["allowFreeform"] = json!(true);
    runtime.broker.observe_native_event("parent", &prompt);
    let value = json!({"answer":"An alternative","wasFreeform":true});
    let answer = runtime.answer("parent", "native", value.clone());
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    assert_eq!(wire["params"]["response"], value);
    runtime.reply(&wire, json!({"success":true})).await;
    answer.await.unwrap().unwrap();
    assert!(runtime.incoming.try_recv().is_err());
}

#[tokio::test]
async fn both_arrival_orders_have_one_representation_and_only_callback_delivery() {
    for native_first in [true, false] {
        for use_native_id in [true, false] {
            let mut runtime = Runtime::new().await;
            if native_first {
                runtime
                    .broker
                    .observe_native_event("parent", &requested("native"));
            }
            let (callback_id, callback_result) = callback(&runtime.broker).await;
            if !native_first {
                runtime
                    .broker
                    .observe_native_event("parent", &requested("native"));
            }
            let listed = runtime.broker.list("parent");
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].request_id, "native");
            let id = if use_native_id {
                "native"
            } else {
                &callback_id
            };
            runtime.answer("parent", id, yes()).await.unwrap().unwrap();
            let result = callback_result.await.unwrap().unwrap();
            assert_eq!(result.answer, "Yes");
            assert!(!result.was_freeform);
            assert!(runtime.broker.list("parent").is_empty());
            assert!(
                runtime.incoming.try_recv().is_err(),
                "handler-owned requests must never use raw RPC"
            );
        }
    }
}

#[tokio::test]
async fn completed_notification_closes_native_ui_and_its_callback_only() {
    let runtime = Runtime::new().await;
    let (_, callback_result) = callback(&runtime.broker).await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let mut unrelated = requested("unrelated");
    unrelated["data"]["question"] = json!("A different question?");
    runtime.broker.observe_native_event("parent", &unrelated);
    runtime
        .broker
        .observe_native_event("other-parent", &requested("native"));
    let mut events = runtime.broker.events.subscribe(None);
    runtime
        .broker
        .observe_native_event("parent", &completed("native"));
    assert!(callback_result.await.unwrap().is_none());
    assert_eq!(runtime.broker.list("parent")[0].request_id, "unrelated");
    assert_eq!(runtime.broker.list("other-parent")[0].request_id, "native");
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    assert_eq!(
        runtime.broker.list("parent").len(),
        1,
        "duplicate events cannot resurrect completion"
    );
    let resolved = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let AppEvent::InteractionResolved {
                session_id,
                request_id,
            } = events.recv().await.unwrap().event
                && session_id == "parent"
                && request_id == "native"
            {
                break;
            }
        }
    })
    .await;
    assert!(resolved.is_ok());
}

#[tokio::test]
async fn invalid_answers_and_raw_no_response_do_not_consume_prompts() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    for value in [
        json!({"answer":"No such choice","wasFreeform":false}),
        json!({"answer":"custom","wasFreeform":true}),
        json!({"answer":"Yes","wasFreeform":"false"}),
        json!({"answer":null,"wasFreeform":false}),
        json!({"answer":"Yes"}),
        json!({"answer":"Yes","wasFreeform":false,"extra":1}),
        json!({"noResponse":true}),
        json!({"noResponse":true,"answer":"Yes","wasFreeform":false}),
        json!(null),
    ] {
        assert!(matches!(
            runtime.answer("parent", "native", value).await.unwrap(),
            Err(ServiceError::InvalidArgument(_))
        ));
        assert_eq!(runtime.broker.list("parent").len(), 1);
        assert!(runtime.incoming.try_recv().is_err());
    }
    assert!(
        runtime
            .broker
            .prepare_response(
                InteractionResponse {
                    kind: InteractionKind::Elicitation,
                    ..response("parent", "native", yes())
                },
                true
            )
            .is_err()
    );
    assert!(
        runtime
            .answer("wrong-parent", "native", yes())
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(runtime.broker.list("parent").len(), 1);
    let answer = runtime.answer("parent", "native", yes());
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    runtime.reply(&wire, json!({"handled":true})).await;
    answer.await.unwrap().unwrap();
}

#[tokio::test]
async fn ambiguous_callbacks_are_not_guessed_or_sent_raw() {
    let mut runtime = Runtime::new().await;
    let (first, first_result) = callback(&runtime.broker).await;
    let (_, second_result) = callback(&runtime.broker).await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    for id in ["native", first.as_str()] {
        let error = runtime
            .answer("parent", id, yes())
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("ambiguous"));
    }
    assert!(runtime.incoming.try_recv().is_err());
    assert_eq!(runtime.broker.list("parent").len(), 3);
    runtime.broker.clear();
    assert!(first_result.await.unwrap().is_none());
    assert!(second_result.await.unwrap().is_none());
}

#[tokio::test]
async fn ambiguous_native_duplicates_do_not_steal_one_callback() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("first"));
    runtime
        .broker
        .observe_native_event("parent", &requested("second"));
    let (callback_id, task) = callback(&runtime.broker).await;
    for id in ["first", "second", &callback_id] {
        assert!(
            runtime
                .answer("parent", id, yes())
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("ambiguous")
        );
    }
    assert!(runtime.incoming.try_recv().is_err());
    runtime.broker.clear();
    assert!(task.await.unwrap().is_none());
}

#[tokio::test]
async fn later_ambiguity_blocks_previously_matched_native_request() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let (_, first) = callback(&runtime.broker).await;
    assert_eq!(runtime.broker.list("parent").len(), 1);
    let (_, second) = callback(&runtime.broker).await;
    assert!(
        runtime
            .answer("parent", "native", yes())
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("ambiguous")
    );
    assert!(runtime.incoming.try_recv().is_err());
    runtime.broker.clear();
    assert!(first.await.unwrap().is_none());
    assert!(second.await.unwrap().is_none());
}

#[tokio::test]
async fn callback_equivalence_requires_choices_and_freeform_not_just_question() {
    for field in ["choices", "allowFreeform"] {
        let mut runtime = Runtime::new().await;
        let (id, task) = callback(&runtime.broker).await;
        let mut prompt = requested("native");
        prompt["data"][field] = if field == "choices" {
            json!(["Yes", "Maybe"])
        } else {
            json!(true)
        };
        runtime.broker.observe_native_event("parent", &prompt);
        assert_eq!(runtime.broker.list("parent").len(), 2);
        runtime.answer("parent", &id, yes()).await.unwrap().unwrap();
        assert_eq!(task.await.unwrap().unwrap().answer, "Yes");
        assert_eq!(runtime.broker.list("parent").len(), 1);
        assert!(runtime.incoming.try_recv().is_err());
    }
}

#[tokio::test]
async fn callback_disappearing_never_falls_back_to_raw_native_delivery() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let (_, task) = callback(&runtime.broker).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(runtime.broker.list("parent").is_empty());
    assert!(matches!(
        runtime.answer("parent", "native", yes()).await.unwrap(),
        Err(ServiceError::InteractionNotPending(_))
    ));
    assert!(runtime.incoming.try_recv().is_err());
}

#[tokio::test]
async fn sdk_disconnect_clears_owned_callbacks_not_external_native_prompts() {
    let runtime = Runtime::new().await;
    let (_, task) = callback(&runtime.broker).await;
    runtime
        .broker
        .observe_native_event("parent", &requested("owned"));
    let mut external = requested("external");
    external["data"]["question"] = json!("Another question?");
    runtime.broker.observe_native_event("parent", &external);
    runtime.broker.clear_callbacks("parent");
    assert!(task.await.unwrap().is_none());
    let listed = runtime.broker.list("parent");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].request_id, "external");
    assert!(matches!(
        runtime.answer("parent", "owned", yes()).await.unwrap(),
        Err(ServiceError::InteractionNotPending(_))
    ));
}

#[tokio::test]
async fn handler_owned_cross_client_race_delivers_only_one_answer() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let (callback_id, task) = callback(&runtime.broker).await;
    let first = runtime.answer("parent", "native", yes());
    let second = runtime.answer("parent", &callback_id, yes());
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(task.await.unwrap().unwrap().answer, "Yes");
    assert!(runtime.incoming.try_recv().is_err());
}

#[tokio::test]
async fn handled_false_is_explicit_stale_and_dismisses_ui() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let answer = runtime.answer("parent", "native", yes());
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    runtime.reply(&wire, json!({"handled":false})).await;
    assert!(matches!(
        answer.await.unwrap(),
        Err(ServiceError::InteractionNotPending(_))
    ));
    assert!(runtime.broker.list("parent").is_empty());
}

#[tokio::test]
async fn failed_delivery_restores_pending_unless_live_completion_won() {
    for complete in [false, true] {
        let mut runtime = Runtime::new().await;
        runtime
            .broker
            .observe_native_event("parent", &requested("native"));
        let answer = runtime.answer("parent", "native", yes());
        let wire = runtime.next("session.ui.handlePendingUserInput").await;
        runtime.broker.clear_callbacks("parent");
        if complete {
            runtime
                .broker
                .observe_native_event("parent", &completed("native"));
        }
        write(
            &runtime.writer,
            json!({"jsonrpc":"2.0","id":wire["id"],
            "error":{"code":-32000,"message":"transport unavailable"}}),
        )
        .await;
        assert!(answer.await.unwrap().is_err());
        assert_eq!(runtime.broker.list("parent").len(), usize::from(!complete));
        if !complete {
            let retry = runtime.answer("parent", "native", yes());
            let wire = runtime.next("session.ui.handlePendingUserInput").await;
            runtime.reply(&wire, json!({"handled":true})).await;
            retry.await.unwrap().unwrap();
        }
    }
}

#[tokio::test]
async fn cancellation_restores_claim_and_cross_client_race_sends_exactly_once() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let cancelled = runtime.answer("parent", "native", yes());
    let old_wire = runtime.next("session.ui.handlePendingUserInput").await;
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    runtime.reply(&old_wire, json!({"handled":false})).await;
    let first = runtime.answer("parent", "native", yes());
    let second = runtime.answer("parent", "native", yes());
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    runtime.reply(&wire, json!({"handled":true})).await;
    let results = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(ServiceError::InteractionNotPending(_))))
            .count(),
        1
    );
    assert!(runtime.incoming.try_recv().is_err());
}

#[tokio::test]
async fn callback_arriving_after_raw_dispatch_is_deduplicated_and_not_answered_twice() {
    let mut runtime = Runtime::new().await;
    runtime
        .broker
        .observe_native_event("parent", &requested("native"));
    let answer = runtime.answer("parent", "native", yes());
    let wire = runtime.next("session.ui.handlePendingUserInput").await;
    let (callback_id, task) = callback(&runtime.broker).await;
    assert_eq!(runtime.broker.list("parent").len(), 1);
    assert!(matches!(
        runtime.answer("parent", &callback_id, yes()).await.unwrap(),
        Err(ServiceError::InteractionNotPending(_))
    ));
    runtime.reply(&wire, json!({"handled":true})).await;
    answer.await.unwrap().unwrap();
    assert!(task.await.unwrap().is_none());
    assert!(runtime.broker.list("parent").is_empty());
    assert!(runtime.incoming.try_recv().is_err());
}

#[tokio::test]
async fn recovery_is_ephemeral_forward_filtered_and_never_displays_completed_pages() {
    let mut runtime = Runtime::new().await;
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    assert_eq!(wire["params"]["direction"], "forward");
    assert_eq!(wire["params"]["includeEphemeral"], true);
    assert_eq!(wire["params"]["types"], json!(RECOVERY_TYPES));
    assert_eq!(wire["params"]["max"], RECOVERY_PAGE_SIZE);
    runtime
        .reply(
            &wire,
            json!({"cursor":"page1","hasMore":true,"events":[requested("old")]}),
        )
        .await;
    let wire = runtime.next("session.eventLog.read").await;
    assert_eq!(wire["params"]["cursor"], "page1");
    assert!(runtime.broker.list("parent").is_empty());
    runtime
        .reply(
            &wire,
            json!({"cursor":"page2","hasMore":false,
        "events":[completed("old"),requested("pending")]}),
        )
        .await;
    recovery.await.unwrap().unwrap();
    assert_eq!(runtime.broker.list("parent")[0].request_id, "pending");
    runtime
        .broker
        .recover_native("parent", &runtime.client)
        .await
        .unwrap();
    assert!(
        runtime.incoming.try_recv().is_err(),
        "immediate reconnect must not reread history"
    );

    runtime.broker.with_pending(|_, native| {
        native.sessions.get_mut("parent").unwrap().refreshed = None;
    });
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    assert_eq!(
        wire["params"]["cursor"], "page2",
        "subsequent reads are incremental"
    );
    runtime
        .reply(
            &wire,
            json!({"cursor":"page3","hasMore":false,"events":[completed("pending")]}),
        )
        .await;
    recovery.await.unwrap().unwrap();
    assert!(runtime.broker.list("parent").is_empty());
}

#[tokio::test]
async fn old_recovery_cannot_resurrect_a_live_completion_or_overwrite_new_work() {
    let mut runtime = Runtime::new().await;
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    runtime
        .broker
        .observe_native_event("parent", &completed("old"));
    runtime
        .broker
        .observe_native_event("parent", &requested("new"));
    runtime
        .reply(
            &wire,
            json!({"cursor":"stale","hasMore":false,"events":[requested("old")]}),
        )
        .await;
    recovery.await.unwrap().unwrap();
    assert_eq!(runtime.broker.list("parent").len(), 1);
    assert_eq!(runtime.broker.list("parent")[0].request_id, "new");
}

#[tokio::test]
async fn unrelated_tool_traffic_and_duplicate_requests_do_not_starve_recovery() {
    let mut runtime = Runtime::new().await;
    runtime.broker.observe_native_event("parent", &requested("known"));
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    for _ in 0..5 {
        runtime.broker.observe_native_event("parent", &json!({
            "type":"tool.execution_complete", "data":{"toolCallId":"unrelated-tool"}
        }));
        runtime.broker.observe_native_event("parent", &requested("known"));
        runtime.broker.observe_native_event("parent", &json!({
            "type":"user_input.requested", "data":{"requestId":"malformed"}
        }));
    }
    runtime.reply(&wire, json!({
        "cursor":"caught-up", "hasMore":false, "events":[requested("recovered")]
    })).await;
    recovery.await.unwrap().unwrap();
    let ids = runtime.broker.list("parent").into_iter().map(|request| request.request_id).collect::<HashSet<_>>();
    assert_eq!(ids, HashSet::from(["known".into(), "recovered".into()]));
    runtime.broker.recover_native("parent", &runtime.client).await.unwrap();
    assert!(runtime.incoming.try_recv().is_err(), "successful recovery should retain its cursor and cooldown");
}

#[tokio::test]
async fn recovery_started_before_callback_answer_does_not_resurrect_native_ui() {
    let mut runtime = Runtime::new().await;
    let (id, task) = callback(&runtime.broker).await;
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    runtime.answer("parent", &id, yes()).await.unwrap().unwrap();
    assert!(task.await.unwrap().is_some());
    runtime
        .reply(
            &wire,
            json!({"cursor":"end","hasMore":false,"events":[requested("native")]}),
        )
        .await;
    recovery.await.unwrap().unwrap();
    assert!(runtime.broker.list("parent").is_empty());
}

#[tokio::test]
async fn recovery_folds_abort_and_tool_completions_before_exposing_pending() {
    let mut runtime = Runtime::new().await;
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    runtime.reply(&wire, json!({"cursor":"end","hasMore":false,"events":[
        requested("aborted"), {"type":"abort","data":{}},
        requested("finished"), {"type":"tool.execution_complete","data":{"toolCallId":"tool-finished"}},
        requested("pending")
    ]})).await;
    recovery.await.unwrap().unwrap();
    assert_eq!(runtime.broker.list("parent").len(), 1);
    assert_eq!(runtime.broker.list("parent")[0].request_id, "pending");
}

#[tokio::test]
async fn bounded_recovery_resumes_instead_of_restarting_large_histories() {
    let mut runtime = Runtime::new().await;
    let recovery = runtime.recover();
    for page in 0..RECOVERY_MAX_PAGES {
        let wire = runtime.next("session.eventLog.read").await;
        runtime
            .reply(
                &wire,
                json!({"cursor":format!("page-{page}"),"hasMore":true,
            "events":[requested(&format!("request-{page}"))]}),
            )
            .await;
    }
    assert!(matches!(
        recovery.await.unwrap(),
        Err(ServiceError::CapabilityUnavailable(_))
    ));
    assert!(runtime.broker.list("parent").is_empty());
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    assert_eq!(
        wire["params"]["cursor"],
        format!("page-{}", RECOVERY_MAX_PAGES - 1)
    );
    let events: Vec<_> = (0..RECOVERY_MAX_PAGES)
        .map(|page| completed(&format!("request-{page}")))
        .collect();
    runtime
        .reply(
            &wire,
            json!({"cursor":"end","hasMore":false,"events":events}),
        )
        .await;
    recovery.await.unwrap().unwrap();
    assert!(runtime.broker.list("parent").is_empty());
}

#[tokio::test]
async fn recovery_reconciles_callback_and_completion_cancels_it() {
    let mut runtime = Runtime::new().await;
    let (_, task) = callback(&runtime.broker).await;
    let recovery = runtime.recover();
    let wire = runtime.next("session.eventLog.read").await;
    runtime
        .reply(
            &wire,
            json!({"cursor":"end","hasMore":false,"events":[requested("native")]}),
        )
        .await;
    recovery.await.unwrap().unwrap();
    assert_eq!(runtime.broker.list("parent").len(), 1);
    assert_eq!(runtime.broker.list("parent")[0].request_id, "native");
    runtime
        .broker
        .observe_native_event("parent", &completed("native"));
    assert!(task.await.unwrap().is_none());
}

#[test]
fn only_requested_events_create_prompts_and_tool_completion_is_scoped() {
    let broker = InteractionBroker::new(EventBus::new());
    broker.observe_native_event("parent", &json!({"type":"tool.execution_start","data":{
        "toolCallId":"fake","toolName":"ask_user","arguments":{"question":"Continue?","requestId":"fake"}}}));
    assert!(broker.list("parent").is_empty());
    broker.observe_native_event("parent", &requested("one"));
    broker.observe_native_event("parent", &requested("two"));
    broker.observe_native_event(
        "parent",
        &json!({"type":"tool.execution_complete","data":{"toolCallId":"tool-one"}}),
    );
    assert_eq!(broker.list("parent")[0].request_id, "two");
    broker.observe_native_event("parent", &json!({"type":"abort","data":{}}));
    assert!(broker.list("parent").is_empty());
}
