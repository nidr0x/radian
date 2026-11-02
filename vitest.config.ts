import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/opengym-*.test.ts', 'tests/mcp.test.ts'],
    environment: 'node',
  },
})
