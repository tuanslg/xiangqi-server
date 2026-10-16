import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts', 'scripts/**/*.test.ts'],
    // DB-backed tests share one throwaway database, so files must not run concurrently.
    fileParallelism: false,
  },
})
