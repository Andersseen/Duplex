use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::input::geometry::{ButtonState, PointerButton};
use crate::input::{MAX_SCROLL_DELTA, MAX_SEQUENCE};

pub const INPUT_PROTOCOL_VERSION: u8 = 1;
/// Upper bound on any text frame accepted from the room.
pub const MAX_BRIDGE_MESSAGE_BYTES: usize = 4096;

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

/// Pointer input relayed by the room. There is deliberately no keyboard variant and no generic
/// payload: anything that is not one of these three shapes fails to deserialize.
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
            } => control_session_id,
        }
    }

    pub fn surface_id(&self) -> &str {
        match self {
            Self::PointerMove { surface_id, .. }
            | Self::PointerButton { surface_id, .. }
            | Self::Scroll { surface_id, .. } => surface_id,
        }
    }

    pub fn sequence(&self) -> u64 {
        match self {
            Self::PointerMove { sequence, .. }
            | Self::PointerButton { sequence, .. }
            | Self::Scroll { sequence, .. } => *sequence,
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
        }
    }
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
}

impl BridgeMessage {
    pub fn parse(text: &str) -> Option<Self> {
        if text.len() > MAX_BRIDGE_MESSAGE_BYTES {
            return None;
        }
        serde_json::from_str::<Self>(text).ok()
    }

    /// Structural validation that serde alone cannot express. `now_ms` is the wall clock.
    pub fn is_valid(&self, now_ms: u64) -> bool {
        match self {
            Self::SessionAuthorized { session } => {
                valid_uuid(&session.control_session_id)
                    && valid_uuid(&session.surface_id)
                    && !session.scopes.is_empty()
                    && session.scopes.len() <= 2
                    && session.scopes.iter().collect::<HashSet<_>>().len() == session.scopes.len()
                    && session
                        .scopes
                        .iter()
                        .all(|scope| matches!(scope.as_str(), "pointer" | "keyboard"))
                    && session.expires_at > now_ms
                    && session.expires_at <= now_ms + 10 * 60 * 1000
            }
            Self::SessionRevoked {
                control_session_id, ..
            } => valid_uuid(control_session_id),
            Self::Input { input } => input.is_valid(),
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
        assert!(!session(json!(["clipboard"]), NOW + 1_000).is_valid(NOW));
        assert!(!session(json!([]), NOW + 1_000).is_valid(NOW));
    }

    #[test]
    fn accepts_pointer_move_button_and_scroll_inputs() {
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
        // No keyboard-like or generic payload shape can deserialize at all.
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
}
