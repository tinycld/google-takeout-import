// A failed item is shown to the user with the server's reason, and is never
// sent to Sentry. Before this, the panel showed only "Failed to create
// record." and every failed item became a Sentry event.

import type PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import { createBatchInserter } from '~/tinycld/google-takeout-import/lib/takeout-import/batch-inserter'
import { describeFailure } from '~/tinycld/google-takeout-import/lib/takeout-import/describe-failure'
import { asHtmlDocument } from '~/tinycld/google-takeout-import/lib/takeout-import/html-document'
import type {
    ImportProgress,
    ParsedContact,
} from '~/tinycld/google-takeout-import/lib/takeout-import/types'

// Shaped like the SDK's ClientResponseError for a failed validation.
function validationError() {
    return Object.assign(new Error('Failed to create record.'), {
        status: 400,
        response: {
            status: 400,
            message: 'Failed to create record.',
            data: {
                body_html: {
                    code: 'validation_invalid_mime_type',
                    message: '"body_x.html" mime type must be one of: text/html.',
                },
            },
        },
    })
}

const contact: ParsedContact = {
    recordType: 'contact',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    phone: '',
    company: '',
    job_title: '',
    notes: '',
    vcard_uid: 'v1',
}

describe('describeFailure', () => {
    it('adds each field error to the summary', () => {
        expect(describeFailure(validationError())).toBe(
            'Failed to create record. body_html: "body_x.html" mime type must be one of: text/html.'
        )
    })

    it('falls back to the message when there are no field errors', () => {
        expect(describeFailure(new Error('network down'))).toBe('network down')
    })

    it('handles a non-Error rejection', () => {
        expect(describeFailure('boom')).toBe('Unknown error')
    })
})

describe('failed item reporting', () => {
    it('names the item and gives the reason, and does not retry a rejected request', async () => {
        let creates = 0
        const pb = {
            collection: () => ({
                getFirstListItem: () =>
                    Promise.reject(Object.assign(new Error('not found'), { status: 404 })),
                create: () => {
                    creates += 1
                    return Promise.reject(validationError())
                },
            }),
            filter: (expr: string) => expr,
        } as unknown as PocketBase
        const progress: Partial<ImportProgress>[] = []
        const inserter = createBatchInserter({
            pb,
            context: { userId: 'u1', mailboxId: 'mb1' },
            onProgress: (_service, update) => progress.push(update),
        })

        await inserter.insertRecords([contact])

        expect(creates).toBe(1)
        expect(progress).toContainEqual({
            errors: 1,
            errorMessages: [
                '"Ada Lovelace": Failed to create record. body_html: "body_x.html" mime type must be one of: text/html.',
            ],
        })
    })
})

describe('asHtmlDocument', () => {
    it('adds a doctype to a plain-text body so it sniffs as HTML', () => {
        expect(asHtmlDocument('<pre>\n\n</pre>')).toBe('<!DOCTYPE html>\n<pre>\n\n</pre>')
    })

    it('adds a doctype to an HTML part that opens with text or <meta>', () => {
        expect(asHtmlDocument('Hello<br>')).toBe('<!DOCTYPE html>\nHello<br>')
        expect(asHtmlDocument('<meta charset="utf-8"><p>Hi</p>')).toMatch(/^<!DOCTYPE html>\n/)
    })

    it('adds a doctype when <html is not followed by a space or >', () => {
        expect(asHtmlDocument('<html\nlang="en">')).toMatch(/^<!DOCTYPE html>\n/)
    })

    it('leaves a body that already opens with a doctype or <html> alone', () => {
        expect(asHtmlDocument('<!DOCTYPE html PUBLIC "x"><html></html>')).toBe(
            '<!DOCTYPE html PUBLIC "x"><html></html>'
        )
        expect(asHtmlDocument('  <HTML><body>Hi</body></HTML>')).toBe(
            '  <HTML><body>Hi</body></HTML>'
        )
    })

    it('gives an empty body a placeholder paragraph', () => {
        expect(asHtmlDocument('')).toBe('<!DOCTYPE html>\n<p></p>')
    })
})

describe('calendar event without a UID', () => {
    it('is matched on title and start in the form PocketBase stores dates', async () => {
        const filters: Record<string, unknown>[] = []
        const pb = {
            collection: () => ({
                getFirstListItem: () =>
                    Promise.reject(Object.assign(new Error('not found'), { status: 404 })),
                getList: () => Promise.resolve({ items: [] }),
                create: () => Promise.resolve({ id: 'cal_1' }),
            }),
            filter: (_expr: string, params: Record<string, unknown>) => {
                filters.push(params)
                return ''
            },
        } as unknown as PocketBase
        const inserter = createBatchInserter({
            pb,
            context: { userId: 'u1', mailboxId: 'mb1' },
            onProgress: () => {},
        })

        await inserter.insertRecords([
            { recordType: 'calendar', name: 'Work', events: [] },
            {
                recordType: 'calendar_event',
                calendarName: 'Work',
                title: '',
                description: '',
                location: '',
                start: '2025-01-03T11:00:00.000Z',
                end: '2025-01-03T12:00:00.000Z',
                all_day: false,
                recurrence: '',
                ical_uid: '',
                guests: [],
                reminder: 0,
                busy_status: 'busy',
                visibility: 'default',
            },
        ])

        expect(filters).toContainEqual(
            expect.objectContaining({ title: '(No title)', start: '2025-01-03 11:00:00.000Z' })
        )
    })
})
