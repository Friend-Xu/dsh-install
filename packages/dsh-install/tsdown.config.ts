import { defineConfig } from 'tsdown'

// dsh-install build: two plugin entry points (the aggregator row and the
// management row), ESM, declarations. Peer dependencies (cordis and the
// @deepseek-ai/dsh-* packages) are externalized by tsdown automatically —
// they resolve from the harness installation at runtime, never duplicated.
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  clean: true,
  sourcemap: true,
})
