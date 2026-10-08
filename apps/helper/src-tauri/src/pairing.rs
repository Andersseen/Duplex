use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use url::Url;

const PREFIX: &str = "duplex-pair-v1.";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingBundle {
    pub version: u8,
    #[serde(rename = "apiOrigin")]
    pub api_origin: String,
    #[serde(rename = "roomId")]
    pub room_id: String,
    pub token: String,
}

impl PairingBundle {
    pub fn parse(input: &str) -> Result<Self, &'static str> {
        let encoded = input.strip_prefix(PREFIX).ok_or("Invalid pairing code.")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "Invalid pairing code.")?;
        let bundle: Self = serde_json::from_slice(&bytes).map_err(|_| "Invalid pairing code.")?;
        if bundle.version != 1
            || !valid_room_id(&bundle.room_id)
            || !valid_token(&bundle.token)
            || !valid_origin(&bundle.api_origin)
        {
            return Err("Invalid pairing code.");
        }
        Ok(bundle)
    }

    pub fn websocket_url(&self) -> Result<Url, &'static str> {
        let mut url = Url::parse(&self.api_origin).map_err(|_| "Invalid pairing code.")?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| "Invalid pairing code.")?;
        url.set_path(&format!("/api/rooms/{}/helper/ws", self.room_id));
        Ok(url)
    }
}

fn valid_room_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn valid_token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn valid_origin(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    if url.origin().ascii_serialization() != value {
        return false;
    }
    url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_bundle_and_builds_secure_websocket_endpoint() {
        let token = "A".repeat(43);
        let room = "B".repeat(22);
        let json = format!(
            r#"{{"version":1,"apiOrigin":"https://api.example.test","roomId":"{room}","token":"{token}"}}"#
        );
        let code = format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(json));
        let bundle = PairingBundle::parse(&code).unwrap();
        assert_eq!(
            bundle.websocket_url().unwrap().as_str(),
            format!("wss://api.example.test/api/rooms/{room}/helper/ws")
        );
    }

    #[test]
    fn rejects_untrusted_origins_and_malformed_secrets() {
        assert!(!valid_origin("http://api.example.test"));
        assert!(!valid_origin("https://user:pass@api.example.test"));
        assert!(!valid_origin("https://api.example.test/path"));
        assert!(valid_origin("http://localhost:8787"));
        assert!(!valid_token("too-short"));
    }
}
