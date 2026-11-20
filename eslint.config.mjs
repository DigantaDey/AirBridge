import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-bin/**',
      'build/**',
      'node_modules/**',
      'android/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'src/server/**/*.ts',
      'src/shared/**/*.ts',
      'bin/**/*.mjs',
      'packaging/**/*.ts',
      'scripts/**/*.mjs',
      'scripts/**/*.ts',
      'vite.config.ts',
      'eslint.config.mjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['scripts/build-desktop.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        Bun: 'readonly',
      },
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        __AIRBRIDGE_UI_VERSION__: 'readonly',
      },
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
);
