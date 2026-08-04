import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  use: {
    baseURL: process.env['PW_BASE'] ?? 'http://127.0.0.1:8799',
    screenshot: 'only-on-failure',
    // This sandbox preinstalls Chromium at a fixed path; CI installs browsers
    // normally and leaves PW_CHROMIUM unset.
    ...(process.env['PW_CHROMIUM'] ? { launchOptions: { executablePath: process.env['PW_CHROMIUM'] } } : {}),
  },
  webServer: {
    // Blank the API keys so E2E is deterministic even when the shell has them.
    command: 'PORT=8799 PAM_ACCESS_CODE=e2e-code PAM_ANTHROPIC_API_KEY= ANTHROPIC_API_KEY= npx tsx src/server/main.ts',
    url: 'http://127.0.0.1:8799/healthz',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
