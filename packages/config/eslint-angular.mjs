import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';
import { baseConfig } from './eslint.mjs';

/** Flat config for Angular workspaces: base rules plus angular-eslint for TS and templates. */
export function angularConfig(tsconfigRootDir) {
  return tseslint.config(
    ...baseConfig(tsconfigRootDir),
    {
      files: ['**/*.ts'],
      extends: [...angular.configs.tsRecommended],
      processor: angular.processInlineTemplates,
      rules: {
        '@angular-eslint/prefer-on-push-component-change-detection': 'error',
        '@angular-eslint/prefer-standalone': 'error',
        '@angular-eslint/directive-selector': [
          'error',
          { type: 'attribute', prefix: 'dx', style: 'camelCase' },
        ],
        '@angular-eslint/component-selector': [
          'error',
          { type: 'element', prefix: 'dx', style: 'kebab-case' },
        ],
      },
    },
    {
      files: ['src/**/*.html'],
      extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    },
  );
}
