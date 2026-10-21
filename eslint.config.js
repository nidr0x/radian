import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

/**
 * Cloudflare Workers runtime globals for functions/ (no DOM). tsc does not enforce
 * no-undef, so this map documents which runtime identifiers functions/ is allowed to
 * reference; browser-only identifiers are additionally forbidden by `no-restricted-globals`
 * in the functions block below instead of a per-line disable.
 */
const workerRuntimeGlobals = {
  console: 'readonly',
  crypto: 'readonly',
  caches: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  AbortSignal: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  TransformStream: 'readonly',
  structuredClone: 'readonly',
  queueMicrotask: 'readonly',
  Blob: 'readonly',
  FormData: 'readonly',
};

/** Identifiers that only exist in browsers and would be undefined on the Workers runtime. */
const browserOnlyGlobals = [
  'window', 'document', 'navigator', 'location', 'history', 'alert', 'confirm', 'prompt',
  'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame',
  'matchMedia', 'serviceWorker',
];

/**
 * `no-unused-vars` is handled by TypeScript's `noUnusedLocals`/`noUnusedParameters`
 * (tsconfig.app.json, tsconfig.functions.json), so the core rule is off for TS files.
 * The typescript-eslint variant is enabled instead to respect `_`-prefixed args.
 */
const tsSharedOverrides = {
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
  ],
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.wrangler/**', 'public/**', 'migrations/**', 'coverage/**'],
  },

  // Plain Node scripts (ES modules) and this config file.
  {
    files: ['scripts/**/*.mjs', 'mcp/**/*.mjs', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // React app sources and tests.
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
      jsxA11y.flatConfigs.recommended,
    ],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...tsSharedOverrides,
      // TS resolves undefined references; no-undef is disabled for TS sources.
      'no-undef': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },

  // Vite config runs its node:fs / node:crypto imports at build time.
  {
    files: ['vite.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parser: tseslint.parser,
    },
    rules: tsSharedOverrides,
  },

  // Cloudflare Pages Functions: Workers runtime, not the browser. TS compiler (with
  // the DOM lib for Request/Response shapes) is the authority on undefined references.
  {
    files: ['functions/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...workerRuntimeGlobals },
      parser: tseslint.parser,
    },
    rules: {
      ...tsSharedOverrides,
      'no-undef': 'off',
      // Hard-block browser-only runtime globals instead of runtime breakage.
      'no-restricted-globals': ['error', ...browserOnlyGlobals.map((name) => ({ name, message: 'Cloudflare Workers runtime: this browser global does not exist here.' }))],
    },
  },
);
