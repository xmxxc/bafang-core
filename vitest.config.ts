import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
