import {
    detectOnly,
    type FallbackCallbacks,
    runFallbackImport,
} from '@tinycld/google-takeout-import/lib/takeout-import/import-worker-fallback'
import type {
    ImportContext,
    ImportService,
    ParsedRecord,
} from '@tinycld/google-takeout-import/lib/takeout-import/types'
import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { READ_CHUNK_BYTES } from '~/tinycld/google-takeout-import/lib/takeout-import/zip-reader'
import { zipTakeoutFile } from './helpers/takeout-file'

const MBOX_PATH = 'Takeout/Mail/All mail Including Spam and Trash.mbox'

function mbox(messages: string[]): string {
    return messages.map(m => `From 123456789\n${m}`).join('\n')
}

function simpleMessage(threadId: string, subject: string, body: string): string {
    return [
        `X-GM-THRID: ${threadId}`,
        'X-Gmail-Labels: Inbox',
        `Message-ID: <${threadId}@mail>`,
        'From: Alice <alice@example.com>',
        'To: bob@example.com',
        'Date: Wed, 01 Jan 2025 10:00:00 +0000',
        'Content-Type: text/plain; charset=utf-8',
        `Subject: ${subject}`,
        '',
        body,
    ].join('\n')
}

const zipFile = (entries: Parameters<typeof zipTakeoutFile>[0]) => zipTakeoutFile(entries)

const CONTEXT: ImportContext = { userId: 'u1', mailboxId: 'mb1' }

function collectingCallbacks(overrides: Partial<FallbackCallbacks> = {}) {
    const batches: Array<{ service: ImportService; records: ParsedRecord[] }> = []
    const errors: string[] = []
    let done = false
    const callbacks: FallbackCallbacks = {
        onBatch: async (service, records) => {
            batches.push({ service, records })
        },
        onProgress: () => {},
        onDone: () => {
            done = true
        },
        onError: message => {
            errors.push(message)
        },
        ...overrides,
    }
    return { callbacks, batches, errors, isDone: () => done }
}

describe('runFallbackImport streaming', () => {
    it('streams mbox messages as records carrying their thread plan', async () => {
        const file = zipFile({
            [MBOX_PATH]: strToU8(
                mbox([
                    simpleMessage('t1', 'Hello', 'first body'),
                    simpleMessage('t2', 'World', 'second body'),
                ])
            ),
        })
        const { callbacks, batches, isDone } = collectingCallbacks()

        await runFallbackImport([file], ['mail'], CONTEXT, callbacks)

        const messages = batches
            .flatMap(b => b.records)
            .filter(r => r.recordType === 'mail_message')
        expect(messages).toHaveLength(2)
        expect(messages.map(m => m.thread.subject).sort()).toEqual(['Hello', 'World'])
        expect(isDone()).toBe(true)
    })

    it('decompresses drive-file payloads exactly once (single extraction)', async () => {
        const payload = strToU8('the file contents')
        const file = zipFile({
            'Takeout/Drive/folder/report.txt': payload,
        })
        const seenBytes: number[] = []
        const { callbacks } = collectingCallbacks({
            onBatch: async (_service, records) => {
                for (const r of records) {
                    if (r.recordType === 'drive_file') seenBytes.push(r.bytes.byteLength)
                }
            },
        })

        await runFallbackImport([file], ['drive'], CONTEXT, callbacks)

        // The single drive file's bytes reach the inserter exactly once — never
        // accumulated or re-decompressed.
        expect(seenBytes).toEqual([payload.byteLength])
    })

    it('inserts drive folders before drive files', async () => {
        const file = zipFile({
            'Takeout/Drive/a/b/deep.txt': strToU8('x'),
        })
        const order: string[] = []
        const { callbacks } = collectingCallbacks({
            onBatch: async (_service, records) => {
                for (const r of records) order.push(r.recordType)
            },
        })

        await runFallbackImport([file], ['drive'], CONTEXT, callbacks)

        const firstFileIdx = order.indexOf('drive_file')
        const lastFolderIdx = order.lastIndexOf('drive_folder')
        expect(firstFileIdx).toBeGreaterThan(-1)
        expect(lastFolderIdx).toBeGreaterThan(-1)
        expect(lastFolderIdx).toBeLessThan(firstFileIdx)
    })

    it('fires the size guard through onError at a lowered ceiling', async () => {
        const file = zipFile({
            'Takeout/Drive/big.txt': strToU8('x'.repeat(4096)),
        })
        const { callbacks, errors, batches } = collectingCallbacks({
            maxTotalUncompressedBytes: 100,
        })

        await runFallbackImport([file], ['drive'], CONTEXT, callbacks)

        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatch(/too large/i)
        // Nothing was imported once the guard tripped.
        expect(batches).toHaveLength(0)
    })

    it('rejects mail import with no mailbox (Guard B)', async () => {
        const file = zipFile({ [MBOX_PATH]: strToU8(mbox([simpleMessage('t1', 'Hi', 'b')])) })
        const { callbacks, errors, batches } = collectingCallbacks()

        await runFallbackImport([file], ['mail'], { ...CONTEXT, mailboxId: null }, callbacks)

        expect(errors).toEqual(['Mail selected but no mailbox is ready — try again in a moment.'])
        expect(batches).toHaveLength(0)
    })

    it('does not read drive payloads during detection', async () => {
        // Random bytes do not compress, so the stored payload is ~2 MB.
        const payload = crypto.getRandomValues(new Uint8Array(65536))
        const big = new Uint8Array(32 * payload.length)
        for (let i = 0; i < 32; i++)
            big.set(
                payload.map(b => b ^ i),
                i * payload.length
            )
        const file = zipFile({
            'Takeout/Drive/a.bin': big,
            'Takeout/Contacts/c.vcf': strToU8(
                'BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nEMAIL:jane@example.com\nEND:VCARD'
            ),
        })

        const detection = await detectOnly([file])

        expect(detection.hasDrive).toBe(true)
        expect(detection.driveFileCount).toBe(1)
        expect(detection.hasContacts).toBe(true)
        expect(detection.contactCount).toBe(1)
        const bytesRead = file.reads.reduce((sum, n) => sum + n, 0)
        expect(bytesRead).toBeLessThan(big.length / 4)
    })
})

describe('range reads', () => {
    it('never reads more than one chunk of an archive at a time', async () => {
        const messages = Array.from({ length: 3000 }, (_, i) =>
            simpleMessage(`t${i}`, `Subject ${i}`, 'x'.repeat(1000))
        )
        const file = zipFile({ [MBOX_PATH]: [strToU8(mbox(messages)), { level: 0 }] })

        const detection = await detectOnly([file])
        expect(detection.mailThreadCount).toBe(3000)

        const { callbacks, batches } = collectingCallbacks()
        await runFallbackImport([file], ['mail'], CONTEXT, callbacks)

        const imported = batches
            .flatMap(b => b.records)
            .filter(r => r.recordType === 'mail_message')
        expect(imported).toHaveLength(3000)
        expect(Math.max(...file.reads)).toBeLessThanOrEqual(READ_CHUNK_BYTES)
    })
})
