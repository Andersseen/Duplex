//! Duplex helper: temporary control-session bridge with native macOS pointer control.

mod bridge;
mod input;
mod pairing;
mod protocol;

pub fn run() {
    let native = input::NativeInput::platform_default();
    native.spawn_worker();
    let app = tauri::Builder::default()
        .manage(bridge::HelperBridge::new(native.clone()))
        .invoke_handler(tauri::generate_handler![
            bridge::connect_helper,
            bridge::disconnect_helper,
            bridge::get_native_input_status,
            bridge::list_displays,
            bridge::select_display,
            bridge::request_accessibility,
            bridge::refresh_accessibility_status,
            bridge::stop_control
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Duplex helper");
    app.run(move |_, event| {
        if let tauri::RunEvent::Exit = event {
            // Never leave a mouse button held when the helper quits.
            native.shutdown();
        }
    });
}
