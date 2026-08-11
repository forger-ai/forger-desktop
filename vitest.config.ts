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
        statements: 0.84,
        branches: 1.1,
        functions: 0.49,
        lines: 1.11,
      },
    },
  },
});
