import path from 'node:path'
import { expect, test } from '@playwright/test'
import { login, navigateToPackage, ORG_SLUG } from '../../../../tests/e2e/helpers'

const TAKEOUT_DIR = path.resolve(import.meta.dirname, './assets/takeout')
const TAKEOUT_FILES = [
    path.join(TAKEOUT_DIR, 'takeout-20260416T000738Z-8-001.zip'), // Contacts + Calendar
    path.join(TAKEOUT_DIR, 'takeout-20260416T000738Z-9-001.zip'), // Drive
    path.join(TAKEOUT_DIR, 'takeout-20260416T000738Z-7-001.zip'), // Mail
]

const CAL_URL = `/a/${ORG_SLUG}/calendar`

test.describe.configure({ mode: 'serial' })

test.describe('Google Takeout Import', () => {
    test.beforeEach(async ({ page }) => {
        await login(page)
    })

    test('upload takeout files and detect services', async ({ page }) => {
        await page.goto(`/a/${ORG_SLUG}/settings/google-takeout-import/google-takeout`)
        await expect(page.getByText('Import from Google').first()).toBeVisible({ timeout: 10_000 })

        const fileChooserPromise = page.waitForEvent('filechooser')
        await page.getByText('Select Takeout Files').click()
        const fileChooser = await fileChooserPromise
        await fileChooser.setFiles(TAKEOUT_FILES)

        await expect(page.getByText('Scanning zip files...')).toBeVisible({ timeout: 10_000 })
        await expect(page.getByText('Start Import')).toBeVisible({ timeout: 30_000 })

        // Each detected service renders as "<Label> — <count> <unit>" once the
        // scan completes. Match the label prefix rather than the whole line so
        // the count numbers don't have to be encoded into the spec.
        await expect(page.getByText(/^Contacts\b/).first()).toBeVisible()
        await expect(page.getByText(/^Calendar\b/).first()).toBeVisible()
        await expect(page.getByText(/^Drive\b/).first()).toBeVisible()
    })

    test('run import and wait for completion', async ({ page }) => {
        await page.goto(`/a/${ORG_SLUG}/settings/google-takeout-import/google-takeout`)
        await expect(page.getByText('Import from Google').first()).toBeVisible({ timeout: 10_000 })

        // Upload files again (serial tests share login but not page state)
        const fileChooserPromise = page.waitForEvent('filechooser')
        await page.getByText('Select Takeout Files').click()
        const fileChooser = await fileChooserPromise
        await fileChooser.setFiles(TAKEOUT_FILES)

        await expect(page.getByText('Start Import')).toBeVisible({ timeout: 30_000 })
        await page.getByText('Start Import').click()

        await expect(page.getByText('Import Complete', { exact: true })).toBeVisible({
            timeout: 120_000,
        })
        await expect(page.getByText(/records imported/)).toBeVisible()
    })

    test('verify contacts were imported', async ({ page }) => {
        await navigateToPackage(page, 'contacts')

        await expect(page.getByText('Bob McGee').first()).toBeVisible({ timeout: 10_000 })
        await expect(page.getByText('Nathan Stitt').first()).toBeVisible({ timeout: 10_000 })

        // Verify contact details (email) were parsed from grouped vCard properties
        await page.getByText('Bob McGee').first().click()
        // Email shows in both the row preview and the detail header — first()
        // matches whichever renders first.
        await expect(page.getByText('bobby@bob.com').first()).toBeVisible({ timeout: 10_000 })
    })

    test('verify calendar events match takeout data', async ({ page }) => {
        // Navigate to the week containing Apr 13 (Test Entry #3 with guests)
        await page.goto(`${CAL_URL}?view=week&date=2026-04-13`)
        await expect(page.getByText('April 2026').first()).toBeVisible({ timeout: 10_000 })

        // The imported calendar should appear in the sidebar
        await expect(page.getByText('testermctesty@argosity.com').first()).toBeVisible({
            timeout: 10_000,
        })

        // --- Test Entry #3: all-day Apr 13 (Monday) ---
        await expect(page.getByText('Test Entry #3')).toBeVisible({ timeout: 10_000 })

        await page.getByText('Test Entry #3').click()
        const popover = page.locator('[style*="width: 360"]')
        await expect(popover.getByText('Test Entry #3')).toBeVisible({ timeout: 5_000 })
        await expect(popover.getByText('Monday, April 13')).toBeVisible()
        await expect(popover.getByText('2 guests')).toBeVisible()
        await expect(popover.getByText('testermctesty@argosity.com')).toBeVisible()
        await page.mouse.click(200, 200)

        // --- "30 min with tester": recurring timed events from appointment schedule ---
        await expect(page.getByText('30 min with tester').first()).toBeVisible({ timeout: 10_000 })

        // --- Test Entry #1: all-day Apr 6 (Monday) ---
        await page.goto(`${CAL_URL}?view=month&date=2026-04-01`)
        await expect(page.getByText('Test Entry #1')).toBeVisible({ timeout: 10_000 })

        await page.getByText('Test Entry #1').click()
        const popover1 = page.locator('[style*="width: 360"]')
        await expect(popover1.getByText('Test Entry #1')).toBeVisible({ timeout: 5_000 })
        await expect(popover1.getByText('Monday, April 6')).toBeVisible()
        await expect(popover1.getByText(/guest/)).not.toBeVisible()
        await page.mouse.click(200, 200)

        // --- Test Entry #2: all-day Apr 24 (Friday) ---
        await expect(page.getByText('Test Entry #2')).toBeVisible({ timeout: 10_000 })

        await page.getByText('Test Entry #2').click()
        const popover2 = page.locator('[style*="width: 360"]')
        await expect(popover2.getByText('Test Entry #2')).toBeVisible({ timeout: 5_000 })
        await expect(popover2.getByText('Friday, April 24')).toBeVisible()
        await expect(popover2.getByText(/guest/)).not.toBeVisible()
        await page.mouse.click(200, 200)
    })

    test('verify recurring event imported and displayed', async ({ page }) => {
        await page.goto(`${CAL_URL}?view=month&date=2026-05-01`)
        await expect(page.getByText('May 2026').first()).toBeVisible({ timeout: 10_000 })

        await expect(page.getByText('Test Reoccur #1').first()).toBeVisible({ timeout: 10_000 })

        await page.getByText('Test Reoccur #1').first().click()
        const popover = page.locator('[style*="width: 360"]')
        await expect(popover.getByText('Test Reoccur #1')).toBeVisible({ timeout: 5_000 })
        await expect(popover.getByText('Friday, May 1')).toBeVisible()
        // FREQ=MONTHLY;COUNT=12;BYMONTHDAY=1 → "Monthly on day 1, 12 times"
        await expect(popover.getByText('Monthly on day 1, 12 times')).toBeVisible()
        await expect(popover.getByText(/guest/)).not.toBeVisible()
        await page.mouse.click(200, 200)

        await page.goto(`${CAL_URL}?view=month&date=2026-06-01`)
        await expect(page.getByText('June 2026').first()).toBeVisible({ timeout: 10_000 })
        await expect(page.getByText('Test Reoccur #1').first()).toBeVisible({ timeout: 10_000 })
    })

    test('verify drive files were imported', async ({ page }) => {
        await navigateToPackage(page, 'drive')

        await expect(page.getByText('sample.docx').first()).toBeVisible({ timeout: 10_000 })
        await expect(page.getByText('sample.pdf').first()).toBeVisible({ timeout: 10_000 })
        await expect(page.getByText('sample.pptx').first()).toBeVisible({ timeout: 10_000 })
        await expect(page.getByText('Folder #1').first()).toBeVisible({ timeout: 10_000 })
    })

    test('verify mail was imported', async ({ page }) => {
        await navigateToPackage(page, 'mail')

        await expect(page.getByText('Test email #2')).toBeVisible({ timeout: 10_000 })
    })
})
