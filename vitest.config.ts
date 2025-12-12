import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.{test,vitest}.{ts,tsx}'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
