use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

use crate::input::{
    now_ms, DisplayInfo, EndCause, NativeEvent, NativeInput, NativeStatus, SessionGrant,
};
use crate::{
    pairing::PairingBundle,
    protocol::{BridgeMessage, MAX_BRIDGE_MESSAGE_BYTES},
};

/// Permission and display changes are cheap to re-check, but there is no reason to poll quickly.
const NATIVE_RECHECK_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct HelperBridge {
    cancel: Arc<Mutex<Option<mpsc::UnboundedSender<()>>>>,
    native: NativeInput,
}

impl HelperBridge {
    pub fn new(native: NativeInput) -> Self {
        Self {
            cancel: Arc::default(),
            native,
        }
    }
}

impl Drop for HelperBridge {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.cancel.lock() {
            if let Some(cancel) = slot.take() {
                let _ = cancel.send(());
            }
        }
    }
}

#[tauri::command]
pub async fn connect_helper(
    app: AppHandle,
    bridge: State<'_, HelperBridge>,
    pairing_code: String,
) -> Result<(), String> {
    let bundle = PairingBundle::parse(&pairing_code).map_err(str::to_owned)?;
    let (cancel, mut cancel_rx) = mpsc::unbounded_channel();
    {
        let mut slot = bridge
            .cancel
            .lock()
            .map_err(|_| "Helper state unavailable.".to_owned())?;
        if slot.is_some() {
            return Err("Disconnect the current helper session first.".to_owned());
        }
        *slot = Some(cancel);
    }
    emit(&app, "connecting", None);
    let bridge_state = bridge.inner().clone();
    let native = bridge.native.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let url = bundle.websocket_url().map_err(str::to_owned)?;
            let mut request = url.as_str().into_client_request().map_err(|_| "Invalid pairing code.".to_owned())?;
            let authorization = format!("Bearer {}", bundle.token);
            let header = HeaderValue::from_str(&authorization).map_err(|_| "Invalid pairing code.".to_owned())?;
            request.headers_mut().insert("Authorization", header);
            let (socket, _) = connect_async(request).await.map_err(|_| "Could not connect to Duplex. Check the pairing code and network.".to_owned())?;
            let (mut writer, mut reader) = socket.split();
            writer.send(Message::Text(r#"{"type":"helper-ready"}"#.into())).await.map_err(|_| "Could not initialize the helper connection.".to_owned())?;

            // Native state changes reach this loop as events; the native layer never calls back inline.
            let (native_tx, mut native_rx) = mpsc::unbounded_channel::<NativeEvent>();
            native.set_listener(Some(Arc::new(move |event| {
                let _ = native_tx.send(event);
            })));
            let mut announced: Option<Vec<&'static str>> = None;
            announce_capabilities(&native, &mut writer, &mut announced).await;
            emit(&app, "connected", None);
            emit_native(&app, &native.status(now_ms()));

            let mut active_session_id: Option<String> = None;
            let mut expires_at: Option<tokio::time::Instant> = None;
            let mut recheck = tokio::time::interval(NATIVE_RECHECK_INTERVAL);
            recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                let expiry = expires_at.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(365 * 24 * 60 * 60));
                tokio::select! {
                    _ = cancel_rx.recv() => {
                        let _ = writer.send(Message::Close(None)).await;
                        break;
                    }
                    _ = tokio::time::sleep_until(expiry), if expires_at.is_some() => {
                        expires_at = None;
                        // The helper's own clock is authoritative: stop input now, converge with the browser after.
                        native.end_session(EndCause::Expired);
                    }
                    _ = recheck.tick() => {
                        native.refresh(now_ms());
                    }
                    Some(event) = native_rx.recv() => {
                        match event {
                            NativeEvent::StatusChanged => {
                                emit_native(&app, &native.status(now_ms()));
                                announce_capabilities(&native, &mut writer, &mut announced).await;
                            }
                            NativeEvent::SessionEnded { control_session_id, cause } => {
                                if active_session_id.as_deref() == Some(control_session_id.as_str()) {
                                    active_session_id = None;
                                    expires_at = None;
                                    emit(&app, "connected", None);
                                }
                                if cause.needs_browser_revoke() {
                                    // The browser owns the P2P control protocol; ask it to revoke rather than faking a message.
                                    let stop = json!({"type": "helper-stop-control", "controlSessionId": control_session_id});
                                    let _ = writer.send(Message::Text(stop.to_string().into())).await;
                                }
                            }
                        }
                    }
                    incoming = reader.next() => {
                        match incoming {
                            Some(Ok(Message::Text(text))) => {
                                let now = now_ms();
                                let Some(message) = BridgeMessage::parse(text.as_str()) else { continue };
                                if !message.is_valid(now) { continue; }
                                match message {
                                    BridgeMessage::SessionAuthorized { session } => {
                                        expires_at = Some(tokio::time::Instant::now() + Duration::from_millis(session.expires_at - now));
                                        active_session_id = Some(session.control_session_id.clone());
                                        native.begin_session(
                                            SessionGrant {
                                                control_session_id: session.control_session_id.clone(),
                                                surface_id: session.surface_id.clone(),
                                                pointer: session.scopes.iter().any(|scope| scope == "pointer"),
                                                expires_at_ms: session.expires_at,
                                            },
                                            now,
                                        );
                                        emit(&app, "authorized", Some(serde_json::to_value(session).unwrap_or_default()));
                                    }
                                    BridgeMessage::SessionRevoked { control_session_id, .. } => {
                                        native.end_matching_session(&control_session_id, EndCause::Revoked);
                                    }
                                    // Straight to the native layer; never through the UI.
                                    BridgeMessage::Input { input } => {
                                        let _ = native.submit(&input, now);
                                    }
                                }
                            }
                            Some(Ok(Message::Ping(payload))) => { let _ = writer.send(Message::Pong(payload)).await; }
                            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                            _ => {}
                        }
                    }
                }
            }
            Ok::<(), String>(())
        }.await;
        // Whatever ended the connection, input stops and any held button is released.
        native.set_listener(None);
        native.end_session(EndCause::Disconnected);
        if result.is_err() {
            emit(
                &app,
                "error",
                Some(
                    json!({"message":"Could not connect to Duplex. Check the pairing code and network."}),
                ),
            );
        } else {
            emit(&app, "not-connected", None);
        }
        if let Ok(mut slot) = bridge_state.cancel.lock() {
            slot.take();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn disconnect_helper(app: AppHandle, bridge: State<'_, HelperBridge>) {
    bridge.native.end_session(EndCause::Disconnected);
    if let Ok(mut slot) = bridge.cancel.lock() {
        if let Some(cancel) = slot.take() {
            let _ = cancel.send(());
        }
    }
    emit(&app, "not-connected", None);
}

#[tauri::command]
pub fn get_native_input_status(bridge: State<'_, HelperBridge>) -> NativeStatus {
    bridge.native.status(now_ms())
}

#[tauri::command]
pub fn list_displays(bridge: State<'_, HelperBridge>) -> Vec<DisplayInfo> {
    bridge.native.status(now_ms()).displays
}

#[tauri::command]
pub fn select_display(
    bridge: State<'_, HelperBridge>,
    display_id: u32,
) -> Result<NativeStatus, String> {
    bridge
        .native
        .select_display(display_id, now_ms())
        .map_err(str::to_owned)
}

/// The only code path that prompts for Accessibility access; it runs from an explicit button.
#[tauri::command]
pub fn request_accessibility(bridge: State<'_, HelperBridge>) -> NativeStatus {
    bridge.native.request_accessibility(now_ms())
}

#[tauri::command]
pub fn refresh_accessibility_status(bridge: State<'_, HelperBridge>) -> NativeStatus {
    bridge.native.status(now_ms())
}

/// Local emergency stop: disable input, release buttons, and ask the owner browser to revoke.
#[tauri::command]
pub fn stop_control(bridge: State<'_, HelperBridge>) -> NativeStatus {
    bridge.native.stop_control();
    bridge.native.status(now_ms())
}

/// Tell the room which scopes this helper can execute right now, but only when that changed.
async fn announce_capabilities<W>(
    native: &NativeInput,
    writer: &mut W,
    announced: &mut Option<Vec<&'static str>>,
) where
    W: SinkExt<Message> + Unpin,
{
    let scopes = native.available_scopes(now_ms());
    if announced.as_ref() == Some(&scopes) {
        return;
    }
    let message = json!({"type": "helper-capabilities", "availableScopes": scopes});
    if message.to_string().len() <= MAX_BRIDGE_MESSAGE_BYTES
        && writer
            .send(Message::Text(message.to_string().into()))
            .await
            .is_ok()
    {
        *announced = Some(scopes);
    }
}

fn emit(app: &AppHandle, status: &str, details: Option<serde_json::Value>) {
    let payload = json!({"status": status, "details": details});
    let _ = app.emit("helper-state", payload);
}

fn emit_native(app: &AppHandle, status: &NativeStatus) {
    let _ = app.emit("native-state", status);
}
