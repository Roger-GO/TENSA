import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import noDestructiveToken from './eslint-rules/no-destructive-token.js';

// Local plugin housing repo-specific rules (Unit 10: the destructive→danger
// token guard). Registered as the `andes` namespace below.
const andesPlugin = {
  rules: {
    'no-destructive-token': noDestructiveToken,
  },
};

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'src/api/generated.ts', 'coverage'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      andes: andesPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Unit 10: guard against re-introducing the dead `destructive` Tailwind
      // token (the theme only defines `danger`). See eslint-rules/.
      'andes/no-destructive-token': 'error',
    },
  },
  {
    // The rule's own guard test embeds `bg-destructive` fixture strings as
    // intentional negative cases. Disable the guard there so the fixtures —
    // which are RuleTester `code` payloads, not real classNames — don't trip
    // the very rule they exercise.
    files: ['tests/unit/lint/no-destructive-token.test.ts'],
    rules: {
      'andes/no-destructive-token': 'off',
    },
  },
);
