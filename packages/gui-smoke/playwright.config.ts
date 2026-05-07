import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = '3099';
const WEB_URL = 'http://localhost:5173';

const here = path.dirname(fileURLToPath(import.meta.url));

const archonHome =
  process.env.ARCHON_HOME ?? path.join(os.tmpdir(), `archon-gui-smoke-${process.pid.toString()}`);

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }], ['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev',
    cwd: path.resolve(here, '..', '..'),
    url: WEB_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: SERVER_PORT,
      ARCHON_HOME: archonHome,
      // Disable adapter polling (Slack/Telegram) — they fail noisily without tokens
      // and would otherwise add console errors. Server respects empty env vars.
      NODE_ENV: 'development',
    },
  },
});
