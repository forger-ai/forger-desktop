import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/renderer/setup.ts'],
    include: ['test/renderer/**/*.test.{ts,tsx}'],
    // Interaction-heavy MUI suites contend for timers and CPU when every file
    // runs at once, producing false five-second timeouts under coverage/CI.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/renderer/**/*.{ts,tsx}'],
      exclude: [
        'src/renderer/**/*.d.ts',
        'src/renderer/docs/forger-docs.generated.ts',
      ],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/renderer',
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
