import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Node workers execute emitted JavaScript, outside Vitest's TypeScript loader.
    // Use `bun run test:node` to rebuild first; direct `vitest --run` can test stale dist code.
    alias: { './recording.js': fileURLToPath(new URL('./dist/recording.js', import.meta.url)) },
  },
  test: {
    globals: true,
    include: ['**/*.{test,vitest}.{ts,tsx}'],
    exclude: ['dist/**', 'node_modules/**', 'opensrc/**', 'tmp/**', 'src/cli.test.ts'],
  },
})
