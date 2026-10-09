fn main() {
    // Only these app commands exist as permissions; the capability file grants each by name.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connect_helper",
            "disconnect_helper",
            "get_native_input_status",
            "list_displays",
            "select_display",
            "request_accessibility",
            "refresh_accessibility_status",
            "stop_control",
        ]),
    ))
    .expect("failed to run tauri-build");
}
