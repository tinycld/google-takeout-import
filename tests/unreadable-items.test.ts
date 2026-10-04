// Nothing in an export may be dropped without the user seeing why. Each item a
// parser cannot turn into a record becomes an `unreadable` record, and the
// inserter counts it as a failure with its reason.

import {
    type FallbackCallbacks,
    runFallbackImport,
} from '@tinycld/google-takeout-import/lib/takeout-import/import-worker-fallback'
import { strToU8 } from 'fflate'
import type PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import { createBatchInserter } from '~/tinycld/google-takeout-import/lib/takeout-import/batch-inserter'
import {
    countCalendarEntry,
    parseCalendarEntry,
} from '~/tinycld/google-takeout-import/lib/takeout-import/parsers/calendar'
import { parseContactsEntry } from '~/tinycld/google-takeout-import/lib/takeout-import/parsers/contacts'
import {
    parseMailMessage,
    readMailHeaders,
} from '~/tinycld/google-takeout-import/lib/takeout-import/parsers/mail'
import { MailPlanBuilder } from '~/tinycld/google-takeout-import/lib/takeout-import/parsers/mail-plan'
import {
    type ImportProgress,
    type ImportService,
    type ParsedMailMessage,
    type ParsedMailMessageRecord,
    type ParsedRecord,
    unreadable,
} from '~/tinycld/google-takeout-import/lib/takeout-import/types'
import { zipTakeoutFile } from './helpers/takeout-file'

const VCF_PATH = 'Takeout/Contacts/My Contacts/My Contacts.vcf'
const ICS_PATH = 'Takeout/Calendar/work.ics'

function vcard(lines: string[]) {
    return ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n')
}

function ics(events: string[][]) {
    const body = events.flatMap(e => ['BEGIN:VEVENT', ...e, 'END:VEVENT'])
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Work', ...body, 'END:VCALENDAR'].join(
        '\r\n'
    )
}

describe('contacts parser', () => {
    it('keeps a card with only a company, using it as the name', () => {
        const [card] = parseContactsEntry(VCF_PATH, strToU8(vcard(['ORG:Acme Corp'])))
        expect(card).toMatchObject({ recordType: 'contact', first_name: 'Acme Corp' })
    })

    it('moves a lone last name into first_name', () => {
        const [card] = parseContactsEntry(VCF_PATH, strToU8(vcard(['N:Lovelace;;;;'])))
        expect(card).toMatchObject({ first_name: 'Lovelace', last_name: '' })
    })

    it('reports an empty card instead of dropping it', () => {
        const [card] = parseContactsEntry(VCF_PATH, strToU8(vcard(['NOTE:'])))
        expect(card).toEqual(unreadable('contacts', 'Contact card 1 in My Contacts.vcf is empty'))
    })

    it('reports a card that does not parse', () => {
        const cards = parseContactsEntry(VCF_PATH, strToU8('BEGIN:VCARD\r\nnot a property'))
        expect(cards).toHaveLength(1)
        expect(cards[0]).toMatchObject({ recordType: 'unreadable', service: 'contacts' })
    })
})

describe('calendar parser', () => {
    const start = 'DTSTART:20250101T100000Z'

    it('imports an event with no title or UID', () => {
        const { calendar, unreadable: failures } = parseCalendarEntry(
            ICS_PATH,
            strToU8(ics([[start]]))
        )
        expect(failures).toEqual([])
        expect(calendar?.events).toHaveLength(1)
    })

    it('reports an event with no start time', () => {
        const data = strToU8(ics([[start, 'SUMMARY:ok'], ['SUMMARY:Standup']]))
        const { calendar, unreadable: failures } = parseCalendarEntry(ICS_PATH, data)
        expect(calendar?.events).toHaveLength(1)
        expect(failures).toEqual([
            unreadable('calendar', 'Event "Standup" in Work has no start time'),
        ])
        expect(countCalendarEntry(ICS_PATH, data)).toBe(2)
    })

    it('reports a calendar file that does not parse', () => {
        const { calendar, unreadable: failures } = parseCalendarEntry(
            ICS_PATH,
            strToU8('BEGIN:VCALENDAR\r\ngarbage')
        )
        expect(calendar).toBeNull()
        expect(failures).toHaveLength(1)
        expect(failures[0].reason).toMatch(/^Calendar file work.ics could not be read/)
    })
})

function mailMessage(extra: string[], body: string) {
    return [
        'X-GM-THRID: 1',
        'Message-ID: <m1@example.com>',
        'From: a@example.com',
        'Date: Wed, 01 Jan 2025 10:00:00 +0000',
        'Subject: Report',
        ...extra,
        '',
        body,
    ].join('\n')
}

function onlyMessage(raw: string): ParsedMailMessage {
    const message = parseMailMessage(strToU8(`From 1@xxx\n${raw}`))
    if (!message) throw new Error('message did not parse')
    return message
}

function mailRecord(raw: string): ParsedMailMessageRecord {
    const bytes = strToU8(`From 1@xxx\n${raw}`)
    const headers = readMailHeaders(bytes)
    if (!headers) throw new Error('headers did not parse')
    const builder = new MailPlanBuilder()
    builder.add(0, headers)
    const planned = builder.build().lookup(0)
    if (!planned) throw new Error('message was not planned')
    return {
        recordType: 'mail_message',
        thread: planned.thread,
        message: onlyMessage(raw),
        isEarliest: planned.isEarliest,
    }
}

describe('mail parser', () => {
    const boundary = 'B'
    const multipart = (part: string[]) =>
        mailMessage(
            [`Content-Type: multipart/mixed; boundary="${boundary}"`],
            [
                `--${boundary}`,
                'Content-Type: text/plain',
                '',
                'hello',
                `--${boundary}`,
                ...part,
                `--${boundary}--`,
            ].join('\n')
        )

    it('decodes a quoted-printable attachment instead of failing it as base64', () => {
        const msg = onlyMessage(
            multipart([
                'Content-Type: text/csv; name="a.csv"',
                'Content-Disposition: attachment; filename="a.csv"',
                'Content-Transfer-Encoding: quoted-printable',
                '',
                'caf=C3=A9',
            ])
        )
        expect(msg.problems).toEqual([])
        expect(new TextDecoder().decode(msg.attachments[0].bytes).trim()).toBe('café')
    })

    it('reports a corrupt base64 attachment on a message that still imports', () => {
        const msg = onlyMessage(
            multipart([
                'Content-Type: application/pdf; name="a.pdf"',
                'Content-Disposition: attachment; filename="a.pdf"',
                'Content-Transfer-Encoding: base64',
                '',
                '***not base64***',
            ])
        )
        expect(msg.problems).toEqual(['Attachment "a.pdf" could not be decoded'])
    })

    it('keeps the body of a multipart message with no boundary as raw text', () => {
        const msg = onlyMessage(mailMessage(['Content-Type: multipart/mixed'], 'raw body'))
        expect(msg.body_html).toBe('<pre>raw body</pre>')
        expect(msg.problems).toHaveLength(1)
    })
})

function fakePb() {
    const pb = {
        collection: () => ({
            getFirstListItem: () => Promise.reject(Object.assign(new Error('nf'), { status: 404 })),
            getList: () => Promise.resolve({ items: [] }),
            create: () => Promise.resolve({ id: 'rec_1' }),
        }),
        filter: (expr: string) => expr,
    } as unknown as PocketBase
    return pb
}

async function insert(records: ParsedRecord[]) {
    const progress: [ImportService, Partial<ImportProgress>][] = []
    const inserter = createBatchInserter({
        pb: fakePb(),
        context: { userId: 'u1', mailboxId: 'mb1' },
        onProgress: (service, update) => progress.push([service, update]),
    })
    await inserter.insertRecords(records)
    return progress
}

describe('batch inserter failure reporting', () => {
    it('counts an unreadable record as a failure with its reason', async () => {
        const progress = await insert([unreadable('calendar', 'Event "x" has no start time')])
        expect(progress).toEqual([
            ['calendar', { errors: 1, errorMessages: ['Event "x" has no start time'] }],
        ])
    })

    it('counts each mail message, and reports its problems', async () => {
        const record = mailRecord(mailMessage([], 'hi'))
        const withProblem = {
            ...record,
            message: { ...record.message, problems: ['Attachment "a.pdf" could not be decoded'] },
        }
        const progress = await insert([withProblem])
        expect(progress).toEqual([
            ['mail', { imported: 1 }],
            [
                'mail',
                {
                    errors: 1,
                    errorMessages: ['"Report": Attachment "a.pdf" could not be decoded'],
                },
            ],
        ])
    })

    it('fails an event whose calendar was never created instead of counting it imported', async () => {
        const progress = await insert([
            {
                recordType: 'calendar_event',
                calendarName: 'Missing',
                title: 'Standup',
                description: '',
                location: '',
                start: '2025-01-01T10:00:00.000Z',
                end: '2025-01-01T10:30:00.000Z',
                all_day: false,
                recurrence: '',
                ical_uid: '',
                guests: [],
                reminder: 0,
                busy_status: 'busy',
                visibility: 'default',
            },
        ])
        expect(progress).toEqual([
            [
                'calendar',
                {
                    errors: 1,
                    errorMessages: [
                        'Calendar "Missing" was not created, so event "Standup" was not imported',
                    ],
                },
            ],
        ])
    })

    it('fails a drive file whose folder was never created instead of moving it to the root', async () => {
        const progress = await insert([
            {
                recordType: 'drive_file',
                path: 'Docs/a.txt',
                name: 'a.txt',
                parentPath: 'Docs',
                mime_type: 'text/plain',
                size: 1,
                bytes: new ArrayBuffer(1),
            },
        ])
        expect(progress[0][1].errorMessages).toEqual([
            'Folder "Docs" was not created, so "a.txt" was not imported',
        ])
    })
})

describe('import pipeline', () => {
    it('sends unreadable calendar items to the inserter', async () => {
        const file = zipTakeoutFile({ [ICS_PATH]: strToU8(ics([['SUMMARY:Standup']])) })
        const records: ParsedRecord[] = []
        const callbacks: FallbackCallbacks = {
            onBatch: async (_service, batch) => {
                records.push(...batch)
            },
            onProgress: () => {},
            onDone: () => {},
            onError: message => {
                throw new Error(message)
            },
        }
        await runFallbackImport([file], ['calendar'], { userId: 'u1', mailboxId: null }, callbacks)
        expect(records).toEqual([
            unreadable('calendar', 'Event "Standup" in Work has no start time'),
        ])
    })
})
