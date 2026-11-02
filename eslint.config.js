import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const vitestGlobals = {
  afterAll: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  it: 'readonly',
  test: 'readonly',
  vi: 'readonly',
}

const tsRules = {
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
}

const workerGlobals = {
  AbortSignal: 'readonly',
  Blob: 'readonly',
  Cache: 'readonly',
  CacheStorage: 'readonly',
  caches: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
}

export default tseslint.config(
  { ignores: ['frontend/**', '**/dist/**', '**/node_modules/**', '.wrangler/**', 'coverage/**', 'migrations/**', 'public/**'] },
  {
    files: ['api/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.ts', 'vitest.config.ts', 'eslint.config.js'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...vitestGlobals },
    },
    rules: { ...tsRules, 'no-console': 'off' },
  },
  {
    files: ['src/**/*.{js,ts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...tsRules, 'no-console': 'off' },
  },
  {
    files: ['functions/**/*.ts', 'workers/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: workerGlobals,
    },
    rules: {
      ...tsRules,
      'no-undef': 'off',
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage'],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
