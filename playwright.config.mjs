// @ts-check
import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

process.env.VNM_UI_PORT ??= execFileSync(process.execPath, ['-e',
  "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); s.close(); });",
]).toString();
const external = process.env.VNM_UI_URL;
const baseURL = external ?? `http://127.0.0.1:${process.env.VNM_UI_PORT}`;

export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.js',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: external ? undefined : {
    command: `node scripts/ui-server.mjs --port ${process.env.VNM_UI_PORT}`,
    wait: { stdout: /^ui-server: http/m },
    timeout: 120_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGINT', timeout: 10_000 },
  },
});
