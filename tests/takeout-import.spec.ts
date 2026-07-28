import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { login, navigateToPackage } from '@tinycld/core/e2e-helpers'

const TAKEOUT_DIR = path.resolve(import.meta.dirname, './assets/takeout')
const TAKEOUT_FILES = [
    path.join(TAKEOUT_DIR, 'takeout-20260416T000738Z-8-001.zip'), // Contacts + Calendar
    path.join(TAKEOUT_DIR, 'takeout-20260416T000738Z-9-001.zip'), // Drive
    path.join(TAKEOUT_DIR, 'takeout-20260416T000738Z-7-001.zip'), // Mail
]

// The one deliberately long budget in this file: the import itself parses
// three zips client-side and inserts hundreds of records through PocketBase,
// which legitimately takes minutes on a loaded CI runner. Everything else
// uses Playwright's default expect timeout.
const IMPORT_COMPLETE_TIMEOUT = 120_000

// Calendar month contents hydrate through live queries after navigation, which
// under CI load can outrun the default 5s. One named budget instead of
// scattered inline bumps.
const EVENT_LOAD_TIMEOUT = 10_000

// Restrict text-based assertions to the *visible* DOM so they don't
// match elements in frozen sibling screens kept mounted by the package
// FrozenSlideStack layouts (contacts, drive, mail). `.filter({ visible: true })`
// is the locator-level equivalent of the `:visible` CSS pseudo-class
// and cooperates with `.first()`.
function visibleText(page: Page, text: string | RegExp) {
    return page.getByText(text).filter({ visible: true })
}

// The event-detail popover, by its component testID — the old
// [style*="width: 360"] selector broke on any styling change and could match
// unrelated fixed-width elements.
function eventPopover(page: Page) {
    return page.getByTestId('event-detail-popover')
}

// Open the calendar's Month view on a target month, entirely in-app — a
// page.goto('?view=month&date=…') is a hard nav that tears down the SPA and
// cancels in-flight chunk loads (see helpers.ts). Steps the header arrows
// toward the target, bounded so a UI regression fails fast instead of looping.
async function openMonth(page: Page, target: string) {
    await navigateToPackage(page, 'calendar')
    await page.getByRole('button', { name: 'Month' }).click()
    const label = page.getByTestId('calendar-date-label')
    // Wait until the label is in month format ("April 2026") before parsing.
    await expect(label).toHaveText(/^[A-Z][a-z]+ \d{4}$/)
    for (let i = 0; i < 36; i++) {
        const current = (await label.textContent())?.trim() ?? ''
        if (current === target) return
        const dir = new Date(`1 ${current}`) > new Date(`1 ${target}`) ? 'Previous' : 'Next'
        await page.getByRole('button', { name: dir, exact: true }).click()
    }
    throw new Error(`calendar never reached ${target}`)
}

test.describe.configure({ mode: 'serial' })

test.describe('Google Takeout Import', () => {
    test.beforeEach(async ({ page }) => {
        await login(page)
    })

    test('run import and wait for completion', async ({ page }) => {
        // In-app: Settings → the package's "Import from Google" entry.
        await navigateToPackage(page, 'settings')
        await page.getByText('Import from Google', { exact: true }).first().click()
        await page.waitForURL(/google-takeout/)
        await expect(page.getByText('Import from Google').first()).toBeVisible()

        // Upload files again (serial tests share login but not page state)
        const fileChooserPromise = page.waitForEvent('filechooser')
        await page.getByText('Select Takeout Files').click()
        const fileChooser = await fileChooserPromise
        await fileChooser.setFiles(TAKEOUT_FILES)

        // Detection reads all three zips in the browser before enabling the
        // button — slow on CI, so it shares the import budget.
        await expect(page.getByText('Start Import')).toBeVisible({
            timeout: IMPORT_COMPLETE_TIMEOUT,
        })
        await page.getByText('Start Import').click()

        await expect(page.getByText('Import Complete', { exact: true })).toBeVisible({
            timeout: IMPORT_COMPLETE_TIMEOUT,
        })
        await expect(page.getByText(/records imported/)).toBeVisible()
    })

    test('verify contacts were imported', async ({ page }) => {
        await navigateToPackage(page, 'contacts')

        await expect(visibleText(page, 'Bob McGee').first()).toBeVisible({
            timeout: EVENT_LOAD_TIMEOUT,
        })
        await expect(visibleText(page, 'Nathan Stitt').first()).toBeVisible()

        // Click into Bob's detail page to check that grouped vCard properties
        // (item1.EMAIL ↔ item1.X-ABLabel) were merged correctly. The contacts
        // package layout is a FrozenSlideStack, so after navigation both the
        // list and detail screens stay mounted; scope the email assertion to
        // the *visible* detail container instead of the bare text, which
        // would otherwise also match the (now-hidden) list-row preview.
        await visibleText(page, 'Bob McGee').first().click()
        await page.waitForURL(/\/contacts\//)
        await expect(visibleText(page, 'bobby@bob.com').first()).toBeVisible()
    })

    test('verify calendar events match takeout data', async ({ page }) => {
        // Everything asserted here lands in April 2026.
        await openMonth(page, 'April 2026')

        // The imported calendar should appear in the sidebar
        await expect(page.getByText('testermctesty@argosity.com').first()).toBeVisible({
            timeout: EVENT_LOAD_TIMEOUT,
        })

        // --- Test Entry #3: all-day Apr 13 (Monday), with guests ---
        // Month view renders an event chip once per grid segment, so match the
        // first visible chip rather than expecting a single node.
        await expect(visibleText(page, 'Test Entry #3').first()).toBeVisible({
            timeout: EVENT_LOAD_TIMEOUT,
        })

        await visibleText(page, 'Test Entry #3').first().click()
        await expect(eventPopover(page).getByText('Test Entry #3')).toBeVisible()
        await expect(eventPopover(page).getByText('Monday, April 13')).toBeVisible()
        await expect(eventPopover(page).getByText('2 guests')).toBeVisible()
        await expect(eventPopover(page).getByText('testermctesty@argosity.com')).toBeVisible()
        await page.mouse.click(200, 200)

        // --- "30 min with tester": recurring timed events from appointment schedule ---
        await expect(visibleText(page, '30 min with tester').first()).toBeVisible()

        // --- Test Entry #1: all-day Apr 6 (Monday) ---
        await expect(visibleText(page, 'Test Entry #1').first()).toBeVisible()

        await visibleText(page, 'Test Entry #1').first().click()
        await expect(eventPopover(page).getByText('Test Entry #1')).toBeVisible()
        await expect(eventPopover(page).getByText('Monday, April 6')).toBeVisible()
        await expect(eventPopover(page).getByText(/guest/)).not.toBeVisible()
        await page.mouse.click(200, 200)

        // --- Test Entry #2: all-day Apr 24 (Friday) ---
        await expect(visibleText(page, 'Test Entry #2').first()).toBeVisible()

        await visibleText(page, 'Test Entry #2').first().click()
        await expect(eventPopover(page).getByText('Test Entry #2')).toBeVisible()
        await expect(eventPopover(page).getByText('Friday, April 24')).toBeVisible()
        await expect(eventPopover(page).getByText(/guest/)).not.toBeVisible()
        await page.mouse.click(200, 200)
    })

    test('verify recurring event imported and displayed', async ({ page }) => {
        await openMonth(page, 'May 2026')
        await expect(visibleText(page, 'Test Reoccur #1').first()).toBeVisible({
            timeout: EVENT_LOAD_TIMEOUT,
        })

        await visibleText(page, 'Test Reoccur #1').first().click()
        await expect(eventPopover(page).getByText('Test Reoccur #1')).toBeVisible()
        await expect(eventPopover(page).getByText('Friday, May 1')).toBeVisible()
        // FREQ=MONTHLY;COUNT=12;BYMONTHDAY=1 → "Monthly on day 1, 12 times"
        await expect(eventPopover(page).getByText('Monthly on day 1, 12 times')).toBeVisible()
        await expect(eventPopover(page).getByText(/guest/)).not.toBeVisible()
        await page.mouse.click(200, 200)

        await openMonth(page, 'June 2026')
        await expect(visibleText(page, 'Test Reoccur #1').first()).toBeVisible({
            timeout: EVENT_LOAD_TIMEOUT,
        })
    })

    test('verify drive files were imported', async ({ page }) => {
        await navigateToPackage(page, 'drive')

        // The drive root mixes seeded items, fixtures from earlier suites,
        // and our four takeout uploads (`sample.{docx,pdf,pptx,jpg}` plus
        // `Folder #1`). FlashList virtualizes anything outside the initial
        // viewport, so any of the takeout rows can be off-screen depending
        // on sort order and how many neighbouring fixtures the run has
        // accumulated. The drive search input narrows the list to a
        // single row server-side, sidestepping the need to walk the
        // FlashList container at all.
        // Rows are labelled clickable regions, not <button>s (they contain
        // their own action buttons) — match on aria-label like drive's own
        // driveItem helper does.
        const search = page.getByPlaceholder('Search in Files')
        for (const name of ['sample.docx', 'sample.pdf', 'sample.pptx', 'Folder #1']) {
            await search.fill(name)
            const row = page
                .getByLabel(new RegExp(`^${escapeRegex(name)} `))
                .filter({ visible: true })
                .first()
            await expect(row).toBeVisible({ timeout: EVENT_LOAD_TIMEOUT })
        }
        await search.clear()
    })

    test('verify mail was imported', async ({ page }) => {
        await navigateToPackage(page, 'mail')

        // Scope to the inbox row testID so we don't match a frozen detail
        // screen header from a previous test in the suite. The row itself
        // is the email-row container EmailRow.tsx tags.
        await expect(
            page
                .locator('[data-testid="email-row"]:visible')
                .filter({ hasText: 'Test email #2' })
                .first()
        ).toBeVisible({ timeout: EVENT_LOAD_TIMEOUT })
    })
})

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
