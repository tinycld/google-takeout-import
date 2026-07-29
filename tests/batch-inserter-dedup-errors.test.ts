// Dedup lookups may treat ONLY a 404 as "not found — create it" (P2-11/R3).
// Before the fix, every dedup catch swallowed ANY rejection as "not found",
// so a transient failure (network drop, auth expiry, 500) answered the
// existence check with "no" and the import minted a duplicate. These tests
// pin the narrowed contract: a non-404 aborts the row visibly (error
// accounting, no create); a 404 still proceeds to create (control).

import type PocketBase from 'pocketbase'
import { describe, expect, it } from 'vitest'
import { createBatchInserter } from '~/tinycld/google-takeout-import/lib/takeout-import/batch-inserter'
import type {
    ImportProgress,
    ParsedContact,
} from '~/tinycld/google-takeout-import/lib/takeout-import/types'

function contact(): ParsedContact {
    return {
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
}

function pbWithLookupRejection(rejection: unknown) {
    const creates: string[] = []
    const pb = {
        collection: (name: string) => ({
            getFirstListItem: () => Promise.reject(rejection),
            getList: () => Promise.resolve({ items: [] }),
            create: () => {
                creates.push(name)
                return Promise.resolve({ id: 'rec_1' })
            },
        }),
        filter: (expr: string) => expr,
    } as unknown as PocketBase
    return { pb, creates }
}

async function runOneContact(rejection: unknown) {
    const { pb, creates } = pbWithLookupRejection(rejection)
    const progress: Partial<ImportProgress>[] = []
    const inserter = createBatchInserter({
        pb,
        context: { userId: 'u1', mailboxId: 'mb1' },
        onProgress: (_service, update) => progress.push(update),
    })
    await inserter.insertRecords([contact()])
    return { creates, progress }
}

describe('dedup lookup failure handling', () => {
    it('a non-404 lookup failure aborts the row: no create, error surfaced', async () => {
        const { creates, progress } = await runOneContact(
            Object.assign(new Error('server exploded'), { status: 500 })
        )
        expect(creates).toEqual([])
        expect(progress).toContainEqual(
            expect.objectContaining({ errors: 1, errorMessages: ['server exploded'] })
        )
    })

    it('a rejection with no status at all is NOT "not found" either', async () => {
        const { creates } = await runOneContact(new Error('network down'))
        expect(creates).toEqual([])
    })

    it('control: a 404 still proceeds to create', async () => {
        const { creates, progress } = await runOneContact(
            Object.assign(new Error('not found'), { status: 404 })
        )
        expect(creates).toEqual(['contacts'])
        expect(progress).toContainEqual(expect.objectContaining({ imported: 1 }))
    })
})
