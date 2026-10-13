// Running the import again after a partial failure must not duplicate mail.
// The first run of a large mailbox failed thousands of messages after their
// thread rows were made, which left empty threads behind. A second run must
// put the missing messages into those threads, not into new ones.

import type PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import { createBatchInserter } from '~/tinycld/google-takeout-import/lib/takeout-import/batch-inserter'
import type {
    MailThreadPlan,
    ParsedMailMessageRecord,
} from '~/tinycld/google-takeout-import/lib/takeout-import/types'

const thread: MailThreadPlan = {
    key: 'g1',
    subject: 'apple-n. nov',
    messageCount: 1,
    latestDate: '2024-01-29T17:34:35.000Z',
    participants: [],
    folder: 'inbox',
    isRead: true,
    isStarred: false,
    labels: [],
    messageIds: ['<m1@x>'],
}

const record: ParsedMailMessageRecord = {
    recordType: 'mail_message',
    thread,
    isEarliest: true,
    message: {
        message_id: '<m1@x>',
        in_reply_to: '',
        sender_name: 'Ada',
        sender_email: 'ada@example.com',
        recipients_to: [],
        recipients_cc: [],
        date: '2024-01-29T17:34:35.000Z',
        subject: 'apple-n. nov',
        snippet: 'statement',
        body_html: '<pre>statement</pre>',
        has_attachments: false,
        attachments: [],
        problems: [],
    },
}

function fakePb(threadRows: Record<string, string>[]) {
    const createdIn: string[] = []
    const messageThreads: string[] = []
    const snippetUpdates: string[] = []
    const pb = {
        collection: (name: string) => ({
            getList: () => Promise.resolve({ items: name === 'mail_threads' ? threadRows : [] }),
            getFirstListItem: () =>
                Promise.reject(Object.assign(new Error('not found'), { status: 404 })),
            create: (payload: Record<string, unknown> | FormData) => {
                createdIn.push(name)
                if (payload instanceof FormData) messageThreads.push(String(payload.get('thread')))
                return Promise.resolve({ id: `${name}_new` })
            },
            update: (id: string) => {
                snippetUpdates.push(id)
                return Promise.resolve({ id })
            },
        }),
        filter: (expr: string) => expr,
    } as unknown as PocketBase
    return { pb, createdIn, messageThreads, snippetUpdates }
}

async function importOnce(threadRows: Record<string, string>[]) {
    const fake = fakePb(threadRows)
    const outcomes: unknown[] = []
    const inserter = createBatchInserter({
        pb: fake.pb,
        context: { userId: 'u1', mailboxId: 'mb1' },
        onProgress: (_service, update) => outcomes.push(update),
    })
    await inserter.insertRecords([record])
    return { ...fake, outcomes }
}

describe('mail re-import', () => {
    it('puts the message into the empty thread an earlier run left', async () => {
        const { createdIn, messageThreads, snippetUpdates } = await importOnce([
            { id: 't_orphan', latest_date: '2024-01-29 17:34:35.000Z' },
        ])
        expect(createdIn).toEqual(['mail_thread_state', 'mail_messages'])
        expect(messageThreads).toEqual(['t_orphan'])
        expect(snippetUpdates).toEqual(['t_orphan'])
    })

    it('does not take an empty thread with the same subject but another date', async () => {
        const { createdIn, messageThreads } = await importOnce([
            { id: 't_other', latest_date: '2023-05-01 09:00:00.000Z' },
        ])
        expect(createdIn).toEqual(['mail_threads', 'mail_thread_state', 'mail_messages'])
        expect(messageThreads).toEqual(['mail_threads_new'])
    })
})
