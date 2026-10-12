---
type: state
---

# Current State

## Implemented

- The landing route is `/`; starting a call navigates to the canonical `/call/:roomId` route.
- The legacy `/r/:roomId` route remains available for previously shared links.
- Browser calls support audio, optional camera, screen sharing, peer-to-peer file transfer and shared-screen collaboration.
- Assist is consent-based, scoped and expiring. The native helper is experimental and macOS-only for pointer, keyboard and clipboard control.
- Signaling runs in a Cloudflare Worker with a `CallRoom` Durable Object. Media and data use WebRTC, with STUN/TURN configuration supplied by the Worker.
- The web application uses Angular 22, Analog SSR, zoneless change detection and Volt UI atoms. Application-specific behavior remains in services and room panels.
- Entwine compiles `docs/` into static documentation, a graph and structured agent context. Agent instructions and skills are discoverable but are not published by default.

## In progress

- Production Cloudflare deployment is configured in local scripts and GitHub Actions, but a real deployment still depends on the repository's Cloudflare credentials and production variables.
- Native Assist remains experimental and requires manual macOS verification.

## Known limitations

- Rooms are anonymous bearer links and support at most two participants.
- Windows and Linux native control are not implemented.
- Files are transferred peer-to-peer and cannot resume after disconnect.
- No accounts, persistent pairing, unattended access or persistent room records exist.
