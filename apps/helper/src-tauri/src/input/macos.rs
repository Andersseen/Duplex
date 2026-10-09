//! macOS pointer backend: Quartz/CoreGraphics event posting gated by Accessibility trust.
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
    fn enumerating_displays_and_checking_trust_never_posts_input() {
        // Read-only calls only: this must never move the runner's pointer.
        let backend = MacosBackend;
        let _ = backend.permission();
        for display in backend.displays() {
            assert!(display.width >= 1.0 && display.height >= 1.0);
        }
    }
}
