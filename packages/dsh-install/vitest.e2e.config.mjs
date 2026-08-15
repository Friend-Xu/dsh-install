import { defineConfig } from 'vitest/config'

// Spawn-dependent e2e: run only in environments that allow piped child
// processes (real machines, or an escalated sandbox).
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts', 'e2e/**/*.e2e.ts'],
    environment: 'node',
    pool: 'threads',
  },
})
