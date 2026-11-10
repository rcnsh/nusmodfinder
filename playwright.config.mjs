// @ts-check
// The UI suite (Phase 5 5B): test/ui/*.spec.js in Chromium and WebKit against
// scripts/ui-server.mjs, the page and the Worker on a local `wrangler dev`
// with FakeAI over a D1 seeded with the fixture. Nothing reaches Cloudflare.
//
//   npm run test:ui                              starts its own server
//   VNM_UI_URL=http://127.0.0.1:N npm run test:ui  reuses one `npm run dev` started
import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

// One free port per run, picked in the runner; its workers load this file
// again with the variable already set, so they all agree on it.
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
    // Printed only once the fixture is seeded.
    wait: { stdout: /^ui-server: http/m },
    timeout: 120_000,
    stdout: 'pipe',
    // SIGINT lets the server stop wrangler and delete its temporary state.
    gracefulShutdown: { signal: 'SIGINT', timeout: 10_000 },
  },
});
