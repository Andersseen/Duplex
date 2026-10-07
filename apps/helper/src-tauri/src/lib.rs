//! Duplex helper. Intentionally registers no commands: the helper does not yet accept
//! any input, and OS input injection will only be added behind explicit, scoped consent.

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the Duplex helper");
}
