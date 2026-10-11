import { defineConfig } from '@playwright/test';

const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173/centrifuge/',
    viewport: { width: 1440, height: 900 },
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  webServer: {
    command: 'npm run build && node scripts/serve-subpath.mjs 4173 /centrifuge/',
    url: 'http://127.0.0.1:4173/centrifuge/',
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
