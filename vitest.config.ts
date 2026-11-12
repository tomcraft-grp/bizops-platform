import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    testTimeout: 60000,
    reporters: ['default', 'json'],
    outputFile: { json: 'qa/results/unit.json' },
  },
});
