//! Platform-independent pointer geometry and event classification.
//!
//! Everything here is pure so it can be unit tested on any CI runner without touching the OS.

/// Smallest unit of travel (in points) a click may drift and still count as the same double click.
const DOUBLE_CLICK_DISTANCE: f64 = 6.0;
const DOUBLE_CLICK_INTERVAL_MS: u64 = 500;
const MAX_CLICK_COUNT: i64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PointerButton {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonState {
    Down,
    Up,
}

/// An active display in the native global coordinate space (points, not pixels).
///
/// The origin may be negative or non-zero: the primary display does not necessarily start at 0,0.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayTarget {
    pub id: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub width: f64,
    pub height: f64,
}

impl DisplayTarget {
    /// Map normalized `0..=1` coordinates to a global point, clamped inside this display.
    ///
    /// The result is kept at least one point inside the far edges so it can never land on a
    /// neighbouring display that begins exactly where this one ends.
    pub fn map_normalized(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.origin_x + clamp_unit(x) * self.width,
            self.origin_y + clamp_unit(y) * self.height,
        )
            .clamped_to(self)
    }
}

trait ClampedTo {
    fn clamped_to(self, display: &DisplayTarget) -> (f64, f64);
}

impl ClampedTo for (f64, f64) {
    fn clamped_to(self, display: &DisplayTarget) -> (f64, f64) {
        let max_x = display.origin_x + (display.width - 1.0).max(0.0);
        let max_y = display.origin_y + (display.height - 1.0).max(0.0);
        (
            self.0.clamp(display.origin_x, max_x),
            self.1.clamp(display.origin_y, max_y),
        )
    }
}

fn clamp_unit(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Which native mouse event a pointer action becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventKind {
    Moved,
    LeftDown,
    LeftUp,
    RightDown,
    RightUp,
    LeftDragged,
    RightDragged,
}

impl MouseEventKind {
    /// Motion while a button is held is a drag event of that button, otherwise plain movement.
    pub fn for_move(held: Option<PointerButton>) -> Self {
        match held {
            Some(PointerButton::Left) => Self::LeftDragged,
            Some(PointerButton::Right) => Self::RightDragged,
            None => Self::Moved,
        }
    }

    pub fn for_button(button: PointerButton, state: ButtonState) -> Self {
        match (button, state) {
            (PointerButton::Left, ButtonState::Down) => Self::LeftDown,
            (PointerButton::Left, ButtonState::Up) => Self::LeftUp,
            (PointerButton::Right, ButtonState::Down) => Self::RightDown,
            (PointerButton::Right, ButtonState::Up) => Self::RightUp,
        }
    }
}

/// Convert a logical browser scroll delta into native pixel units.
///
/// Browsers report positive `deltaY` for "scroll down" and positive `deltaX` for "scroll right";
/// Quartz scroll-wheel events use the opposite sign on both axes.
pub fn scroll_to_native(delta: f64) -> i32 {
    if !delta.is_finite() {
        return 0;
    }
    (-delta)
        .round()
        .clamp(-(super::MAX_SCROLL_DELTA), super::MAX_SCROLL_DELTA) as i32
}

/// Derives the click count macOS needs to recognise double and triple clicks.
#[derive(Debug, Default)]
pub struct ClickTracker {
    last: Option<(PointerButton, u64, f64, f64, i64)>,
    current: i64,
}

impl ClickTracker {
    pub fn on_down(&mut self, button: PointerButton, x: f64, y: f64, now_ms: u64) -> i64 {
        let count = match self.last {
            Some((last_button, at, last_x, last_y, last_count))
                if last_button == button
                    && now_ms.saturating_sub(at) <= DOUBLE_CLICK_INTERVAL_MS
                    && (x - last_x).abs() <= DOUBLE_CLICK_DISTANCE
                    && (y - last_y).abs() <= DOUBLE_CLICK_DISTANCE =>
            {
                (last_count + 1).min(MAX_CLICK_COUNT)
            }
            _ => 1,
        };
        self.last = Some((button, now_ms, x, y, count));
        self.current = count;
        count
    }

    /// The matching `up` carries the same click count as its `down`.
    pub fn on_up(&self) -> i64 {
        self.current.max(1)
    }

    pub fn reset(&mut self) {
        self.last = None;
        self.current = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(origin_x: f64, origin_y: f64, width: f64, height: f64) -> DisplayTarget {
        DisplayTarget {
            id: 1,
            origin_x,
            origin_y,
            width,
            height,
        }
    }

    #[test]
    fn maps_normalized_points_onto_a_display_at_the_origin() {
        let target = display(0.0, 0.0, 1920.0, 1080.0);
        assert_eq!(target.map_normalized(0.0, 0.0), (0.0, 0.0));
        assert_eq!(target.map_normalized(0.5, 0.5), (960.0, 540.0));
        // The far edge stays one point inside the display.
        assert_eq!(target.map_normalized(1.0, 1.0), (1919.0, 1079.0));
    }

    #[test]
    fn supports_negative_and_non_zero_origins() {
        let left = display(-2560.0, -200.0, 2560.0, 1440.0);
        assert_eq!(left.map_normalized(0.0, 0.0), (-2560.0, -200.0));
        assert_eq!(left.map_normalized(0.5, 0.5), (-1280.0, 520.0));
        assert_eq!(left.map_normalized(1.0, 1.0), (-1.0, 1239.0));
        let above = display(100.0, -1080.0, 1920.0, 1080.0);
        let (x, y) = above.map_normalized(0.25, 0.75);
        assert_eq!((x, y), (580.0, -270.0));
    }

    #[test]
    fn clamps_out_of_range_and_non_finite_input() {
        let target = display(-100.0, 50.0, 200.0, 100.0);
        assert_eq!(target.map_normalized(-5.0, 9.0), (-100.0, 149.0));
        assert_eq!(
            target.map_normalized(f64::NAN, f64::INFINITY),
            (-100.0, 50.0)
        );
        let degenerate = display(10.0, 10.0, 0.0, 0.0);
        assert_eq!(degenerate.map_normalized(0.5, 0.5), (10.0, 10.0));
    }

    #[test]
    fn classifies_motion_buttons_and_drags() {
        assert_eq!(MouseEventKind::for_move(None), MouseEventKind::Moved);
        assert_eq!(
            MouseEventKind::for_move(Some(PointerButton::Left)),
            MouseEventKind::LeftDragged
        );
        assert_eq!(
            MouseEventKind::for_move(Some(PointerButton::Right)),
            MouseEventKind::RightDragged
        );
        assert_eq!(
            MouseEventKind::for_button(PointerButton::Right, ButtonState::Down),
            MouseEventKind::RightDown
        );
        assert_eq!(
            MouseEventKind::for_button(PointerButton::Left, ButtonState::Up),
            MouseEventKind::LeftUp
        );
    }

    #[test]
    fn converts_browser_scroll_to_native_pixels_with_inverted_sign() {
        assert_eq!(scroll_to_native(120.0), -120);
        assert_eq!(scroll_to_native(-40.4), 40);
        assert_eq!(scroll_to_native(f64::NAN), 0);
        assert_eq!(
            scroll_to_native(1.0e9),
            -(super::super::MAX_SCROLL_DELTA as i32)
        );
    }

    #[test]
    fn counts_rapid_nearby_clicks_as_double_and_triple_clicks() {
        let mut clicks = ClickTracker::default();
        assert_eq!(clicks.on_down(PointerButton::Left, 100.0, 100.0, 1_000), 1);
        assert_eq!(clicks.on_down(PointerButton::Left, 102.0, 99.0, 1_200), 2);
        assert_eq!(clicks.on_up(), 2);
        assert_eq!(clicks.on_down(PointerButton::Left, 102.0, 99.0, 1_300), 3);
        assert_eq!(clicks.on_down(PointerButton::Left, 102.0, 99.0, 1_400), 3);
        // Too slow, too far or a different button starts over.
        assert_eq!(clicks.on_down(PointerButton::Left, 102.0, 99.0, 2_000), 1);
        assert_eq!(clicks.on_down(PointerButton::Left, 300.0, 99.0, 2_100), 1);
        assert_eq!(clicks.on_down(PointerButton::Right, 300.0, 99.0, 2_200), 1);
    }
}
