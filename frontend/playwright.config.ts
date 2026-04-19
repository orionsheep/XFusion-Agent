import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    viewport: { width: 1600, height: 1200 },
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
})
