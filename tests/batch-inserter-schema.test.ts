// The batch inserter writes into collections belonging to FOUR other packages
// (contacts, calendar, drive, mail) plus core's labels — all through a mocked
// `pb`, so nothing checks its field names against a real collection. That is
// how 8 `user_org` writes survived the de-org with a green 22/22 suite: a
// package that mirrors another's schema needs a test that asserts the FIELD
// NAMES, or its suite certifies the bug (HANDOFF §3.7).
//
// This file is that guard for every mirrored collection the inserter touches.
// The expected names below were hand-verified against the owning packages'
// shipped migrations. When an owning package renames a field, update BOTH its
// consumers here and this contract — this test failing is the reminder that
// takeout mirrors it.

import type PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import { createBatchInserter } from '~/tinycld/google-takeout-import/lib/takeout-import/batch-inserter'
import type {
    ParsedCalendar,
    ParsedCalendarEvent,
    ParsedContact,
    ParsedDriveFile,
    ParsedDriveFolder,
    ParsedMailThread,
} from '~/tinycld/google-takeout-import/lib/takeout-import/types'

interface Recorded {
    filters: Map<string, Set<string>>
    createKeys: Map<string, string[][]>
}

function recordingPb(): { pb: PocketBase; recorded: Recorded } {
    const recorded: Recorded = { filters: new Map(), createKeys: new Map() }
    let nextId = 0

    const noteFilter = (collection: string, filter: string) => {
        const set = recorded.filters.get(collection) ?? new Set()
        set.add(filter)
        recorded.filters.set(collection, set)
    }

    const collection = (name: string) => ({
        // Always "not found" so every dedup lookup proceeds to create. Shaped
        // like the SDK's ClientResponseError: only a status-404 rejection may
        // mean "not found" — anything else must abort the row (R3).
        getFirstListItem: (filter: string) => {
            noteFilter(name, filter)
            return Promise.reject(Object.assign(new Error('not found'), { status: 404 }))
        },
        getList: (_page: number, _per: number, opts: { filter: string }) => {
            noteFilter(name, opts.filter)
            return Promise.resolve({ items: [] })
        },
        create: (payload: Record<string, unknown> | FormData) => {
            const keys =
                payload instanceof FormData ? [...new Set(payload.keys())] : Object.keys(payload)
            const all = recorded.createKeys.get(name) ?? []
            all.push(keys.sort())
            recorded.createKeys.set(name, all)
            nextId += 1
            return Promise.resolve({ id: `rec_${nextId}` })
        },
    })

    const pb = {
        collection,
        // Keep the placeholder syntax so recorded filters are stable strings.
        filter: (expr: string) => expr,
    } as unknown as PocketBase

    return { pb, recorded }
}

function contact(overrides: Partial<ParsedContact>): ParsedContact {
    return {
        recordType: 'contact',
        first_name: '',
        last_name: '',
        email: '',
        phone: '',
        company: '',
        job_title: '',
        notes: '',
        vcard_uid: '',
        ...overrides,
    }
}

const calendar: ParsedCalendar = { recordType: 'calendar', name: 'Work', events: [] }

const calendarEvent: ParsedCalendarEvent = {
    recordType: 'calendar_event',
    calendarName: 'Work',
    title: 'Standup',
    description: '',
    location: '',
    start: '2026-01-01T09:00:00Z',
    end: '2026-01-01T09:15:00Z',
    all_day: false,
    recurrence: '',
    ical_uid: 'uid-1',
    guests: [],
    reminder: 10,
    busy_status: 'busy',
    visibility: 'default',
}

const driveFolder: ParsedDriveFolder = { recordType: 'drive_folder', path: 'Docs', name: 'Docs' }

const driveFile: ParsedDriveFile = {
    recordType: 'drive_file',
    path: 'Docs/a.txt',
    name: 'a.txt',
    parentPath: 'Docs',
    mime_type: 'text/plain',
    size: 5,
    bytes: new ArrayBuffer(5),
}

const mailThread: ParsedMailThread = {
    recordType: 'mail_thread',
    gmailThreadId: 'g1',
    subject: 'Hello',
    snippet: 'Hi there',
    folder: 'inbox',
    is_read: false,
    is_starred: false,
    labels: ['Receipts'],
    messages: [
        {
            message_id: '<m1@x>',
            in_reply_to: '<m0@x>',
            sender_name: 'Ada',
            sender_email: 'ada@example.com',
            recipients_to: [{ name: 'Bob', email: 'bob@example.com' }],
            recipients_cc: [],
            date: '2026-01-01T00:00:00Z',
            subject: 'Hello',
            snippet: 'Hi there',
            body_html: '<p>Hi</p>',
            has_attachments: true,
            attachments: [
                { filename: 'a.pdf', mime_type: 'application/pdf', bytes: new ArrayBuffer(3) },
            ],
        },
    ],
}

async function runFullImport() {
    const { pb, recorded } = recordingPb()
    const inserter = createBatchInserter({
        pb,
        context: { userId: 'u1', mailboxId: 'mb1' },
        onProgress: () => {},
    })
    await inserter.insertRecords([
        // Three contacts, one per dedup branch (uid / email / name pair).
        contact({ vcard_uid: 'v1', first_name: 'Ada' }),
        contact({ email: 'ada@example.com' }),
        contact({ first_name: 'Ada', last_name: 'Lovelace' }),
        calendar,
        calendarEvent,
        driveFolder,
        driveFile,
        mailThread,
    ])
    return recorded
}

// The full mirror contract: every dedup/poll filter and every create payload,
// per foreign collection. Exact sets, so an added, dropped, or renamed field
// goes red instead of silently matching zero rows live.
const EXPECTED_FILTERS: Record<string, string[]> = {
    contacts: [
        'email = {:email} && owner = {:owner}',
        'first_name = {:first} && last_name = {:last} && owner = {:owner}',
        'vcard_uid = {:uid}',
    ],
    calendar_calendars: ['name = {:name}'],
    calendar_events: ['calendar = {:cal}', 'ical_uid = {:uid}'],
    drive_items: [
        'name = {:name} && parent = {:parent}',
        'name = {:name} && parent = {:parent} && is_folder = true',
    ],
    labels: ['name = {:name} && user = {:user}'],
    mail_messages: ['message_id = {:mid}'],
}

const EXPECTED_CREATE_KEYS: Record<string, string[][]> = {
    contacts: Array(3).fill(
        [
            'company',
            'email',
            'favorite',
            'first_name',
            'id',
            'job_title',
            'last_name',
            'notes',
            'owner',
            'phone',
            'vcard_uid',
        ].sort()
    ),
    calendar_calendars: [['color', 'id', 'name'].sort()],
    calendar_events: [
        [
            'all_day',
            'busy_status',
            'calendar',
            'created_by',
            'description',
            'end',
            'guests',
            'ical_uid',
            'id',
            'location',
            'recurrence',
            'reminder',
            'start',
            'title',
            'visibility',
        ].sort(),
    ],
    drive_items: [
        // folder, then file (adds the blob)
        [
            'created_by',
            'description',
            'id',
            'is_folder',
            'mime_type',
            'name',
            'parent',
            'size',
        ].sort(),
        [
            'created_by',
            'description',
            'file',
            'id',
            'is_folder',
            'mime_type',
            'name',
            'parent',
            'size',
        ].sort(),
    ],
    drive_shares: Array(2).fill(['created_by', 'id', 'item', 'role', 'user'].sort()),
    labels: [['color', 'id', 'name', 'user'].sort()],
    mail_threads: [
        ['latest_date', 'mailbox', 'message_count', 'participants', 'snippet', 'subject'].sort(),
    ],
    mail_messages: [
        [
            'attachments',
            'body_html',
            'date',
            'has_attachments',
            'in_reply_to',
            'message_id',
            'recipients_cc',
            'recipients_to',
            'sender_email',
            'sender_name',
            'snippet',
            'subject',
            'thread',
        ].sort(),
    ],
    mail_thread_state: [['folder', 'is_read', 'is_starred', 'thread', 'user'].sort()],
    label_assignments: [['collection', 'label', 'record_id', 'user'].sort()],
}

describe('batch inserter mirrored-schema contract', () => {
    it('touches exactly the expected collections', async () => {
        const recorded = await runFullImport()
        expect([...recorded.createKeys.keys()].sort()).toEqual(
            Object.keys(EXPECTED_CREATE_KEYS).sort()
        )
        expect([...recorded.filters.keys()].sort()).toEqual(Object.keys(EXPECTED_FILTERS).sort())
    })

    it('uses exactly the owning packages’ field names in every filter', async () => {
        const recorded = await runFullImport()
        for (const [collection, filters] of Object.entries(EXPECTED_FILTERS)) {
            expect([...(recorded.filters.get(collection) ?? [])].sort(), collection).toEqual(
                filters
            )
        }
    })

    it('creates records with exactly the owning packages’ field names', async () => {
        const recorded = await runFullImport()
        for (const [collection, keySets] of Object.entries(EXPECTED_CREATE_KEYS)) {
            expect(recorded.createKeys.get(collection), collection).toEqual(keySets)
        }
    })

    it('carries no residue of the deleted multi-org schema anywhere', async () => {
        const recorded = await runFullImport()
        const everything = [
            ...[...recorded.filters.values()].flatMap(s => [...s]),
            ...[...recorded.createKeys.values()].flat(2),
        ].join(' ')
        expect(everything).not.toContain('user_org')
        expect(everything).not.toMatch(/\borg\b/)
    })
})
