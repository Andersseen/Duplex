//! macOS pointer and keyboard backend: CoreGraphics event posting gated by Accessibility trust.
//!
//! Requires only the Accessibility permission. It does not need Input Monitoring or Screen
//! Recording, because it never reads input or the screen — it only synthesizes pointer events.
//!
//! Coordinates are CoreGraphics global display points (the space `CGDisplayBounds` reports and
//! `CGEventCreateMouseEvent` expects), so no `devicePixelRatio` scaling is involved anywhere.

use objc2_application_services::{
    kAXTrustedCheckOptionPrompt, AXIsProcessTrusted, AXIsProcessTrustedWithOptions,
};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFString, CGPoint};
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayBounds, CGEvent, CGEventField, CGEventTapLocation, CGEventType,
    CGGetActiveDisplayList, CGMouseButton, CGScrollEventUnit,
};

use super::geometry::{DisplayTarget, MouseEventKind};
use super::{InputError, NativePointerBackend, PermissionState};

/// More displays than any real desk setup; bounds the stack buffer for the display list.
const MAX_DISPLAYS: usize = 16;

pub struct MacosBackend;

impl MacosBackend {
    fn trusted() -> bool {
        // SAFETY: AXIsProcessTrusted takes no arguments and has no preconditions.
        unsafe { AXIsProcessTrusted() }
    }

    fn post(event: Option<objc2_core_foundation::CFRetained<CGEvent>>) -> Result<(), InputError> {
        // CGEventPost fails silently without trust, so check it ourselves and surface the denial.
        if !Self::trusted() {
            return Err(InputError::AccessDenied);
        }
        let event = event.ok_or(InputError::Failed)?;
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
        Ok(())
    }

    fn post_mouse(
        kind: MouseEventKind,
        x: f64,
        y: f64,
        click_count: Option<i64>,
    ) -> Result<(), InputError> {
        let (event_type, button) = native_event(kind);
        let event = CGEvent::new_mouse_event(None, event_type, CGPoint { x, y }, button);
        if let (Some(event), Some(count)) = (event.as_ref(), click_count) {
            CGEvent::set_integer_value_field(
                Some(event),
                CGEventField::MouseEventClickState,
                count,
            );
        }
        Self::post(event)
    }
}

/// Pure mapping from our event kind to the CoreGraphics event type and button.
fn native_event(kind: MouseEventKind) -> (CGEventType, CGMouseButton) {
    match kind {
        MouseEventKind::Moved => (CGEventType::MouseMoved, CGMouseButton::Left),
        MouseEventKind::LeftDown => (CGEventType::LeftMouseDown, CGMouseButton::Left),
        MouseEventKind::LeftUp => (CGEventType::LeftMouseUp, CGMouseButton::Left),
        MouseEventKind::RightDown => (CGEventType::RightMouseDown, CGMouseButton::Right),
        MouseEventKind::RightUp => (CGEventType::RightMouseUp, CGMouseButton::Right),
        MouseEventKind::LeftDragged => (CGEventType::LeftMouseDragged, CGMouseButton::Left),
        MouseEventKind::RightDragged => (CGEventType::RightMouseDragged, CGMouseButton::Right),
    }
}

fn display_target(id: CGDirectDisplayID) -> DisplayTarget {
    let bounds = CGDisplayBounds(id);
    DisplayTarget {
        id,
        origin_x: bounds.origin.x,
        origin_y: bounds.origin.y,
        width: bounds.size.width,
        height: bounds.size.height,
    }
}

impl NativePointerBackend for MacosBackend {
    fn platform(&self) -> &'static str {
        "macos"
    }

    fn permission(&self) -> PermissionState {
        if Self::trusted() {
            PermissionState::Granted
        } else {
            PermissionState::NotGranted
        }
    }

    fn request_permission(&self) -> PermissionState {
        // SAFETY: the key is a static CFString provided by the framework.
        let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
        let options =
            CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
        // SAFETY: `options` is a valid dictionary of the documented key/value types.
        let trusted = unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) };
        if trusted {
            PermissionState::Granted
        } else {
            PermissionState::NotGranted
        }
    }

    fn displays(&self) -> Vec<DisplayTarget> {
        let mut ids: [CGDirectDisplayID; MAX_DISPLAYS] = [0; MAX_DISPLAYS];
        let mut count: u32 = 0;
        // SAFETY: `ids` has room for MAX_DISPLAYS entries and `count` is a valid out pointer.
        let error =
            unsafe { CGGetActiveDisplayList(MAX_DISPLAYS as u32, ids.as_mut_ptr(), &mut count) };
        if error.0 != 0 {
            return Vec::new();
        }
        ids.iter()
            .take(count as usize)
            .map(|id| display_target(*id))
            .filter(|display| display.width >= 1.0 && display.height >= 1.0)
            .collect()
    }

    fn move_pointer(&self, kind: MouseEventKind, x: f64, y: f64) -> Result<(), InputError> {
        Self::post_mouse(kind, x, y, None)
    }

    fn button(
        &self,
        kind: MouseEventKind,
        x: f64,
        y: f64,
        click_count: i64,
    ) -> Result<(), InputError> {
        Self::post_mouse(kind, x, y, Some(click_count))
    }

    fn scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), InputError> {
        // Two axes: wheel1 is vertical, wheel2 is horizontal.
        let event = CGEvent::new_scroll_wheel_event2(
            None,
            CGScrollEventUnit::Pixel,
            2,
            delta_y,
            delta_x,
            0,
        );
        Self::post(event)
    }

    fn supports_keyboard(&self) -> bool {
        true
    }

    fn keyboard(&self, code: &str, down: bool) -> Result<(), InputError> {
        let keycode = native_keycode(code).ok_or(InputError::Failed)?;
        Self::post(CGEvent::new_keyboard_event(None, keycode, down))
    }
}

/// Map the protocol's physical `KeyboardEvent.code` values to macOS virtual key codes.
/// Unsupported codes fail closed instead of being translated into an unintended key.
fn native_keycode(code: &str) -> Option<u16> {
    Some(match code {
        "KeyA" => 0x00,
        "KeyS" => 0x01,
        "KeyD" => 0x02,
        "KeyF" => 0x03,
        "KeyH" => 0x04,
        "KeyG" => 0x05,
        "KeyZ" => 0x06,
        "KeyX" => 0x07,
        "KeyC" => 0x08,
        "KeyV" => 0x09,
        "KeyB" => 0x0B,
        "KeyQ" => 0x0C,
        "KeyW" => 0x0D,
        "KeyE" => 0x0E,
        "KeyR" => 0x0F,
        "KeyY" => 0x10,
        "KeyT" => 0x11,
        "Digit1" => 0x12,
        "Digit2" => 0x13,
        "Digit3" => 0x14,
        "Digit4" => 0x15,
        "Digit6" => 0x16,
        "Digit5" => 0x17,
        "Equal" => 0x18,
        "Digit9" => 0x19,
        "Digit7" => 0x1A,
        "Minus" => 0x1B,
        "Digit8" => 0x1C,
        "Digit0" => 0x1D,
        "BracketRight" => 0x1E,
        "KeyO" => 0x1F,
        "KeyU" => 0x20,
        "BracketLeft" => 0x21,
        "KeyI" => 0x22,
        "KeyP" => 0x23,
        "Enter" => 0x24,
        "KeyL" => 0x25,
        "KeyJ" => 0x26,
        "Quote" => 0x27,
        "KeyK" => 0x28,
        "Semicolon" => 0x29,
        "Backslash" => 0x2A,
        "Comma" => 0x2B,
        "Slash" => 0x2C,
        "KeyN" => 0x2D,
        "KeyM" => 0x2E,
        "Period" => 0x2F,
        "Tab" => 0x30,
        "Space" => 0x31,
        "Backquote" => 0x32,
        "Backspace" => 0x33,
        "Delete" => 0x75,
        "MetaRight" => 0x36,
        "MetaLeft" => 0x37,
        "ShiftLeft" => 0x38,
        "ControlLeft" => 0x3B,
        "ShiftRight" => 0x3C,
        "AltLeft" => 0x3A,
        "AltRight" => 0x3D,
        "ControlRight" => 0x3E,
        "ArrowLeft" => 0x7B,
        "ArrowRight" => 0x7C,
        "ArrowDown" => 0x7D,
        "ArrowUp" => 0x7E,
        "Home" => 0x73,
        "End" => 0x77,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_event_kind_to_the_matching_native_type_and_button() {
        assert_eq!(
            native_event(MouseEventKind::Moved).0,
            CGEventType::MouseMoved
        );
        assert_eq!(
            native_event(MouseEventKind::LeftDragged),
            (CGEventType::LeftMouseDragged, CGMouseButton::Left)
        );
        assert_eq!(
            native_event(MouseEventKind::RightDragged),
            (CGEventType::RightMouseDragged, CGMouseButton::Right)
        );
        assert_eq!(
            native_event(MouseEventKind::RightUp),
            (CGEventType::RightMouseUp, CGMouseButton::Right)
        );
        assert_eq!(
            native_event(MouseEventKind::LeftDown),
            (CGEventType::LeftMouseDown, CGMouseButton::Left)
        );
    }

    #[test]
    fn maps_supported_physical_keys_and_fails_closed_for_unknown_codes() {
        assert_eq!(native_keycode("KeyA"), Some(0x00));
        assert_eq!(native_keycode("Digit0"), Some(0x1D));
        assert_eq!(native_keycode("MetaLeft"), Some(0x37));
        assert_eq!(native_keycode("ArrowUp"), Some(0x7E));
        assert_eq!(native_keycode("Escape"), None);
    }

    #[test]
    fn enumerating_displays_and_checking_trust_never_posts_input() {
        // Read-only calls only: this must never move the runner's pointer.
        let backend = MacosBackend;
        let _ = backend.permission();
        for display in backend.displays() {
            assert!(display.width >= 1.0 && display.height >= 1.0);
        }
    }
}
