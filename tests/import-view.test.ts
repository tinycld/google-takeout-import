import { describe, expect, it } from 'vitest'
import {
    buildChoiceRows,
    completeSummary,
    currentStep,
    formatBytes,
    progressDetail,
    progressPercent,
} from '../tinycld/google-takeout-import/lib/import-view'
import type {
    ImportProgress,
    TakeoutDetection,
} from '../tinycld/google-takeout-import/lib/takeout-import/types'

const detection: TakeoutDetection = {
    hasContacts: true,
    hasCalendar: true,
    hasDrive: false,
    hasMail: true,
    contactCount: 1,
    eventCount: 1200,
    driveFileCount: 0,
    mailThreadCount: 40,
    fileCount: 3,
    totalSize: 2_500_000_000,
}

const allSelected = { contacts: true, calendar: true, drive: true, mail: true }
const allInstalled = new Set(['contacts', 'calendar', 'drive', 'mail'])

function rowsWith(overrides: Partial<Parameters<typeof buildChoiceRows>[0]> = {}) {
    const rows = buildChoiceRows({
        detection,
        installedSlugs: allInstalled,
        selectedServices: allSelected,
        hasMailbox: true,
        mailboxLoading: false,
        ...overrides,
    })
    return Object.fromEntries(rows.map(r => [r.service, r]))
}

function progress(overrides: Partial<ImportProgress>): ImportProgress {
    return {
        service: 'mail',
        phase: 'importing',
        total: 200,
        imported: 0,
        skipped: 0,
        errors: 0,
        errorMessages: [],
        ...overrides,
    }
}

describe('currentStep', () => {
    it('maps store phases to the visible step', () => {
        expect(currentStep('idle', false)).toBe('files')
        expect(currentStep('detecting', false)).toBe('files')
        expect(currentStep('error', false)).toBe('files')
        expect(currentStep('idle', true)).toBe('services')
        expect(currentStep('importing', true)).toBe('import')
        expect(currentStep('complete', true)).toBe('finished')
    })
})

describe('buildChoiceRows', () => {
    it('counts detected items with singular and plural nouns', () => {
        const rows = rowsWith()
        expect(rows.contacts.detail).toBe('1 contact')
        expect(rows.calendar.detail).toBe(`${(1200).toLocaleString()} events`)
        expect(rows.mail.detail).toBe('40 messages')
    })

    it('explains why a service cannot be imported', () => {
        expect(rowsWith().drive).toMatchObject({
            availability: 'missing',
            detail: 'Not in these files',
            selected: false,
        })
        expect(rowsWith({ installedSlugs: new Set(['mail']) }).calendar.availability).toBe(
            'not-installed'
        )
        expect(rowsWith({ hasMailbox: false }).mail).toMatchObject({
            availability: 'needs-mailbox',
            selected: false,
        })
        expect(rowsWith({ hasMailbox: false, mailboxLoading: true }).mail.availability).toBe(
            'checking'
        )
    })

    it('keeps an unselected service unselected', () => {
        expect(
            rowsWith({ selectedServices: { ...allSelected, calendar: false } }).calendar.selected
        ).toBe(false)
    })
})

describe('progress helpers', () => {
    it('computes percent from processed items', () => {
        expect(progressPercent(progress({ imported: 50, skipped: 30, errors: 20 }))).toBe(50)
        expect(progressPercent(progress({ total: 0 }))).toBe(0)
        expect(progressPercent(progress({ phase: 'done', total: 0 }))).toBe(100)
    })

    it('describes progress', () => {
        expect(progressDetail(progress({ phase: 'scanning' }))).toBe('Reading archive…')
        expect(progressDetail(progress({ imported: 5, skipped: 2 }))).toBe(
            '5 imported · 2 skipped · 200 total'
        )
        expect(progressDetail(progress({ phase: 'done', imported: 5 }))).toBe('5 imported')
    })

    it('summarizes a finished run', () => {
        expect(completeSummary({ imported: 1, skipped: 0, errors: 0 })).toBe('1 item imported')
        expect(completeSummary({ imported: 10, skipped: 3, errors: 1 })).toBe(
            '10 items imported · 3 already here · 1 error'
        )
    })
})

describe('formatBytes', () => {
    it('picks a readable unit', () => {
        expect(formatBytes(512)).toBe('512 B')
        expect(formatBytes(1536)).toBe('1.5 KB')
        expect(formatBytes(2_500_000_000)).toBe('2.3 GB')
    })
})
