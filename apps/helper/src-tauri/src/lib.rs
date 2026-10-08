//! Duplex helper session control. Native OS input is intentionally not implemented.

mod bridge;
mod pairing;
mod protocol;

pub fn run() {
    tauri::Builder::default()
        .manage(bridge::HelperBridge::default())
        .invoke_handler(tauri::generate_handler![
            bridge::connect_helper,
            bridge::disconnect_helper
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Duplex helper");
}
