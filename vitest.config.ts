import { defineConfig } from 'vitest/config';
import { testUrls } from './test/urls';

export default defineConfig({
  test: {
    globalSetup: './test/globalSetup.ts',
    env: {
      NODE_ENV: 'test',
      DATABASE_ADMIN_URL: testUrls.admin,
      DATABASE_URL: testUrls.app,
      LOGIN_RATE_LIMIT: '10000',
      JOBS_ENABLED: 'false',
    },
    // Files share one database; each creates its own uniquely named tenants.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
