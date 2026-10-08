use serde::Deserialize;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize, serde::Serialize)]
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeMessage {
    #[serde(rename = "type")]
    pub kind: String,
    pub session: Option<SessionMetadata>,
    #[serde(rename = "controlSessionId")]
    pub control_session_id: Option<String>,
    pub reason: Option<String>,
}

impl BridgeMessage {
    pub fn is_valid(&self) -> bool {
        match self.kind.as_str() {
            "helper-session-authorized" => {
                self.session.as_ref().is_some_and(|session| {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    valid_uuid(&session.control_session_id)
                        && valid_uuid(&session.surface_id)
                        && !session.scopes.is_empty()
                        && session.scopes.len() <= 2
                        && session.scopes.iter().collect::<HashSet<_>>().len()
                            == session.scopes.len()
                        && session
                            .scopes
                            .iter()
                            .all(|scope| matches!(scope.as_str(), "pointer" | "keyboard"))
                        && session.expires_at > now
                        && session.expires_at <= now + 10 * 60 * 1000
                }) && self.control_session_id.is_none()
                    && self.reason.is_none()
            }
            "helper-session-revoked" => {
                self.session.is_none()
                    && self.control_session_id.as_deref().is_some_and(valid_uuid)
                    && self.reason.as_deref().is_some_and(|reason| {
                        matches!(
                            reason,
                            "user"
                                | "expired"
                                | "disconnected"
                                | "surface-ended"
                                | "helper-disconnected"
                                | "superseded"
                        )
                    })
            }
            _ => false,
        }
    }
}

fn valid_uuid(value: &str) -> bool {
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

    #[test]
    fn accepts_scoped_authorization_and_matching_revocation_shapes() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let authorization = serde_json::json!({
            "type": "helper-session-authorized",
            "session": {
                "controlSessionId": "123e4567-e89b-12d3-a456-426614174000",
                "surfaceId": "123e4567-e89b-12d3-a456-426614174001",
                "scopes": ["pointer", "keyboard"],
                "expiresAt": now + 60_000
            }
        });
        assert!(serde_json::from_value::<BridgeMessage>(authorization)
            .unwrap()
            .is_valid());
        let revocation = serde_json::json!({
            "type": "helper-session-revoked",
            "controlSessionId": "123e4567-e89b-12d3-a456-426614174000",
            "reason": "user"
        });
        assert!(serde_json::from_value::<BridgeMessage>(revocation)
            .unwrap()
            .is_valid());
    }

    #[test]
    fn rejects_unknown_fields_duplicate_scopes_and_unbounded_expiry() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let duplicate = serde_json::json!({
            "type": "helper-session-authorized",
            "session": {
                "controlSessionId": "123e4567-e89b-12d3-a456-426614174000",
                "surfaceId": "123e4567-e89b-12d3-a456-426614174001",
                "scopes": ["pointer", "pointer"], "expiresAt": now + 60_000
            }
        });
        assert!(!serde_json::from_value::<BridgeMessage>(duplicate)
            .unwrap()
            .is_valid());
        let unknown = serde_json::json!({"type":"helper-ready", "token":"secret"});
        assert!(serde_json::from_value::<BridgeMessage>(unknown).is_err());
        let too_long = serde_json::json!({
            "type": "helper-session-authorized",
            "session": {
                "controlSessionId": "123e4567-e89b-12d3-a456-426614174000",
                "surfaceId": "123e4567-e89b-12d3-a456-426614174001",
                "scopes": ["pointer"], "expiresAt": now + 11 * 60 * 1000
            }
        });
        assert!(!serde_json::from_value::<BridgeMessage>(too_long)
            .unwrap()
            .is_valid());
    }
}
