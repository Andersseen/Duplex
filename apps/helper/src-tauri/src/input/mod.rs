//! Native pointer and keyboard input.
//!
//! [`NativeInput`] is the only place that can turn relayed input into operating-system events. It
//! authorizes every event itself — the controlled browser and the room are not trusted — and keeps
//! the pressed-button bookkeeping that guarantees buttons are released when a session ends.
//!
//! Platform code lives behind [`NativePointerBackend`] so all of this is testable with a fake.

#[cfg(test)]
mod fake;
pub mod geometry;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::protocol::{InputEvent, WireState};
use geometry::{
    scroll_to_native, ButtonState, ClickTracker, DisplayTarget, MouseEventKind, PointerButton,
};

/// Largest scroll delta accepted per event, in logical (CSS-pixel-like) units.
pub const MAX_SCROLL_DELTA: f64 = 2000.0;
pub const MAX_SEQUENCE: u64 = u32::MAX as u64;
/// Legitimate 60 Hz pointer control plus clicks and scroll stays well under this.
pub const MAX_EVENTS_PER_SECOND: u32 = 240;
const MAX_QUEUED_ACTIONS: usize = 256;
/// Extra room reserved so a button release is never refused because the queue is full.
const RELEASE_QUEUE_RESERVE: usize = 64;
const PERMISSION_RECHECK_MS: u64 = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Unsupported,
    NotGranted,
    Granted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputError {
    /// The OS refused to post events (Accessibility trust was lost).
    AccessDenied,
    /// The event could not be built or posted for another reason; it is dropped, not retried.
    Failed,
}

/// Everything the OS-specific layer must provide. Implementations hold no session state.
pub trait NativePointerBackend: Send + Sync {
    fn platform(&self) -> &'static str;
    /// Current trust state. Must never prompt the user.
    fn permission(&self) -> PermissionState;
    /// Ask the OS to prompt for access. Only ever called from an explicit local user action.
    fn request_permission(&self) -> PermissionState;
    fn displays(&self) -> Vec<DisplayTarget>;
    /// Fresh bounds of one display, or `None` if it is no longer active.
    fn display(&self, id: u32) -> Option<DisplayTarget> {
        self.displays().into_iter().find(|display| display.id == id)
    }
    fn move_pointer(&self, kind: MouseEventKind, x: f64, y: f64) -> Result<(), InputError>;
    fn button(
        &self,
        kind: MouseEventKind,
        x: f64,
        y: f64,
        click_count: i64,
    ) -> Result<(), InputError>;
    fn scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), InputError>;
    /// Whether the backend can post physical keyboard events on this platform.
    fn supports_keyboard(&self) -> bool {
        false
    }
    fn keyboard(&self, code: &str, down: bool) -> Result<(), InputError>;
}

/// Backend for operating systems without native input support: pairing and the permission
/// protocol keep working, native input capabilities are simply unavailable.
#[cfg(any(not(target_os = "macos"), test))]
pub struct UnsupportedBackend;

#[cfg(any(not(target_os = "macos"), test))]
impl NativePointerBackend for UnsupportedBackend {
    fn platform(&self) -> &'static str {
        "unsupported"
    }
    fn permission(&self) -> PermissionState {
        PermissionState::Unsupported
    }
    fn request_permission(&self) -> PermissionState {
        PermissionState::Unsupported
    }
    fn displays(&self) -> Vec<DisplayTarget> {
        Vec::new()
    }
    fn move_pointer(&self, _: MouseEventKind, _: f64, _: f64) -> Result<(), InputError> {
        Err(InputError::Failed)
    }
    fn button(&self, _: MouseEventKind, _: f64, _: f64, _: i64) -> Result<(), InputError> {
        Err(InputError::Failed)
    }
    fn scroll(&self, _: i32, _: i32) -> Result<(), InputError> {
        Err(InputError::Failed)
    }
    fn keyboard(&self, _: &str, _: bool) -> Result<(), InputError> {
        Err(InputError::Failed)
    }
}

/// The backend for the current platform.
pub fn platform_backend() -> Arc<dyn NativePointerBackend> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::MacosBackend)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(UnsupportedBackend)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub selected: bool,
}

/// Low-frequency state for the helper UI. Never sent to the remote peer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    pub platform: &'static str,
    pub accessibility: PermissionState,
    pub displays: Vec<DisplayInfo>,
    pub selected_display_id: Option<u32>,
    pub pointer_ready: bool,
    /// Whether keyboard events can currently be posted to the selected display.
    pub keyboard_available: bool,
    pub session_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndCause {
    LocalStop,
    PermissionLost,
    DisplayLost,
    Expired,
    Revoked,
    Superseded,
    Disconnected,
    Shutdown,
}

impl EndCause {
    /// Whether the owner browser should be told to revoke its grant as well.
    pub fn needs_browser_revoke(self) -> bool {
        matches!(
            self,
            Self::LocalStop | Self::PermissionLost | Self::DisplayLost
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeEvent {
    StatusChanged,
    SessionEnded {
        control_session_id: String,
        cause: EndCause,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    Invalid,
    NoSession,
    WrongSession,
    WrongSurface,
    Expired,
    ScopeMissing,
    Stale,
    AccessibilityUnavailable,
    NoDisplay,
    RateLimited,
    QueueFull,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGrant {
    pub control_session_id: String,
    pub surface_id: String,
    pub pointer: bool,
    pub keyboard: bool,
    pub expires_at_ms: u64,
}

struct ActiveSession {
    grant: SessionGrant,
    last_sequence: Option<u64>,
}

enum Op {
    Move {
        x: f64,
        y: f64,
    },
    Button {
        button: PointerButton,
        state: ButtonState,
        x: f64,
        y: f64,
    },
    Scroll {
        delta_x: f64,
        delta_y: f64,
    },
    Keyboard { code: String, down: bool },
}

struct Queued {
    session_id: String,
    sequence: u64,
    op: Op,
}

struct State {
    permission: PermissionState,
    permission_checked_ms: u64,
    displays: Vec<DisplayTarget>,
    selected_display: Option<u32>,
    selection_explicit: bool,
    session: Option<ActiveSession>,
    pressed: Vec<PointerButton>,
    pressed_keys: Vec<String>,
    last_point: Option<(f64, f64)>,
    clicks: ClickTracker,
    move_slot: Option<Queued>,
    actions: VecDeque<Queued>,
    window_start_ms: u64,
    window_count: u32,
    last_status: Option<NativeStatus>,
    events: Vec<NativeEvent>,
    shutdown: bool,
}

type Listener = Arc<dyn Fn(NativeEvent) + Send + Sync>;

struct Shared {
    backend: Arc<dyn NativePointerBackend>,
    state: Mutex<State>,
    wake: Condvar,
    listener: Mutex<Option<Listener>>,
}

#[derive(Clone)]
pub struct NativeInput {
    shared: Arc<Shared>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl NativeInput {
    pub fn new(backend: Arc<dyn NativePointerBackend>) -> Self {
        let input = Self {
            shared: Arc::new(Shared {
                backend,
                state: Mutex::new(State {
                    permission: PermissionState::Unsupported,
                    permission_checked_ms: 0,
                    displays: Vec::new(),
                    selected_display: None,
                    selection_explicit: false,
                    session: None,
                    pressed: Vec::new(),
                    pressed_keys: Vec::new(),
                    last_point: None,
                    clicks: ClickTracker::default(),
                    move_slot: None,
                    actions: VecDeque::new(),
                    window_start_ms: 0,
                    window_count: 0,
                    last_status: None,
                    events: Vec::new(),
                    shutdown: false,
                }),
                wake: Condvar::new(),
                listener: Mutex::new(None),
            }),
        };
        input.refresh(now_ms());
        input
    }

    pub fn platform_default() -> Self {
        Self::new(platform_backend())
    }

    /// Receive low-frequency state changes. Called without any internal lock held.
    pub fn set_listener(&self, listener: Option<Listener>) {
        *self
            .shared
            .listener
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = listener;
    }

    /// Start the thread that posts queued events. Tests drive [`Self::process_pending`] instead.
    pub fn spawn_worker(&self) {
        let input = self.clone();
        let _ = std::thread::Builder::new()
            .name("duplex-native-input".into())
            .spawn(move || input.run_worker());
    }

    // ----- Status ---------------------------------------------------------------------------

    /// Re-check permission and displays, then return the current status.
    pub fn status(&self, now: u64) -> NativeStatus {
        self.refresh(now)
    }

    /// Safe, coarse capability: the only thing the remote peer ever learns about this machine.
    pub fn available_scopes(&self, now: u64) -> Vec<&'static str> {
        let status = self.refresh(now);
        let mut scopes = Vec::new();
        if status.pointer_ready {
            scopes.push("pointer");
        }
        if status.keyboard_available {
            scopes.push("keyboard");
        }
        scopes
    }

    pub fn refresh(&self, now: u64) -> NativeStatus {
        self.with_state(|state| {
            self.refresh_locked(state, now);
            Self::snapshot(&self.shared.backend, state)
        })
    }

    /// Explicit local action: prompt for Accessibility access.
    pub fn request_accessibility(&self, now: u64) -> NativeStatus {
        self.shared.backend.request_permission();
        self.refresh(now)
    }

    /// The local user explicitly chooses the display the helper may control.
    pub fn select_display(&self, id: u32, now: u64) -> Result<NativeStatus, &'static str> {
        self.with_state(|state| {
            self.refresh_locked(state, now);
            if !state.displays.iter().any(|display| display.id == id) {
                return Err("That display is not available.");
            }
            if state.selected_display.is_some_and(|current| current != id) {
                // Never silently retarget a live session: changing the display ends it.
                self.end_session_locked(state, EndCause::DisplayLost);
            }
            state.selected_display = Some(id);
            state.selection_explicit = true;
            self.refresh_locked(state, now);
            Ok(Self::snapshot(&self.shared.backend, state))
        })
    }

    // ----- Session lifecycle ----------------------------------------------------------------

    pub fn begin_session(&self, grant: SessionGrant, now: u64) {
        self.with_state(|state| {
            self.refresh_locked(state, now);
            self.end_session_locked(state, EndCause::Superseded);
            state.session = Some(ActiveSession {
                grant,
                last_sequence: None,
            });
            state.events.push(NativeEvent::StatusChanged);
            self.refresh_locked(state, now);
        });
    }

    /// End the session identified by `control_session_id`; other ids are ignored.
    pub fn end_matching_session(&self, control_session_id: &str, cause: EndCause) {
        self.with_state(|state| {
            let matches = state
                .session
                .as_ref()
                .is_some_and(|session| session.grant.control_session_id == control_session_id);
            if matches {
                self.end_session_locked(state, cause);
            }
        });
    }

    pub fn end_session(&self, cause: EndCause) {
        self.with_state(|state| self.end_session_locked(state, cause));
    }

    /// Local emergency stop. Returns the id of the session that was stopped, if any.
    pub fn stop_control(&self) -> Option<String> {
        self.with_state(|state| {
            let id = state
                .session
                .as_ref()
                .map(|session| session.grant.control_session_id.clone());
            self.end_session_locked(state, EndCause::LocalStop);
            id
        })
    }

    /// Synthesize `up` for every button believed held and drop anything still queued.
    #[cfg(test)]
    pub fn release_all(&self) {
        self.with_state(|state| self.release_all_locked(state));
    }

    pub fn shutdown(&self) {
        self.with_state(|state| {
            self.end_session_locked(state, EndCause::Shutdown);
            self.release_all_locked(state);
            state.shutdown = true;
        });
        self.shared.wake.notify_all();
    }

    // ----- Input ----------------------------------------------------------------------------

    /// Authorize and enqueue one relayed event. Nothing reaches the OS from here directly.
    pub fn submit(&self, input: &InputEvent, now: u64) -> Result<(), Denied> {
        let result = self.with_state(|state| self.submit_locked(state, input, now));
        if result.is_ok() {
            self.shared.wake.notify_one();
        }
        result
    }

    /// Execute everything queued. The worker thread does this continuously.
    #[cfg(test)]
    pub fn process_pending(&self, now: u64) -> usize {
        let mut processed = 0;
        loop {
            let next = {
                let mut state = self.lock();
                Self::pop_next(&mut state)
            };
            let Some(item) = next else { break };
            self.execute(item, now);
            processed += 1;
        }
        processed
    }

    fn run_worker(&self) {
        loop {
            let item = {
                let mut state = self.lock();
                loop {
                    if state.shutdown {
                        return;
                    }
                    if let Some(item) = Self::pop_next(&mut state) {
                        break item;
                    }
                    state = self
                        .shared
                        .wake
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                }
            };
            self.execute(item, now_ms());
        }
    }

    fn submit_locked(&self, state: &mut State, input: &InputEvent, now: u64) -> Result<(), Denied> {
        if !input.is_valid() {
            return Err(Denied::Invalid);
        }
        let Some(session) = state.session.as_ref() else {
            return Err(Denied::NoSession);
        };
        if session.grant.control_session_id != input.control_session_id() {
            return Err(Denied::WrongSession);
        }
        if session.grant.surface_id != input.surface_id() {
            return Err(Denied::WrongSurface);
        }
        if session.grant.expires_at_ms <= now {
            self.end_session_locked(state, EndCause::Expired);
            return Err(Denied::Expired);
        }
        let keyboard_event = matches!(input, InputEvent::Keyboard { .. });
        if (keyboard_event && !session.grant.keyboard)
            || (!keyboard_event && !session.grant.pointer)
        {
            return Err(Denied::ScopeMissing);
        }
        let sequence = input.sequence();
        if session.last_sequence.is_some_and(|last| sequence <= last) {
            return Err(Denied::Stale);
        }
        if state.permission != PermissionState::Granted {
            return Err(Denied::AccessibilityUnavailable);
        }
        if state.selected_display.is_none() {
            return Err(Denied::NoDisplay);
        }
        let is_release = matches!(
            input,
            InputEvent::PointerButton {
                state: crate::protocol::WireState::Up,
                ..
            }
        ) || matches!(input, InputEvent::Keyboard { state: WireState::Up, .. });
        if !is_release && !Self::within_rate(state, now) {
            return Err(Denied::RateLimited);
        }
        let op = match input {
            InputEvent::PointerMove { x, y, .. } => Op::Move { x: *x, y: *y },
            InputEvent::PointerButton {
                button,
                state: button_state,
                x,
                y,
                ..
            } => Op::Button {
                button: (*button).into(),
                state: (*button_state).into(),
                x: *x,
                y: *y,
            },
            InputEvent::Scroll {
                delta_x, delta_y, ..
            } => Op::Scroll {
                delta_x: *delta_x,
                delta_y: *delta_y,
            },
            InputEvent::Keyboard { code, state, .. } => Op::Keyboard {
                code: code.clone(), down: *state == WireState::Down,
            },
        };
        let queued = Queued {
            session_id: input.control_session_id().to_owned(),
            sequence,
            op,
        };
        match queued.op {
            // Stale motion is superseded: only the newest position is ever kept.
            Op::Move { .. } => state.move_slot = Some(queued),
            _ => {
                let limit = if is_release {
                    MAX_QUEUED_ACTIONS + RELEASE_QUEUE_RESERVE
                } else {
                    MAX_QUEUED_ACTIONS
                };
                if state.actions.len() >= limit {
                    return Err(Denied::QueueFull);
                }
                state.actions.push_back(queued);
            }
        }
        if let Some(session) = state.session.as_mut() {
            session.last_sequence = Some(sequence);
        }
        Ok(())
    }

    fn within_rate(state: &mut State, now: u64) -> bool {
        if now.saturating_sub(state.window_start_ms) >= 1000 {
            state.window_start_ms = now;
            state.window_count = 0;
        }
        state.window_count += 1;
        state.window_count <= MAX_EVENTS_PER_SECOND
    }

    /// Oldest first by sequence, so a newer coalesced move never overtakes an older action.
    fn pop_next(state: &mut State) -> Option<Queued> {
        let take_move = match (state.move_slot.as_ref(), state.actions.front()) {
            (Some(slot), Some(action)) => slot.sequence < action.sequence,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if take_move {
            state.move_slot.take()
        } else {
            state.actions.pop_front()
        }
    }

    fn execute(&self, item: Queued, now: u64) {
        self.with_state(|state| self.execute_locked(state, item, now));
    }

    fn execute_locked(&self, state: &mut State, item: Queued, now: u64) {
        // Defense in depth: re-check everything at the moment of execution, not just at enqueue.
        let Some(session) = state.session.as_ref() else {
            return;
        };
        if session.grant.control_session_id != item.session_id {
            return;
        }
        let keyboard_event = matches!(item.op, Op::Keyboard { .. });
        if (keyboard_event && !session.grant.keyboard)
            || (!keyboard_event && !session.grant.pointer)
        {
            return;
        }
        if session.grant.expires_at_ms <= now {
            self.end_session_locked(state, EndCause::Expired);
            return;
        }
        if now.saturating_sub(state.permission_checked_ms) >= PERMISSION_RECHECK_MS {
            state.permission = self.shared.backend.permission();
            state.permission_checked_ms = now;
        }
        if state.permission != PermissionState::Granted {
            self.end_session_locked(state, EndCause::PermissionLost);
            return;
        }
        // Fresh bounds every time, so a resolution change is honoured and a vanished display ends control.
        let display = state
            .selected_display
            .and_then(|id| self.shared.backend.display(id));
        let Some(display) = display else {
            self.end_session_locked(state, EndCause::DisplayLost);
            return;
        };
        let result = match item.op {
            Op::Move { x, y } => {
                let (px, py) = display.map_normalized(x, y);
                let kind = MouseEventKind::for_move(state.pressed.last().copied());
                let result = self.shared.backend.move_pointer(kind, px, py);
                if result.is_ok() {
                    state.last_point = Some((px, py));
                }
                result
            }
            Op::Button {
                button,
                state: button_state,
                x,
                y,
            } => {
                let (px, py) = display.map_normalized(x, y);
                self.execute_button(state, button, button_state, px, py, now)
            }
            Op::Scroll { delta_x, delta_y } => self
                .shared
                .backend
                .scroll(scroll_to_native(delta_x), scroll_to_native(delta_y)),
            Op::Keyboard { code, down } => self.execute_key(state, &code, down),
        };
        if result == Err(InputError::AccessDenied) {
            // Do not keep retrying native posting once the OS has said no.
            state.permission = PermissionState::NotGranted;
            self.end_session_locked(state, EndCause::PermissionLost);
        }
    }

    fn execute_key(&self, state: &mut State, code: &str, down: bool) -> Result<(), InputError> {
        if down {
            // Keep system/application shortcuts unavailable. Common text editing shortcuts are
            // allowed with Command or Control, optionally with Shift; Option alone remains useful
            // for typing alternate characters.
            if !shortcut_is_allowed(&state.pressed_keys, code) {
                return Ok(());
            }
            let result = self.shared.backend.keyboard(code, true);
            if result.is_ok() && !state.pressed_keys.iter().any(|held| held == code) {
                state.pressed_keys.push(code.to_owned());
            }
            result
        } else {
            if !state.pressed_keys.iter().any(|held| held == code) {
                return Ok(());
            }
            let result = self.shared.backend.keyboard(code, false);
            if result.is_ok() {
                state.pressed_keys.retain(|held| held != code);
            }
            result
        }
    }

    fn execute_button(
        &self,
        state: &mut State,
        button: PointerButton,
        button_state: ButtonState,
        px: f64,
        py: f64,
        now: u64,
    ) -> Result<(), InputError> {
        match button_state {
            ButtonState::Down => {
                if state.pressed.contains(&button) {
                    return Ok(());
                }
                let count = state.clicks.on_down(button, px, py, now);
                let kind = MouseEventKind::for_button(button, ButtonState::Down);
                let result = self.shared.backend.button(kind, px, py, count);
                if result.is_ok() {
                    state.pressed.push(button);
                    state.last_point = Some((px, py));
                }
                result
            }
            ButtonState::Up => {
                // A release we never pressed must not become a stray click.
                if !state.pressed.contains(&button) {
                    return Ok(());
                }
                let kind = MouseEventKind::for_button(button, ButtonState::Up);
                let result = self
                    .shared
                    .backend
                    .button(kind, px, py, state.clicks.on_up());
                if result.is_ok() {
                    state.pressed.retain(|held| *held != button);
                    state.last_point = Some((px, py));
                }
                result
            }
        }
    }

    // ----- Internals ------------------------------------------------------------------------

    fn lock(&self) -> MutexGuard<'_, State> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Run `f` under the state lock, then deliver any events with the lock released.
    fn with_state<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let (result, events) = {
            let mut state = self.lock();
            let result = f(&mut state);
            (result, std::mem::take(&mut state.events))
        };
        if !events.is_empty() {
            let listener = self
                .shared
                .listener
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if let Some(listener) = listener {
                for event in events {
                    listener(event);
                }
            }
        }
        result
    }

    fn refresh_locked(&self, state: &mut State, now: u64) {
        state.permission = self.shared.backend.permission();
        state.permission_checked_ms = now;
        state.displays = self.shared.backend.displays();
        state.displays.sort_by(|a, b| {
            a.origin_x
                .total_cmp(&b.origin_x)
                .then(a.origin_y.total_cmp(&b.origin_y))
                .then(a.id.cmp(&b.id))
        });
        let selected_present = state
            .selected_display
            .is_some_and(|id| state.displays.iter().any(|display| display.id == id));
        let selected_lost = state.selected_display.is_some() && !selected_present;
        if selected_lost {
            state.selected_display = None;
            state.selection_explicit = false;
        }
        match state.displays.len() {
            1 if state.selected_display.is_none() => {
                // A lone display is unambiguous, so it may be chosen for the user.
                state.selected_display = Some(state.displays[0].id);
                state.selection_explicit = false;
            }
            0 | 1 => {}
            // Several displays: a selection the user did not make explicitly no longer counts.
            _ if !state.selection_explicit => state.selected_display = None,
            _ => {}
        }
        if state.session.is_some() {
            if state.permission != PermissionState::Granted {
                self.end_session_locked(state, EndCause::PermissionLost);
            } else if selected_lost || state.selected_display.is_none() {
                self.end_session_locked(state, EndCause::DisplayLost);
            }
        }
        let status = Self::snapshot(&self.shared.backend, state);
        if state.last_status.as_ref() != Some(&status) {
            state.last_status = Some(status);
            state.events.push(NativeEvent::StatusChanged);
        }
    }

    fn snapshot(backend: &Arc<dyn NativePointerBackend>, state: &State) -> NativeStatus {
        let displays = state
            .displays
            .iter()
            .enumerate()
            .map(|(index, display)| DisplayInfo {
                id: display.id,
                name: format!("Display {}", index + 1),
                width: display.width.round() as u32,
                height: display.height.round() as u32,
                selected: state.selected_display == Some(display.id),
            })
            .collect();
        NativeStatus {
            platform: backend.platform(),
            accessibility: state.permission,
            displays,
            selected_display_id: state.selected_display,
            pointer_ready: state.permission == PermissionState::Granted
                && state.selected_display.is_some(),
            keyboard_available: backend.supports_keyboard()
                && state.permission == PermissionState::Granted
                && state.selected_display.is_some(),
            session_active: state.session.is_some(),
        }
    }

    fn end_session_locked(&self, state: &mut State, cause: EndCause) {
        let Some(session) = state.session.take() else {
            return;
        };
        self.release_all_locked(state);
        state.events.push(NativeEvent::SessionEnded {
            control_session_id: session.grant.control_session_id,
            cause,
        });
        state.events.push(NativeEvent::StatusChanged);
        // The UI snapshot must reflect the ended session on the next refresh.
        state.last_status = None;
    }

    fn release_all_locked(&self, state: &mut State) {
        let pressed_keys = std::mem::take(&mut state.pressed_keys);
        for code in pressed_keys.into_iter().rev() {
            let _ = self.shared.backend.keyboard(&code, false);
        }
        let pressed = std::mem::take(&mut state.pressed);
        let (x, y) = state.last_point.unwrap_or((0.0, 0.0));
        let click_count = state.clicks.on_up();
        // Release in reverse press order, and keep going even if one release fails.
        for button in pressed.into_iter().rev() {
            let kind = MouseEventKind::for_button(button, ButtonState::Up);
            let _ = self.shared.backend.button(kind, x, y, click_count);
        }
        state.clicks.reset();
        state.move_slot = None;
        state.actions.clear();
    }
}

fn shortcut_is_allowed(pressed: &[String], code: &str) -> bool {
    let command = pressed.iter().any(|key| matches!(key.as_str(), "MetaLeft" | "MetaRight"));
    let control = pressed
        .iter()
        .any(|key| matches!(key.as_str(), "ControlLeft" | "ControlRight"));
    let option = pressed
        .iter()
        .any(|key| matches!(key.as_str(), "AltLeft" | "AltRight"));
    let shift = pressed
        .iter()
        .any(|key| matches!(key.as_str(), "ShiftLeft" | "ShiftRight"));
    if !command && !control {
        return true;
    }
    !option
        && !(command && control)
        && matches!(code, "KeyA" | "KeyC" | "KeyV" | "KeyX" | "KeyZ")
        && (!shift || matches!(code, "KeyA" | "KeyZ"))
}
