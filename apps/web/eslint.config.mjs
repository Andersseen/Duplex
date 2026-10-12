import { angularConfig } from '@duplex/config/eslint-angular';

export default [{ ignores: ['public/docs/**'] }, ...angularConfig(import.meta.dirname)];
