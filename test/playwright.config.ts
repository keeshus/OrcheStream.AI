import { defineConfig } from '@playwright/test';

// Load test/.env.e2e (gitignored, local-only) — e.g. the real-LLM suite's
// API key. Existing process env vars take precedence (loadEnvFile does not
// override already-set variables).
try {
  process.loadEnvFile(new URL('./.env.e2e', import.meta.url));
} catch {
  // No env file — optional.
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 2,
  retries: 2,
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    viewport: { width: 1920, height: 1080 },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: '00-initial-setup.spec.ts',
    },
    {
      name: 'authenticated',
      testMatch: '**/*.spec.ts',
      testIgnore: '00-initial-setup.spec.ts',
      dependencies: ['setup'],
      use: {
        storageState: process.env.PLAYWRIGHT_AUTH_FILE || 'e2e/.auth/user.json',
      },
    },
  ],
});
