import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    // E2E tests share Safari — multiple MCP servers creating tabs simultaneously
    // causes tab URL matching failures. Run test files sequentially.
    fileParallelism: false,
  },
});
