import path from 'node:path'
import { defineConfig } from '@playwright/test'
import appConfig from '@tinycld/core/playwright-config'

const WS_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_DIR = path.join(WS_ROOT, 'node_modules', '@tinycld', 'google-takeout-import', 'tests')

export default defineConfig({
    ...appConfig,
    testDir: TEST_DIR,
    // The import test parses three takeout zips client-side and inserts
    // hundreds of records before its completion assertion — well past the
    // default 30s per-test budget on a loaded CI runner.
    timeout: 180_000,
})
