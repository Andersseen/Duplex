/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DUPLEX_API_ORIGIN?: string;
  /** Development-only switch used by the opt-in TURN E2E run. */
  readonly VITE_DUPLEX_FORCE_RELAY?: string;
}
