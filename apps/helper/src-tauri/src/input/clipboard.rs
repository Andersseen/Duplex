//! Authorized, explicit, text-only clipboard operations.
//!
//! Like pointer and keyboard input, every operation is authorized here against the live session
//! grant: the controlled browser and the room are not trusted. Nothing watches the clipboard. A
//! read or write happens only when a request names this exact session, surface and `clipboard`
//! scope, and the content is never logged or retained after it has been returned.

use std::collections::VecDeque;

use super::{Denied, EndCause, NativeInput, State};
use crate::protocol::{acceptable_clipboard_text, ClipboardOp, ClipboardRequest};

/// Matches the shared protocol's `CLIPBOARD_MIN_INTERVAL_MS`.
const MIN_INTERVAL_MS: u64 = 500;
/// How many recent transfer ids are remembered per session to reject replays.
const REMEMBERED_TRANSFERS: usize = 64;

/// Why a platform clipboard backend could not complete an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardError {
    /// This platform has no clipboard backend.
    Unavailable,
    /// The operation failed or timed out; no content was changed or exposed. Only the macOS
    /// backend constructs it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Failed,
}

/// The result of one authorized (or refused) clipboard operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardOutcome {
    Written,
    Text(String),
    Denied(Denied),
    Unavailable,
    Empty,
    TooLarge,
    Failed,
}

/// Per-session bookkeeping that makes duplicated or flooded requests harmless.
#[derive(Default)]
pub struct ClipboardGuard {
    seen: VecDeque<String>,
    last_operation_ms: Option<u64>,
}

impl NativeInput {
    /// Authorize and perform one clipboard operation. Blocks only for the platform call, so
    /// callers on an async runtime should run it on a blocking thread.
    pub fn clipboard(&self, request: &ClipboardRequest, now: u64) -> ClipboardOutcome {
        if let Err(denied) = self.with_state(|state| self.authorize_clipboard(state, request, now))
        {
            return ClipboardOutcome::Denied(denied);
        }
        let backend = &self.shared.backend;
        match &request.op {
            ClipboardOp::Write(text) => match backend.clipboard_write(text) {
                Ok(()) => ClipboardOutcome::Written,
                Err(ClipboardError::Unavailable) => ClipboardOutcome::Unavailable,
                Err(ClipboardError::Failed) => ClipboardOutcome::Failed,
            },
            ClipboardOp::Read => {
                let text = match backend.clipboard_read() {
                    Ok(text) => text,
                    Err(ClipboardError::Unavailable) => return ClipboardOutcome::Unavailable,
                    Err(ClipboardError::Failed) => return ClipboardOutcome::Failed,
                };
                if text.is_empty() {
                    return ClipboardOutcome::Empty;
                }
                if text.len() > crate::protocol::MAX_CLIPBOARD_TEXT_BYTES {
                    return ClipboardOutcome::TooLarge;
                }
                if !acceptable_clipboard_text(&text) {
                    return ClipboardOutcome::Failed;
                }
                // The session may have been stopped or revoked while the OS call ran.
                let still_authorized = self.with_state(|state| {
                    state.session.as_ref().is_some_and(|session| {
                        session.grant.control_session_id == request.control_session_id
                            && session.grant.expires_at_ms > now_after(now)
                    })
                });
                if still_authorized {
                    ClipboardOutcome::Text(text)
                } else {
                    ClipboardOutcome::Denied(Denied::NoSession)
                }
            }
        }
    }

    fn authorize_clipboard(
        &self,
        state: &mut State,
        request: &ClipboardRequest,
        now: u64,
    ) -> Result<(), Denied> {
        if !request.is_valid() {
            return Err(Denied::Invalid);
        }
        let Some(session) = state.session.as_ref() else {
            return Err(Denied::NoSession);
        };
        if session.grant.control_session_id != request.control_session_id {
            return Err(Denied::WrongSession);
        }
        if session.grant.surface_id != request.surface_id {
            return Err(Denied::WrongSurface);
        }
        if session.grant.expires_at_ms <= now {
            self.end_session_locked(state, EndCause::Expired);
            return Err(Denied::Expired);
        }
        if !session.grant.clipboard {
            return Err(Denied::ScopeMissing);
        }
        if !self.shared.backend.supports_clipboard() {
            return Err(Denied::ClipboardUnsupported);
        }
        let guard = &mut state.clipboard;
        if guard.seen.contains(&request.transfer_id) {
            return Err(Denied::Replayed);
        }
        if guard
            .last_operation_ms
            .is_some_and(|last| now.saturating_sub(last) < MIN_INTERVAL_MS)
        {
            return Err(Denied::RateLimited);
        }
        guard.seen.push_back(request.transfer_id.clone());
        if guard.seen.len() > REMEMBERED_TRANSFERS {
            guard.seen.pop_front();
        }
        guard.last_operation_ms = Some(now);
        Ok(())
    }
}

/// The wall clock to compare an expiry against after a platform call that may have taken time.
fn now_after(started: u64) -> u64 {
    super::now_ms().max(started)
}
