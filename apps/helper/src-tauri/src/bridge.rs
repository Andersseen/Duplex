use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

use crate::{pairing::PairingBundle, protocol::BridgeMessage};

#[derive(Clone, Default)]
pub struct HelperBridge {
    cancel: Arc<Mutex<Option<mpsc::UnboundedSender<()>>>>,
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
            emit(&app, "connected", None);
            let mut active_session_id: Option<String> = None;
            let mut expires_at: Option<tokio::time::Instant> = None;
            loop {
                let expiry = expires_at.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(365 * 24 * 60 * 60));
                tokio::select! {
                    _ = cancel_rx.recv() => {
                        let _ = writer.send(Message::Close(None)).await;
                        break;
                    }
                    _ = tokio::time::sleep_until(expiry), if expires_at.is_some() => {
                        expires_at = None;
                        active_session_id = None;
                        emit(&app, "connected", None);
                    }
                    incoming = reader.next() => {
                        match incoming {
                            Some(Ok(Message::Text(text))) => {
                                let parsed = serde_json::from_str::<BridgeMessage>(text.as_str());
                                let Ok(message) = parsed else { continue };
                                if !message.is_valid() { continue; }
                                match message.kind.as_str() {
                                    "helper-session-authorized" => {
                                        let session = message.session.expect("validated session");
                                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                        if session.expires_at <= now { continue; }
                                        expires_at = Some(tokio::time::Instant::now() + Duration::from_millis(session.expires_at - now));
                                        active_session_id = Some(session.control_session_id.clone());
                                        emit(&app, "authorized", Some(serde_json::to_value(session).unwrap_or_default()));
                                    }
                                    "helper-session-revoked" if active_session_id.as_deref() == message.control_session_id.as_deref() => {
                                        active_session_id = None;
                                        expires_at = None;
                                        emit(&app, "connected", None);
                                    }
                                    _ => {}
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
    if let Ok(mut slot) = bridge.cancel.lock() {
        if let Some(cancel) = slot.take() {
            let _ = cancel.send(());
        }
    }
    emit(&app, "not-connected", None);
}

fn emit(app: &AppHandle, status: &str, details: Option<serde_json::Value>) {
    let payload = json!({"status": status, "details": details});
    let _ = app.emit("helper-state", payload);
}
