import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { streamZipEntries } from '~/tinycld/google-takeout-import/lib/takeout-import/streaming-unzip'
import type { TakeoutFile } from '~/tinycld/google-takeout-import/lib/takeout-import/types'

// The unit suite's synthetic zips (fflate zipSync) carry sizes in their local
// headers, so they never exercised what Google Takeout actually writes:
// data-descriptor entries (bit 3), which force a streaming reader to scan for
// header signatures. The real Drive export contains docx/pptx payloads that
// are themselves zips, whose inner "PK\x03\x04" headers appear verbatim in
// the outer deflate stream — fflate's streaming Unzip misparsed them as new
// outer entries, fabricated phantom entries (word/fonts/*.odttf, ppt/…), and
// failed the whole import with "unexpected EOF". These tests run the REAL
// fixture bytes through streamZipEntries so that failure mode stays caught.

const TAKEOUT_DIR = join(import.meta.dirname, 'assets', 'takeout')

function assetFile(name: string): TakeoutFile {
    const bytes = readFileSync(join(TAKEOUT_DIR, name))
    return {
        name,
        async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        },
    }
}

describe('streamZipEntries on real takeout archives', () => {
    it('streams the Drive zip (embedded docx/pptx archives) without phantom entries', async () => {
        const seen: string[] = []
        await streamZipEntries([assetFile('takeout-20260416T000738Z-9-001.zip')], path => {
            seen.push(path)
        })

        expect(seen.sort()).toEqual([
            'Takeout/Drive/Folder #1/sample.png',
            'Takeout/Drive/Folder #1/sample.xlsx',
            'Takeout/Drive/sample.docx',
            'Takeout/Drive/sample.jpg',
            'Takeout/Drive/sample.pdf',
            'Takeout/Drive/sample.pptx',
        ])
    })

    it('streams every fixture zip end-to-end and delivers non-empty payloads', async () => {
        const files = [
            assetFile('takeout-20260416T000738Z-7-001.zip'),
            assetFile('takeout-20260416T000738Z-8-001.zip'),
            assetFile('takeout-20260416T000738Z-9-001.zip'),
        ]
        const sizes = new Map<string, number>()
        await streamZipEntries(files, (path, bytes) => {
            sizes.set(path, bytes.length)
        })

        // 1 mbox + 4 contacts/calendar entries + 6 drive files.
        expect(sizes.size).toBe(11)
        for (const [path, size] of sizes) {
            expect(size, path).toBeGreaterThan(0)
        }
    })
})
