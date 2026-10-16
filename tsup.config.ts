import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  // The shared engine is shipped as TypeScript source, so it must be bundled in.
  noExternal: ['@xiangqi/shared'],
})
