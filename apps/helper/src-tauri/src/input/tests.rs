use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::fake::{Call, FakeBackend};
use super::geometry::{DisplayTarget, MouseEventKind};
use super::*;
use crate::protocol::InputEvent;

const SESSION: &str = "123e4567-e89b-12d3-a456-426614174000";
const SURFACE: &str = "123e4567-e89b-12d3-a456-426614174001";
const OTHER: &str = "123e4567-e89b-12d3-a456-426614174099";
const NOW: u64 = 1_800_000_000_000;

fn display(id: u32, origin_x: f64, origin_y: f64, width: f64, height: f64) -> DisplayTarget {
    DisplayTarget {
        id,
        origin_x,
        origin_y,
        width,
        height,
    }
}

fn main_display() -> DisplayTarget {
    display(1, 0.0, 0.0, 1920.0, 1080.0)
}

struct Rig {
    backend: Arc<FakeBackend>,
    input: NativeInput,
    events: Arc<Mutex<Vec<NativeEvent>>>,
    sequence: Mutex<u64>,
}

impl Rig {
    fn new(permission: PermissionState, displays: Vec<DisplayTarget>) -> Self {
        let backend = Arc::new(FakeBackend::new(permission, displays));
        let input = NativeInput::new(backend.clone());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        input.set_listener(Some(Arc::new(move |event| {
            sink.lock().unwrap().push(event)
        })));
        Self {
            backend,
            input,
            events,
            sequence: Mutex::new(0),
        }
    }

    /// A ready single-display Mac with Accessibility granted.
    fn ready() -> Self {
        Self::new(PermissionState::Granted, vec![main_display()])
    }

    fn grant(&self, pointer: bool, expires_at_ms: u64) {
        self.grant_scopes(pointer, false, expires_at_ms);
    }

    fn grant_scopes(&self, pointer: bool, keyboard: bool, expires_at_ms: u64) {
        self.input.begin_session(
            SessionGrant {
                control_session_id: SESSION.into(),
                surface_id: SURFACE.into(),
                pointer,
                keyboard,
                expires_at_ms,
            },
            NOW,
        );
        *self.sequence.lock().unwrap() = 0;
    }

    fn active(&self) -> &Self {
        self.grant(true, NOW + 60_000);
        self
    }

    fn next_sequence(&self) -> u64 {
        let mut sequence = self.sequence.lock().unwrap();
        *sequence += 1;
        *sequence
    }

    fn event(&self, extra: Value) -> InputEvent {
        let mut value = json!({
            "protocolVersion": 1,
            "controlSessionId": SESSION,
            "surfaceId": SURFACE,
            "sequence": self.next_sequence(),
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    fn mv(&self, x: f64, y: f64) -> InputEvent {
        self.event(json!({"type": "input-pointer-move", "x": x, "y": y}))
    }

    fn button(&self, button: &str, state: &str, x: f64, y: f64) -> InputEvent {
        self.event(json!({
            "type": "input-pointer-button", "button": button, "state": state, "x": x, "y": y
        }))
    }

    fn scroll(&self, dx: f64, dy: f64) -> InputEvent {
        self.event(json!({"type": "input-scroll", "deltaX": dx, "deltaY": dy}))
    }

    fn key(&self, code: &str, state: &str) -> InputEvent {
        self.event(json!({"type": "input-keyboard", "code": code, "state": state}))
    }

    fn send(&self, event: &InputEvent) -> Result<(), Denied> {
        self.send_at(event, NOW)
    }

    fn send_at(&self, event: &InputEvent, now: u64) -> Result<(), Denied> {
        self.input.submit(event, now)
    }

    fn run(&self) -> usize {
        self.input.process_pending(NOW)
    }

    fn ended(&self) -> Vec<EndCause> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                NativeEvent::SessionEnded { cause, .. } => Some(*cause),
                NativeEvent::StatusChanged => None,
            })
            .collect()
    }
}

fn is_release(call: &Call, kind: MouseEventKind) -> bool {
    matches!(call, Call::Button(actual, ..) if *actual == kind)
}

fn is_move(call: &Call, kind: MouseEventKind) -> bool {
    matches!(call, Call::Move(actual, ..) if *actual == kind)
}

// ----- Capability ------------------------------------------------------------------------------

#[test]
fn pointer_capability_requires_accessibility_and_a_display() {
    let granted = Rig::ready();
    assert_eq!(granted.input.available_scopes(NOW), vec!["pointer", "keyboard"]);
    let status = granted.input.status(NOW);
    assert!(status.pointer_ready && status.keyboard_available);

    let not_granted = Rig::new(PermissionState::NotGranted, vec![main_display()]);
    assert!(not_granted.input.available_scopes(NOW).is_empty());

    let no_display = Rig::new(PermissionState::Granted, vec![]);
    assert!(no_display.input.available_scopes(NOW).is_empty());

    let unsupported = NativeInput::new(Arc::new(UnsupportedBackend));
    assert!(unsupported.available_scopes(NOW).is_empty());
    assert_eq!(
        unsupported.status(NOW).accessibility,
        PermissionState::Unsupported
    );
}

#[test]
fn keyboard_capability_is_independent_but_requires_accessibility_and_a_display() {
    let ready = Rig::ready();
    assert_eq!(ready.input.available_scopes(NOW), vec!["pointer", "keyboard"]);

    let no_access = Rig::new(PermissionState::NotGranted, vec![main_display()]);
    assert!(!no_access.input.status(NOW).keyboard_available);

    let no_display = Rig::new(PermissionState::Granted, vec![]);
    assert!(!no_display.input.status(NOW).keyboard_available);

    let unsupported = NativeInput::new(Arc::new(UnsupportedBackend));
    assert!(!unsupported.status(NOW).keyboard_available);
}

#[test]
fn never_prompts_until_the_user_explicitly_requests_access() {
    let rig = Rig::new(PermissionState::NotGranted, vec![main_display()]);
    rig.input.status(NOW);
    rig.input.available_scopes(NOW);
    rig.input.refresh(NOW);
    assert_eq!(rig.backend.state.lock().unwrap().permission_requests, 0);
    let status = rig.input.request_accessibility(NOW);
    assert_eq!(rig.backend.state.lock().unwrap().permission_requests, 1);
    assert_eq!(status.accessibility, PermissionState::Granted);
    assert!(status.pointer_ready);
}

#[test]
fn a_single_display_is_selected_but_several_require_an_explicit_choice() {
    let single = Rig::ready();
    assert_eq!(single.input.status(NOW).selected_display_id, Some(1));

    let multi = Rig::new(
        PermissionState::Granted,
        vec![main_display(), display(2, 1920.0, 0.0, 2560.0, 1440.0)],
    );
    let status = multi.input.status(NOW);
    assert_eq!(status.selected_display_id, None);
    assert!(!status.pointer_ready);
    assert!(multi.input.available_scopes(NOW).is_empty());
    assert_eq!(status.displays.len(), 2);

    assert!(multi.input.select_display(99, NOW).is_err());
    let status = multi.input.select_display(2, NOW).unwrap();
    assert_eq!(status.selected_display_id, Some(2));
    assert!(status.pointer_ready);
    assert_eq!(multi.input.available_scopes(NOW), vec!["pointer", "keyboard"]);
}

#[test]
fn an_automatic_selection_is_dropped_when_a_second_display_appears() {
    let rig = Rig::ready();
    assert!(rig.input.status(NOW).pointer_ready);
    rig.backend
        .set_displays(vec![main_display(), display(2, 1920.0, 0.0, 1280.0, 720.0)]);
    let status = rig.input.refresh(NOW);
    assert_eq!(status.selected_display_id, None);
    assert!(!status.pointer_ready);
}

#[test]
fn an_explicit_selection_survives_a_second_display_being_added() {
    let rig = Rig::new(
        PermissionState::Granted,
        vec![main_display(), display(2, 1920.0, 0.0, 1280.0, 720.0)],
    );
    rig.input.select_display(1, NOW).unwrap();
    rig.backend.set_displays(vec![
        main_display(),
        display(2, 1920.0, 0.0, 1280.0, 720.0),
        display(3, 3200.0, 0.0, 800.0, 600.0),
    ]);
    assert_eq!(rig.input.refresh(NOW).selected_display_id, Some(1));
}

#[test]
fn never_exposes_display_topology_through_the_remote_capability() {
    let rig = Rig::ready();
    // The only remote-visible value is this list of scope names.
    assert_eq!(rig.input.available_scopes(NOW), vec!["pointer", "keyboard"]);
}

// ----- Mapping and event classification ---------------------------------------------------------

#[test]
fn maps_normalized_input_into_the_selected_display() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.run();
    assert_eq!(
        rig.backend.calls(),
        vec![Call::Move(MouseEventKind::Moved, 960.0, 540.0)]
    );
}

#[test]
fn maps_into_a_display_with_a_negative_origin() {
    let rig = Rig::new(
        PermissionState::Granted,
        vec![display(7, -2560.0, -200.0, 2560.0, 1440.0)],
    );
    rig.active();
    rig.send(&rig.mv(0.0, 0.0)).unwrap();
    rig.run();
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.run();
    assert_eq!(
        rig.backend.calls(),
        vec![
            Call::Move(MouseEventKind::Moved, -2560.0, -200.0),
            Call::Move(MouseEventKind::Moved, -1280.0, 520.0),
        ]
    );
}

#[test]
fn control_is_confined_to_the_explicitly_selected_display() {
    let rig = Rig::new(
        PermissionState::Granted,
        vec![main_display(), display(2, 1920.0, 0.0, 1000.0, 500.0)],
    );
    rig.input.select_display(2, NOW).unwrap();
    rig.active();
    rig.send(&rig.mv(1.0, 1.0)).unwrap();
    rig.run();
    assert_eq!(
        rig.backend.calls(),
        vec![Call::Move(MouseEventKind::Moved, 2919.0, 499.0)]
    );
}

#[test]
fn uses_fresh_display_bounds_after_a_resolution_change() {
    let rig = Rig::ready();
    rig.active();
    rig.backend
        .set_displays(vec![display(1, 0.0, 0.0, 1280.0, 720.0)]);
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.run();
    assert_eq!(
        rig.backend.calls(),
        vec![Call::Move(MouseEventKind::Moved, 640.0, 360.0)]
    );
}

#[test]
fn left_and_right_buttons_press_and_release() {
    let rig = Rig::ready();
    rig.active();
    for event in [
        rig.button("left", "down", 0.1, 0.1),
        rig.button("left", "up", 0.1, 0.1),
        rig.button("right", "down", 0.2, 0.2),
        rig.button("right", "up", 0.2, 0.2),
    ] {
        rig.send(&event).unwrap();
    }
    rig.run();
    let calls = rig.backend.calls();
    assert!(is_release(&calls[0], MouseEventKind::LeftDown));
    assert!(is_release(&calls[1], MouseEventKind::LeftUp));
    assert!(is_release(&calls[2], MouseEventKind::RightDown));
    assert!(is_release(&calls[3], MouseEventKind::RightUp));
    assert_eq!(calls.len(), 4);
}

#[test]
fn a_drag_sends_drag_events_between_down_and_up() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.button("left", "down", 0.1, 0.1)).unwrap();
    rig.send(&rig.mv(0.2, 0.2)).unwrap();
    rig.run();
    rig.send(&rig.mv(0.3, 0.3)).unwrap();
    rig.run();
    rig.send(&rig.button("left", "up", 0.3, 0.3)).unwrap();
    rig.send(&rig.mv(0.4, 0.4)).unwrap();
    rig.run();
    let kinds: Vec<_> = rig
        .backend
        .calls()
        .iter()
        .map(|call| match call {
            Call::Move(kind, ..) | Call::Button(kind, ..) => *kind,
            Call::Scroll(..) => unreachable!(),
        })
        .collect();
    assert_eq!(
        kinds,
        vec![
            MouseEventKind::LeftDown,
            MouseEventKind::LeftDragged,
            MouseEventKind::LeftDragged,
            MouseEventKind::LeftUp,
            MouseEventKind::Moved,
        ]
    );
}

#[test]
fn rapid_repeated_clicks_carry_an_increasing_click_count() {
    let rig = Rig::ready();
    rig.active();
    for _ in 0..2 {
        rig.send(&rig.button("left", "down", 0.5, 0.5)).unwrap();
        rig.send(&rig.button("left", "up", 0.5, 0.5)).unwrap();
    }
    rig.run();
    let counts: Vec<i64> = rig
        .backend
        .calls()
        .iter()
        .filter_map(|call| match call {
            Call::Button(_, _, _, count) => Some(*count),
            _ => None,
        })
        .collect();
    assert_eq!(counts, vec![1, 1, 2, 2]);
}

#[test]
fn scroll_is_converted_to_native_pixels() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.scroll(15.0, -120.0)).unwrap();
    rig.run();
    assert_eq!(rig.backend.calls(), vec![Call::Scroll(-15, 120)]);
}

#[test]
fn a_stray_release_does_not_become_a_click() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.button("left", "up", 0.5, 0.5)).unwrap();
    rig.run();
    assert!(rig.backend.calls().is_empty());
}

// ----- Authorization gate -----------------------------------------------------------------------

#[test]
fn nothing_executes_without_an_active_session() {
    let rig = Rig::ready();
    let event = rig.mv(0.5, 0.5);
    assert_eq!(rig.send(&event), Err(Denied::NoSession));
    rig.run();
    assert!(rig.backend.calls().is_empty());
}

#[test]
fn rejects_the_wrong_session_and_the_wrong_surface() {
    let rig = Rig::ready();
    rig.active();
    let mut wrong_session = json!({
        "type": "input-pointer-move", "protocolVersion": 1, "controlSessionId": OTHER,
        "surfaceId": SURFACE, "sequence": 1, "x": 0.5, "y": 0.5
    });
    let event: InputEvent = serde_json::from_value(wrong_session.clone()).unwrap();
    assert_eq!(rig.send(&event), Err(Denied::WrongSession));
    wrong_session["controlSessionId"] = json!(SESSION);
    wrong_session["surfaceId"] = json!(OTHER);
    let event: InputEvent = serde_json::from_value(wrong_session).unwrap();
    assert_eq!(rig.send(&event), Err(Denied::WrongSurface));
    rig.run();
    assert!(rig.backend.calls().is_empty());
}

#[test]
fn rejects_a_session_without_the_pointer_scope() {
    let rig = Rig::ready();
    rig.grant(false, NOW + 60_000);
    assert_eq!(rig.send(&rig.mv(0.5, 0.5)), Err(Denied::ScopeMissing));
    rig.run();
    assert!(rig.backend.calls().is_empty());
}

#[test]
fn keyboard_input_requires_its_own_scope_and_posts_supported_keys() {
    let rig = Rig::ready();
    rig.grant(true, NOW + 60_000);
    assert_eq!(rig.send(&rig.key("KeyA", "down")), Err(Denied::ScopeMissing));

    rig.grant_scopes(false, true, NOW + 60_000);
    rig.send(&rig.key("KeyA", "down")).unwrap();
    rig.send(&rig.key("KeyA", "up")).unwrap();
    rig.run();
    assert_eq!(
        rig.backend.calls(),
        vec![Call::Keyboard("KeyA".into(), true), Call::Keyboard("KeyA".into(), false)]
    );
}

#[test]
fn command_shortcuts_are_limited_and_held_keys_release_on_revoke() {
    let rig = Rig::ready();
    rig.grant_scopes(false, true, NOW + 60_000);
    rig.send(&rig.key("MetaLeft", "down")).unwrap();
    rig.send(&rig.key("KeyQ", "down")).unwrap();
    rig.send(&rig.key("KeyA", "down")).unwrap();
    rig.input.end_matching_session(SESSION, EndCause::Revoked);
    assert_eq!(
        rig.backend.calls(),
        vec![
            Call::Keyboard("MetaLeft".into(), true),
            Call::Keyboard("KeyA".into(), true),
            Call::Keyboard("KeyA".into(), false),
            Call::Keyboard("MetaLeft".into(), false),
        ]
    );
}

#[test]
fn rejects_invalid_events_even_if_constructed_directly() {
    let rig = Rig::ready();
    rig.active();
    let event: InputEvent = serde_json::from_value(json!({
        "type": "input-pointer-move", "protocolVersion": 1, "controlSessionId": SESSION,
        "surfaceId": SURFACE, "sequence": 1, "x": 3.0, "y": 0.5
    }))
    .unwrap();
    assert_eq!(rig.send(&event), Err(Denied::Invalid));
}

#[test]
fn ignores_duplicate_and_older_sequences() {
    let rig = Rig::ready();
    rig.active();
    let first = rig.mv(0.1, 0.1);
    let second = rig.mv(0.2, 0.2);
    rig.send(&second).unwrap();
    assert_eq!(rig.send(&second), Err(Denied::Stale));
    assert_eq!(rig.send(&first), Err(Denied::Stale));
}

#[test]
fn a_new_grant_does_not_honour_the_previous_grants_events() {
    let rig = Rig::ready();
    rig.active();
    let old = rig.mv(0.1, 0.1);
    rig.input.begin_session(
        SessionGrant {
            control_session_id: OTHER.into(),
            surface_id: SURFACE.into(),
            pointer: true,
            keyboard: false,
            expires_at_ms: NOW + 60_000,
        },
        NOW,
    );
    assert_eq!(rig.send(&old), Err(Denied::WrongSession));
    rig.run();
    assert!(rig.backend.calls().is_empty());
    assert_eq!(rig.ended(), vec![EndCause::Superseded]);
}

#[test]
fn rejects_input_after_expiry_and_ends_the_session() {
    let rig = Rig::ready();
    rig.grant(true, NOW + 1_000);
    let event = rig.mv(0.5, 0.5);
    assert_eq!(rig.send_at(&event, NOW + 1_000), Err(Denied::Expired));
    assert_eq!(rig.ended(), vec![EndCause::Expired]);
    assert_eq!(rig.send(&rig.mv(0.5, 0.5)), Err(Denied::NoSession));
}

#[test]
fn queued_input_is_dropped_if_the_session_expires_before_execution() {
    let rig = Rig::ready();
    rig.grant(true, NOW + 1_000);
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.input.process_pending(NOW + 5_000);
    assert!(rig.backend.calls().is_empty());
    assert_eq!(rig.ended(), vec![EndCause::Expired]);
}

#[test]
fn queued_input_is_dropped_after_revocation() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.send(&rig.scroll(0.0, 10.0)).unwrap();
    rig.input.end_matching_session(SESSION, EndCause::Revoked);
    rig.run();
    assert!(rig.backend.calls().is_empty());
}

#[test]
fn revoking_some_other_session_changes_nothing() {
    let rig = Rig::ready();
    rig.active();
    rig.input.end_matching_session(OTHER, EndCause::Revoked);
    assert!(rig.send(&rig.mv(0.5, 0.5)).is_ok());
}

// ----- Backpressure and rate limiting -----------------------------------------------------------

#[test]
fn coalesces_movement_to_the_newest_position() {
    let rig = Rig::ready();
    rig.active();
    for step in 1..=50 {
        rig.send(&rig.mv(f64::from(step) / 100.0, 0.5)).unwrap();
    }
    assert_eq!(rig.run(), 1);
    assert_eq!(
        rig.backend.calls(),
        vec![Call::Move(MouseEventKind::Moved, 0.5 * 1920.0, 540.0)]
    );
}

#[test]
fn a_coalesced_move_never_overtakes_an_older_button_action() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.button("left", "down", 0.1, 0.1)).unwrap();
    rig.send(&rig.mv(0.9, 0.9)).unwrap();
    rig.send(&rig.button("left", "up", 0.9, 0.9)).unwrap();
    rig.run();
    let calls = rig.backend.calls();
    assert!(is_release(&calls[0], MouseEventKind::LeftDown));
    assert!(is_move(&calls[1], MouseEventKind::LeftDragged));
    assert!(is_release(&calls[2], MouseEventKind::LeftUp));
    assert_eq!(calls.len(), 3);
}

#[test]
fn flooding_is_rate_limited_but_a_release_always_gets_through() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.button("left", "down", 0.5, 0.5)).unwrap();
    let mut denied = 0;
    for _ in 0..(MAX_EVENTS_PER_SECOND * 2) {
        if rig.send(&rig.scroll(0.0, 1.0)) == Err(Denied::RateLimited) {
            denied += 1;
        }
    }
    assert!(denied > 0);
    assert!(rig.send(&rig.button("left", "up", 0.5, 0.5)).is_ok());
    // A new window restores normal service.
    assert!(rig.send_at(&rig.scroll(0.0, 1.0), NOW + 1_500).is_ok());
}

#[test]
fn the_action_queue_is_bounded_but_reserves_room_for_releases() {
    let rig = Rig::ready();
    rig.grant(true, u64::MAX / 2);
    let mut full = false;
    for index in 0..(MAX_QUEUED_ACTIONS + 10) {
        // Spread across rate-limit windows so only the queue bound is under test.
        let result = rig.send_at(&rig.scroll(0.0, 1.0), NOW + index as u64 * 10_000);
        if result == Err(Denied::QueueFull) {
            full = true;
            break;
        }
    }
    assert!(full);
    assert!(rig
        .send_at(&rig.button("left", "up", 0.5, 0.5), NOW + 5_000_000)
        .is_ok());
}

// ----- Stuck-button safety ----------------------------------------------------------------------

fn hold_left(rig: &Rig) {
    rig.active();
    rig.send(&rig.button("left", "down", 0.25, 0.25)).unwrap();
    rig.run();
    rig.backend.clear_calls();
}

fn assert_released(rig: &Rig) {
    let calls = rig.backend.calls();
    assert_eq!(
        calls.len(),
        1,
        "expected exactly one release, got {calls:?}"
    );
    assert!(is_release(&calls[0], MouseEventKind::LeftUp));
}

#[test]
fn releases_held_buttons_on_revoke() {
    let rig = Rig::ready();
    hold_left(&rig);
    rig.input.end_matching_session(SESSION, EndCause::Revoked);
    assert_released(&rig);
}

#[test]
fn releases_held_buttons_on_disconnect() {
    let rig = Rig::ready();
    hold_left(&rig);
    rig.input.end_session(EndCause::Disconnected);
    assert_released(&rig);
}

#[test]
fn releases_held_buttons_on_expiry() {
    let rig = Rig::ready();
    hold_left(&rig);
    rig.input.end_session(EndCause::Expired);
    assert_released(&rig);
}

#[test]
fn releases_held_buttons_on_local_stop_and_reports_the_session() {
    let rig = Rig::ready();
    hold_left(&rig);
    assert_eq!(rig.input.stop_control().as_deref(), Some(SESSION));
    assert_released(&rig);
    assert_eq!(rig.ended(), vec![EndCause::LocalStop]);
    assert_eq!(rig.send(&rig.mv(0.5, 0.5)), Err(Denied::NoSession));
    assert_eq!(rig.input.stop_control(), None);
}

#[test]
fn releases_held_buttons_on_shutdown() {
    let rig = Rig::ready();
    hold_left(&rig);
    rig.input.shutdown();
    assert_released(&rig);
}

#[test]
fn releases_held_buttons_when_accessibility_is_lost() {
    let rig = Rig::ready();
    hold_left(&rig);
    rig.backend.set_permission(PermissionState::NotGranted);
    let status = rig.input.refresh(NOW);
    assert!(!status.pointer_ready);
    assert_released(&rig);
    assert_eq!(rig.ended(), vec![EndCause::PermissionLost]);
}

#[test]
fn releases_held_buttons_when_the_display_disappears() {
    let rig = Rig::ready();
    hold_left(&rig);
    rig.backend.set_displays(vec![]);
    rig.input.refresh(NOW);
    assert_released(&rig);
    assert_eq!(rig.ended(), vec![EndCause::DisplayLost]);
}

#[test]
fn releases_every_held_button_and_leaves_none_pressed() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.button("left", "down", 0.1, 0.1)).unwrap();
    rig.send(&rig.button("right", "down", 0.1, 0.1)).unwrap();
    rig.run();
    rig.backend.clear_calls();
    rig.input.release_all();
    let calls = rig.backend.calls();
    assert_eq!(calls.len(), 2);
    assert!(is_release(&calls[0], MouseEventKind::RightUp));
    assert!(is_release(&calls[1], MouseEventKind::LeftUp));
    rig.backend.clear_calls();
    rig.input.release_all();
    assert!(rig.backend.calls().is_empty());
}

#[test]
fn changing_the_selected_display_during_control_ends_the_session() {
    let rig = Rig::new(
        PermissionState::Granted,
        vec![main_display(), display(2, 1920.0, 0.0, 1000.0, 500.0)],
    );
    rig.input.select_display(1, NOW).unwrap();
    hold_left(&rig);
    rig.input.select_display(2, NOW).unwrap();
    assert_released(&rig);
    assert_eq!(rig.ended(), vec![EndCause::DisplayLost]);
    assert_eq!(rig.send(&rig.mv(0.5, 0.5)), Err(Denied::NoSession));
}

// ----- Permission loss at execution time --------------------------------------------------------

#[test]
fn access_denied_while_posting_ends_control_and_is_not_retried() {
    let rig = Rig::ready();
    rig.active();
    rig.backend.fail_with(Some(InputError::AccessDenied));
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.run();
    assert_eq!(rig.ended(), vec![EndCause::PermissionLost]);
    rig.backend.fail_with(None);
    assert!(rig.backend.calls().is_empty());
    assert_eq!(rig.send(&rig.mv(0.6, 0.6)), Err(Denied::NoSession));
}

#[test]
fn accessibility_revoked_between_enqueue_and_execution_is_caught_at_execution() {
    let rig = Rig::ready();
    rig.active();
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.backend.set_permission(PermissionState::NotGranted);
    // Beyond the cached-permission interval, so the worker re-checks.
    rig.input.process_pending(NOW + 1_000);
    assert!(rig.backend.calls().is_empty());
    assert_eq!(rig.ended(), vec![EndCause::PermissionLost]);
}

#[test]
fn a_generic_post_failure_drops_the_event_without_ending_control() {
    let rig = Rig::ready();
    rig.active();
    rig.backend.fail_with(Some(InputError::Failed));
    rig.send(&rig.mv(0.5, 0.5)).unwrap();
    rig.run();
    assert!(rig.ended().is_empty());
    rig.backend.fail_with(None);
    rig.send(&rig.mv(0.6, 0.6)).unwrap();
    rig.run();
    assert_eq!(rig.backend.calls().len(), 1);
}

#[test]
fn a_failed_release_stays_tracked_so_release_all_can_retry() {
    let rig = Rig::ready();
    hold_left(&rig);
    rig.backend.fail_with(Some(InputError::Failed));
    rig.send(&rig.button("left", "up", 0.25, 0.25)).unwrap();
    rig.run();
    rig.backend.fail_with(None);
    rig.input.release_all();
    assert_released(&rig);
}

#[test]
fn input_is_refused_when_capability_disappears_before_the_next_event() {
    let rig = Rig::ready();
    rig.active();
    rig.backend.set_permission(PermissionState::NotGranted);
    rig.input.refresh(NOW);
    assert_eq!(rig.send(&rig.mv(0.5, 0.5)), Err(Denied::NoSession));
}

// ----- Events -----------------------------------------------------------------------------------

#[test]
fn announces_status_changes_without_a_lock_held() {
    let rig = Rig::new(PermissionState::NotGranted, vec![main_display()]);
    rig.events.lock().unwrap().clear();
    rig.backend.set_permission(PermissionState::Granted);
    rig.input.refresh(NOW);
    assert!(rig
        .events
        .lock()
        .unwrap()
        .contains(&NativeEvent::StatusChanged));
    rig.events.lock().unwrap().clear();
    rig.input.refresh(NOW);
    assert!(rig.events.lock().unwrap().is_empty(), "no change, no event");
}

#[test]
fn only_local_and_capability_endings_ask_the_browser_to_revoke() {
    for cause in [
        EndCause::LocalStop,
        EndCause::PermissionLost,
        EndCause::DisplayLost,
    ] {
        assert!(cause.needs_browser_revoke());
    }
    for cause in [
        EndCause::Expired,
        EndCause::Revoked,
        EndCause::Superseded,
        EndCause::Disconnected,
        EndCause::Shutdown,
    ] {
        assert!(!cause.needs_browser_revoke());
    }
}
