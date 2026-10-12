// The readable call route is canonical. Keep the implementation in one place
// so the legacy /r/:roomId route can continue serving links already shared.
export { default } from './r.[roomId].page';
