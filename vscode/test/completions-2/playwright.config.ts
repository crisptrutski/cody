import { defineConfig } from '@playwright/test'

export default defineConfig({
    workers: 1,
    testDir: '.',
})