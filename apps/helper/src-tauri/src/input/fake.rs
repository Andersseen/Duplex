//! In-memory backend so authorization and input handling are tested without touching the OS.

use std::sync::Mutex;

use super::geometry::{DisplayTarget, MouseEventKind};
use super::{InputError, NativePointerBackend, PermissionState};

#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    Move(MouseEventKind, f64, f64),
    Button(MouseEventKind, f64, f64, i64),
    Scroll(i32, i32),
    Keyboard(String, bool),
}

pub struct FakeState {
    pub permission: PermissionState,
    pub displays: Vec<DisplayTarget>,
    pub calls: Vec<Call>,
    pub fail_with: Option<InputError>,
    pub permission_requests: u32,
    /// What a successful explicit request flips the permission to.
    pub grant_on_request: bool,
}

pub struct FakeBackend {
    pub state: Mutex<FakeState>,
}

impl FakeBackend {
    pub fn new(permission: PermissionState, displays: Vec<DisplayTarget>) -> Self {
        Self {
            state: Mutex::new(FakeState {
                permission,
                displays,
                calls: Vec::new(),
                fail_with: None,
                permission_requests: 0,
                grant_on_request: true,
            }),
        }
    }

    pub fn calls(&self) -> Vec<Call> {
        self.state.lock().unwrap().calls.clone()
    }

    pub fn clear_calls(&self) {
        self.state.lock().unwrap().calls.clear();
    }

    pub fn set_permission(&self, permission: PermissionState) {
        self.state.lock().unwrap().permission = permission;
    }

    pub fn set_displays(&self, displays: Vec<DisplayTarget>) {
        self.state.lock().unwrap().displays = displays;
    }

    pub fn fail_with(&self, error: Option<InputError>) {
        self.state.lock().unwrap().fail_with = error;
    }

    fn record(&self, call: Call) -> Result<(), InputError> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.fail_with {
            return Err(error);
        }
        state.calls.push(call);
        Ok(())
    }
}

impl NativePointerBackend for FakeBackend {
    fn platform(&self) -> &'static str {
        "macos"
    }

    fn permission(&self) -> PermissionState {
        self.state.lock().unwrap().permission
    }

    fn request_permission(&self) -> PermissionState {
        let mut state = self.state.lock().unwrap();
        state.permission_requests += 1;
        if state.grant_on_request {
            state.permission = PermissionState::Granted;
        }
        state.permission
    }

    fn displays(&self) -> Vec<DisplayTarget> {
        self.state.lock().unwrap().displays.clone()
    }

    fn move_pointer(&self, kind: MouseEventKind, x: f64, y: f64) -> Result<(), InputError> {
        self.record(Call::Move(kind, x, y))
    }

    fn button(
        &self,
        kind: MouseEventKind,
        x: f64,
        y: f64,
        click_count: i64,
    ) -> Result<(), InputError> {
        self.record(Call::Button(kind, x, y, click_count))
    }

    fn scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), InputError> {
        self.record(Call::Scroll(delta_x, delta_y))
    }

    fn supports_keyboard(&self) -> bool {
        true
    }

    fn keyboard(&self, code: &str, down: bool) -> Result<(), InputError> {
        self.record(Call::Keyboard(code.to_owned(), down))
    }
}
