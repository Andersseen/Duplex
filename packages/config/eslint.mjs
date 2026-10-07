import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Base flat config for every TypeScript workspace.
 * `tsconfigRootDir` must be the importing package's directory.
 */
export function baseConfig(tsconfigRootDir) {
  return tseslint.config(
    { ignores: ['dist/**', '.angular/**', '.output/**', '.wrangler/**', 'coverage/**'] },
    eslint.configs.recommended,
    ...[...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked].map(
      (config) => ({ ...config, files: ['**/*.ts'] }),
    ),
    {
      files: ['**/*.ts'],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      },
    },
    {
      files: ['**/*.mjs', '**/*.js'],
      extends: [tseslint.configs.disableTypeChecked],
    },
  );
}
