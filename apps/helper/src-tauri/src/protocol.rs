use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::input::geometry::{ButtonState, PointerButton};
use crate::input::{MAX_SCROLL_DELTA, MAX_SEQUENCE};

pub const INPUT_PROTOCOL_VERSION: u8 = 1;
/// Upper bound on any text frame accepted from the room.
pub const MAX_BRIDGE_MESSAGE_BYTES: usize = 4096;
/// Largest clipboard text, in UTF-8 bytes. Mirrors `MAX_CLIPBOARD_TEXT_BYTES` in the shared protocol.
pub const MAX_CLIPBOARD_TEXT_BYTES: usize = 4096;
/// Only clipboard frames may exceed [`MAX_BRIDGE_MESSAGE_BYTES`], up to this bound.
pub const MAX_CLIPBOARD_BRIDGE_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMetadata {
    #[serde(rename = "controlSessionId")]
    pub control_session_id: String,
    #[serde(rename = "surfaceId")]
    pub surface_id: String,
    pub scopes: Vec<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RevokeReason {
    User,
    Expired,
    Disconnected,
    SurfaceEnded,
    HelperDisconnected,
    Superseded,
    CapabilityLost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireButton {
    Left,
    Right,
}

impl From<WireButton> for PointerButton {
    fn from(button: WireButton) -> Self {
        match button {
            WireButton::Left => PointerButton::Left,
            WireButton::Right => PointerButton::Right,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireState {
    Down,
    Up,
}

impl From<WireState> for ButtonState {
    fn from(state: WireState) -> Self {
        match state {
            WireState::Down => ButtonState::Down,
            WireState::Up => ButtonState::Up,
        }
    }
}

/// Input relayed by the room. There is deliberately no generic payload.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum InputEvent {
    #[serde(rename = "input-pointer-move")]
    PointerMove {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "controlSessionId")]
        control_session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        sequence: u64,
        x: f64,
        y: f64,
    },
    #[serde(rename = "input-pointer-button")]
    PointerButton {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "controlSessionId")]
        control_session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        sequence: u64,
        button: WireButton,
        state: WireState,
        x: f64,
        y: f64,
    },
    #[serde(rename = "input-scroll")]
    Scroll {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "controlSessionId")]
        control_session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        sequence: u64,
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
    #[serde(rename = "input-keyboard")]
    Keyboard {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "controlSessionId")]
        control_session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        sequence: u64,
        code: String,
        state: WireState,
    },
}

impl InputEvent {
    pub fn control_session_id(&self) -> &str {
        match self {
            Self::PointerMove {
                control_session_id, ..
            }
            | Self::PointerButton {
                control_session_id, ..
            }
            | Self::Scroll {
                control_session_id, ..
            }
            | Self::Keyboard {
                control_session_id, ..
            } => control_session_id,
        }
    }

    pub fn surface_id(&self) -> &str {
        match self {
            Self::PointerMove { surface_id, .. }
            | Self::PointerButton { surface_id, .. }
            | Self::Scroll { surface_id, .. } => surface_id,
            Self::Keyboard { surface_id, .. } => surface_id,
        }
    }

    pub fn sequence(&self) -> u64 {
        match self {
            Self::PointerMove { sequence, .. }
            | Self::PointerButton { sequence, .. }
            | Self::Scroll { sequence, .. } => *sequence,
            Self::Keyboard { sequence, .. } => *sequence,
        }
    }

    pub fn is_valid(&self) -> bool {
        let (version, session, surface) = match self {
            Self::PointerMove {
                protocol_version,
                control_session_id,
                surface_id,
                ..
            }
            | Self::PointerButton {
                protocol_version,
                control_session_id,
                surface_id,
                ..
            }
            | Self::Scroll {
                protocol_version,
                control_session_id,
                surface_id,
                ..
            }
            | Self::Keyboard {
                protocol_version,
                control_session_id,
                surface_id,
                ..
            } => (*protocol_version, control_session_id, surface_id),
        };
        if version != INPUT_PROTOCOL_VERSION
            || !valid_uuid(session)
            || !valid_uuid(surface)
            || self.sequence() > MAX_SEQUENCE
        {
            return false;
        }
        match self {
            Self::PointerMove { x, y, .. } | Self::PointerButton { x, y, .. } => {
                unit_interval(*x) && unit_interval(*y)
            }
            Self::Scroll {
                delta_x, delta_y, ..
            } => scroll_delta(*delta_x) && scroll_delta(*delta_y),
            Self::Keyboard { code, .. } => supported_key_code(code),
        }
    }
}

pub fn supported_key_code(code: &str) -> bool {
    matches!(
        code,
        "Space"
            | "Enter"
            | "Backspace"
            | "Delete"
            | "Tab"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Home"
            | "End"
            | "Comma"
            | "Period"
            | "Slash"
            | "Semicolon"
            | "Quote"
            | "BracketLeft"
            | "BracketRight"
            | "Backslash"
            | "Minus"
            | "Equal"
            | "Backquote"
            | "ShiftLeft"
            | "ShiftRight"
            | "ControlLeft"
            | "ControlRight"
            | "AltLeft"
            | "AltRight"
            | "MetaLeft"
            | "MetaRight"
    ) || (code
        .strip_prefix("Key")
        .is_some_and(|s| s.len() == 1 && s.as_bytes()[0].is_ascii_uppercase()))
        || (code
            .strip_prefix("Digit")
            .is_some_and(|s| s.len() == 1 && s.as_bytes()[0].is_ascii_digit()))
}

fn unit_interval(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn scroll_delta(value: f64) -> bool {
    value.is_finite() && value.abs() <= MAX_SCROLL_DELTA
}

/// Messages the room sends to the helper.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum BridgeMessage {
    #[serde(rename = "helper-session-authorized")]
    SessionAuthorized { session: SessionMetadata },
    #[serde(rename = "helper-session-revoked")]
    SessionRevoked {
        #[serde(rename = "controlSessionId")]
        control_session_id: String,
        #[allow(dead_code)]
        reason: RevokeReason,
    },
    #[serde(rename = "helper-input")]
    Input { input: InputEvent },
    #[serde(rename = "helper-clipboard-write")]
    ClipboardWrite {
        #[serde(rename = "controlSessionId")]
        control_session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
        text: String,
    },
    #[serde(rename = "helper-clipboard-read")]
    ClipboardRead {
        #[serde(rename = "controlSessionId")]
        control_session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        #[serde(rename = "transferId")]
        transfer_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardOp {
    Write(String),
    Read,
}

/// One explicit clipboard operation relayed by the room. There is no generic payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardRequest {
    pub control_session_id: String,
    pub surface_id: String,
    pub transfer_id: String,
    pub op: ClipboardOp,
}

impl ClipboardRequest {
    pub fn is_valid(&self) -> bool {
        valid_uuid(&self.control_session_id)
            && valid_uuid(&self.surface_id)
            && valid_uuid(&self.transfer_id)
            && match &self.op {
                ClipboardOp::Write(text) => acceptable_clipboard_text(text),
                ClipboardOp::Read => true,
            }
    }
}

/// Non-empty, within the byte bound, and free of control characters other than tab, CR and LF.
/// Mirrors `isAcceptableClipboardText` in the shared protocol.
pub fn acceptable_clipboard_text(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_CLIPBOARD_TEXT_BYTES
        && !text
            .chars()
            .any(|c| (c < ' ' && !matches!(c, '\t' | '\n' | '\r')) || c == '\u{7f}')
}

impl BridgeMessage {
    pub fn parse(text: &str) -> Option<Self> {
        if text.len() > MAX_CLIPBOARD_BRIDGE_BYTES {
            return None;
        }
        let message = serde_json::from_str::<Self>(text).ok()?;
        // Only clipboard frames may be larger than an ordinary control-plane frame.
        (text.len() <= MAX_BRIDGE_MESSAGE_BYTES || message.clipboard_request().is_some())
            .then_some(message)
    }

    /// The clipboard operation this message asks for, if it is one.
    pub fn clipboard_request(&self) -> Option<ClipboardRequest> {
        match self {
            Self::ClipboardWrite {
                control_session_id,
                surface_id,
                transfer_id,
                text,
            } => Some(ClipboardRequest {
                control_session_id: control_session_id.clone(),
                surface_id: surface_id.clone(),
                transfer_id: transfer_id.clone(),
                op: ClipboardOp::Write(text.clone()),
            }),
            Self::ClipboardRead {
                control_session_id,
                surface_id,
                transfer_id,
            } => Some(ClipboardRequest {
                control_session_id: control_session_id.clone(),
                surface_id: surface_id.clone(),
                transfer_id: transfer_id.clone(),
                op: ClipboardOp::Read,
            }),
            _ => None,
        }
    }

    /// Structural validation that serde alone cannot express. `now_ms` is the wall clock.
    pub fn is_valid(&self, now_ms: u64) -> bool {
        match self {
            Self::SessionAuthorized { session } => {
                valid_uuid(&session.control_session_id)
                    && valid_uuid(&session.surface_id)
                    && !session.scopes.is_empty()
                    && session.scopes.len() <= 3
                    && session.scopes.iter().collect::<HashSet<_>>().len() == session.scopes.len()
                    && session
                        .scopes
                        .iter()
                        .all(|scope| matches!(scope.as_str(), "pointer" | "keyboard" | "clipboard"))
                    && session.expires_at > now_ms
                    && session.expires_at <= now_ms + 10 * 60 * 1000
            }
            Self::SessionRevoked {
                control_session_id, ..
            } => valid_uuid(control_session_id),
            Self::Input { input } => input.is_valid(),
            Self::ClipboardWrite { .. } | Self::ClipboardRead { .. } => self
                .clipboard_request()
                .is_some_and(|request| request.is_valid()),
        }
    }
}

pub fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const SESSION: &str = "123e4567-e89b-12d3-a456-426614174000";
    const SURFACE: &str = "123e4567-e89b-12d3-a456-426614174001";
    const NOW: u64 = 1_800_000_000_000;

    fn parse(value: Value) -> Option<BridgeMessage> {
        BridgeMessage::parse(&value.to_string())
    }

    fn input(extra: Value) -> Value {
        let mut base = json!({
            "protocolVersion": 1,
            "controlSessionId": SESSION,
            "surfaceId": SURFACE,
            "sequence": 1,
        });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    fn valid_input(value: Value) -> bool {
        parse(json!({"type": "helper-input", "input": value}))
            .is_some_and(|message| message.is_valid(NOW))
    }

    #[test]
    fn accepts_scoped_authorization_and_matching_revocation_shapes() {
        let authorization = parse(json!({
            "type": "helper-session-authorized",
            "session": {
                "controlSessionId": SESSION,
                "surfaceId": SURFACE,
                "scopes": ["pointer", "keyboard"],
                "expiresAt": NOW + 60_000
            }
        }))
        .unwrap();
        assert!(authorization.is_valid(NOW));
        let revocation = parse(json!({
            "type": "helper-session-revoked",
            "controlSessionId": SESSION,
            "reason": "user"
        }))
        .unwrap();
        assert!(revocation.is_valid(NOW));
        for reason in ["capability-lost", "helper-disconnected", "superseded"] {
            assert!(parse(json!({
                "type": "helper-session-revoked",
                "controlSessionId": SESSION,
                "reason": reason
            }))
            .is_some());
        }
    }

    #[test]
    fn rejects_unknown_fields_duplicate_scopes_and_unbounded_expiry() {
        assert!(parse(json!({"type": "helper-ready", "token": "secret"})).is_none());
        assert!(parse(json!({
            "type": "helper-session-revoked",
            "controlSessionId": SESSION,
            "reason": "user",
            "token": "secret"
        }))
        .is_none());
        let session = |scopes: Value, expires_at: u64| {
            parse(json!({
                "type": "helper-session-authorized",
                "session": {
                    "controlSessionId": SESSION,
                    "surfaceId": SURFACE,
                    "scopes": scopes,
                    "expiresAt": expires_at
                }
            }))
            .unwrap()
        };
        assert!(!session(json!(["pointer", "pointer"]), NOW + 60_000).is_valid(NOW));
        assert!(!session(json!(["pointer"]), NOW + 11 * 60 * 1000).is_valid(NOW));
        assert!(!session(json!(["pointer"]), NOW - 1).is_valid(NOW));
        assert!(!session(json!(["screen"]), NOW + 1_000).is_valid(NOW));
        assert!(session(json!(["clipboard"]), NOW + 1_000).is_valid(NOW));
        assert!(!session(
            json!(["pointer", "keyboard", "clipboard", "clipboard"]),
            NOW + 1_000
        )
        .is_valid(NOW));
        assert!(!session(json!([]), NOW + 1_000).is_valid(NOW));
    }

    #[test]
    fn accepts_pointer_and_keyboard_inputs() {
        assert!(valid_input(input(
            json!({"type": "input-pointer-move", "x": 0.0, "y": 1.0})
        )));
        for button in ["left", "right"] {
            for state in ["down", "up"] {
                assert!(valid_input(input(json!({
                    "type": "input-pointer-button", "button": button, "state": state,
                    "x": 0.5, "y": 0.5
                }))));
            }
        }
        assert!(valid_input(input(
            json!({"type": "input-scroll", "deltaX": -5.5, "deltaY": 2000.0})
        )));
        assert!(valid_input(input(
            json!({"type": "input-keyboard", "code": "KeyA", "state": "down"})
        )));
        assert!(valid_input(input(
            json!({"type": "input-keyboard", "code": "ArrowLeft", "state": "up"})
        )));
    }

    #[test]
    fn rejects_out_of_range_invalid_and_unknown_input() {
        let mv = |x: f64, y: f64| input(json!({"type": "input-pointer-move", "x": x, "y": y}));
        assert!(!valid_input(mv(-0.001, 0.5)));
        assert!(!valid_input(mv(0.5, 1.001)));
        assert!(!valid_input(input(
            json!({"type": "input-scroll", "deltaX": 0.0, "deltaY": 2000.5})
        )));
        assert!(!valid_input(input(json!({
            "type": "input-pointer-button", "button": "middle", "state": "down", "x": 0.5, "y": 0.5
        }))));
        assert!(!valid_input(input(json!({
            "type": "input-pointer-button", "button": "left", "state": "click", "x": 0.5, "y": 0.5
        }))));
        assert!(!valid_input(input(json!({
            "type": "input-keyboard", "code": "KeyNotSupported", "state": "down"
        }))));
        let mut wrong_version = mv(0.5, 0.5);
        wrong_version["protocolVersion"] = json!(2);
        assert!(!valid_input(wrong_version));
        let mut bad_session = mv(0.5, 0.5);
        bad_session["controlSessionId"] = json!("not-a-uuid");
        assert!(!valid_input(bad_session));
        let mut huge_sequence = mv(0.5, 0.5);
        huge_sequence["sequence"] = json!(MAX_SEQUENCE + 1);
        assert!(!valid_input(huge_sequence));
        let mut extra = mv(0.5, 0.5);
        extra["key"] = json!("a");
        assert!(!valid_input(extra));
        // Unknown keyboard shapes and generic payloads are still rejected.
        for payload in [
            input(json!({"type": "input-key", "key": "a"})),
            input(json!({"type": "input-keyboard", "code": "KeyA"})),
            input(json!({"type": "input-pointer-move", "x": 0.5, "y": 0.5, "payload": {}})),
        ] {
            assert!(parse(json!({"type": "helper-input", "input": payload})).is_none());
        }
        assert!(parse(json!({"type": "helper-input", "input": {}})).is_none());
    }

    #[test]
    fn rejects_oversized_frames() {
        let padded = format!(
            "{}{}",
            json!({"type": "helper-input", "input": input(json!({"type": "input-scroll", "deltaX": 0.0, "deltaY": 1.0}))}),
            " ".repeat(MAX_BRIDGE_MESSAGE_BYTES)
        );
        assert!(BridgeMessage::parse(&padded).is_none());
    }

    const TRANSFER: &str = "123e4567-e89b-12d3-a456-4266141740aa";

    fn clipboard_write(text: &str) -> Value {
        json!({
            "type": "helper-clipboard-write",
            "controlSessionId": SESSION,
            "surfaceId": SURFACE,
            "transferId": TRANSFER,
            "text": text
        })
    }

    #[test]
    fn accepts_clipboard_write_and_read_shapes() {
        let write = parse(clipboard_write("hello\nworld\t!")).unwrap();
        assert!(write.is_valid(NOW));
        let request = write.clipboard_request().unwrap();
        assert_eq!(request.op, ClipboardOp::Write("hello\nworld\t!".into()));
        let read = parse(json!({
            "type": "helper-clipboard-read",
            "controlSessionId": SESSION,
            "surfaceId": SURFACE,
            "transferId": TRANSFER
        }))
        .unwrap();
        assert!(read.is_valid(NOW));
        assert_eq!(read.clipboard_request().unwrap().op, ClipboardOp::Read);
        let session_revoked = parse(json!({
            "type": "helper-session-revoked",
            "controlSessionId": SESSION,
            "reason": "user"
        }))
        .unwrap();
        assert!(session_revoked.clipboard_request().is_none());
    }

    #[test]
    fn rejects_malformed_oversized_and_control_character_clipboard_messages() {
        let mut extra = clipboard_write("x");
        extra["extra"] = json!(true);
        assert!(parse(extra).is_none());
        let mut read_with_text = clipboard_write("x");
        read_with_text["type"] = json!("helper-clipboard-read");
        assert!(parse(read_with_text).is_none());

        let invalid = |value: Value| parse(value).is_some_and(|message| !message.is_valid(NOW));
        assert!(invalid(clipboard_write("")));
        assert!(invalid(clipboard_write("bad\u{0}text")));
        assert!(invalid(clipboard_write("del\u{7f}")));
        assert!(invalid(clipboard_write(
            &"x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1)
        )));
        assert!(!invalid(clipboard_write(
            &"x".repeat(MAX_CLIPBOARD_TEXT_BYTES)
        )));
        let mut bad_id = clipboard_write("x");
        bad_id["transferId"] = json!("nope");
        assert!(invalid(bad_id));
        // Multi-byte characters count by bytes, not characters.
        assert!(invalid(clipboard_write(
            &"é".repeat(MAX_CLIPBOARD_TEXT_BYTES / 2 + 1)
        )));
        assert!(!invalid(clipboard_write(
            &"é".repeat(MAX_CLIPBOARD_TEXT_BYTES / 2)
        )));
    }

    #[test]
    fn only_clipboard_frames_may_exceed_the_control_plane_frame_bound() {
        // A maximal clipboard write is bigger than an ordinary control frame but still accepted.
        let full = clipboard_write(&"x".repeat(MAX_CLIPBOARD_TEXT_BYTES)).to_string();
        assert!(full.len() > MAX_BRIDGE_MESSAGE_BYTES);
        assert!(BridgeMessage::parse(&full).is_some());
        // Padding any other message past the ordinary bound is rejected.
        let padded = format!(
            "{}{}",
            json!({"type": "helper-session-revoked", "controlSessionId": SESSION, "reason": "user"}),
            " ".repeat(MAX_BRIDGE_MESSAGE_BYTES)
        );
        assert!(BridgeMessage::parse(&padded).is_none());
        // And nothing, clipboard included, may pass the clipboard frame bound.
        let huge = format!(
            "{}{}",
            clipboard_write("x"),
            " ".repeat(MAX_CLIPBOARD_BRIDGE_BYTES)
        );
        assert!(BridgeMessage::parse(&huge).is_none());
    }
}
