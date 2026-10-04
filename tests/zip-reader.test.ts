import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
    EntryReadError,
    readEntry,
    readZipEntries,
    streamEntry,
} from '~/tinycld/google-takeout-import/lib/takeout-import/zip-reader'
import { bytesTakeoutFile, diskTakeoutFile } from './helpers/takeout-file'

const TAKEOUT_DIR = join(import.meta.dirname, 'assets', 'takeout')

// Real Takeout archives use data-descriptor entries (bit 3: no sizes in the
// local header), and the Drive export holds docx/pptx files that are zips
// themselves, whose inner "PK\x03\x04" headers appear verbatim in the outer
// entry. A header-scanning reader fabricated phantom entries from those; the
// central directory never does.
describe('readZipEntries on real takeout archives', () => {
    it('lists the Drive zip without phantom entries from embedded docx/pptx', async () => {
        const entries = await readZipEntries(
            diskTakeoutFile(join(TAKEOUT_DIR, 'takeout-20260416T000738Z-9-001.zip'))
        )
        expect(entries.map(e => e.name).sort()).toEqual([
            'Takeout/Drive/Folder #1/sample.png',
            'Takeout/Drive/Folder #1/sample.xlsx',
            'Takeout/Drive/sample.docx',
            'Takeout/Drive/sample.jpg',
            'Takeout/Drive/sample.pdf',
            'Takeout/Drive/sample.pptx',
        ])
    })

    it('reads every fixture entry to its full size', async () => {
        const names = [
            'takeout-20260416T000738Z-7-001.zip',
            'takeout-20260416T000738Z-8-001.zip',
            'takeout-20260416T000738Z-9-001.zip',
        ]
        let count = 0
        for (const name of names) {
            const file = diskTakeoutFile(join(TAKEOUT_DIR, name))
            for (const entry of await readZipEntries(file)) {
                const bytes = await readEntry(file, entry)
                expect(bytes.length, entry.name).toBe(entry.size)
                expect(bytes.length, entry.name).toBeGreaterThan(0)
                count++
            }
        }
        // 1 mbox + 4 contacts/calendar entries + 6 drive files.
        expect(count).toBe(11)
    })
})

describe('streamEntry', () => {
    const text = 'the quick brown fox '.repeat(500)
    const file = bytesTakeoutFile('t.zip', zipSync({ 'a.txt': strToU8(text) }))

    it('gives the same bytes at any read size, down to one byte', async () => {
        const [entry] = await readZipEntries(file)
        for (const chunkBytes of [1, 7, 1024, 1024 * 1024]) {
            const parts: string[] = []
            const decoder = new TextDecoder()
            await streamEntry(
                file,
                entry,
                chunk => void parts.push(decoder.decode(chunk, { stream: true })),
                chunkBytes
            )
            expect(parts.join(''), `chunk ${chunkBytes}`).toBe(text)
        }
    })

    it('reports corrupt data as an entry failure', async () => {
        const bytes = zipSync({ 'a.txt': strToU8(text) })
        const [entry] = await readZipEntries(bytesTakeoutFile('t.zip', bytes))
        const start = entry.localHeaderOffset + 30 + 'a.txt'.length
        bytes.fill(0xff, start, start + 16)
        await expect(readEntry(bytesTakeoutFile('t.zip', bytes), entry)).rejects.toBeInstanceOf(
            EntryReadError
        )
    })

    it('reports an unsupported compression method as an entry failure', async () => {
        const [entry] = await readZipEntries(file)
        await expect(readEntry(file, { ...entry, method: 12 })).rejects.toThrow(
            'a.txt: unsupported compression method 12'
        )
    })

    it('rejects a file that is not a zip', async () => {
        await expect(readZipEntries(bytesTakeoutFile('x.zip', strToU8('nope')))).rejects.toThrow(
            'x.zip is not a zip file'
        )
    })
})

// Takeout parts over 4 GB are ZIP64: the classic fields are saturated and the
// real values live in a ZIP64 end record and per-entry extra fields. Built by
// hand here, since a real one needs more than 4 GB of data.
function zip64Archive(name: string, content: Uint8Array) {
    const nameBytes = strToU8(name)
    const out: number[] = []
    const u16 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff)
    const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24)
    const u64 = (v: number) => {
        u32(v % 2 ** 32)
        u32(Math.floor(v / 2 ** 32))
    }

    // Local header, stored, sizes in a ZIP64 extra.
    u32(0x04034b50)
    u16(45)
    u16(0)
    u16(0)
    u32(0)
    u32(0)
    u32(0xffffffff)
    u32(0xffffffff)
    u16(nameBytes.length)
    u16(20)
    out.push(...nameBytes)
    u16(0x0001)
    u16(16)
    u64(content.length)
    u64(content.length)
    out.push(...content)

    // Central directory entry: sizes and offset all saturated.
    const cdOffset = out.length
    u32(0x02014b50)
    u16(45)
    u16(45)
    u16(0)
    u16(0)
    u32(0)
    u32(0)
    u32(0xffffffff)
    u32(0xffffffff)
    u16(nameBytes.length)
    u16(28)
    u16(0)
    u16(0)
    u16(0)
    u32(0)
    u32(0xffffffff)
    out.push(...nameBytes)
    u16(0x0001)
    u16(24)
    u64(content.length)
    u64(content.length)
    u64(0)
    const cdSize = out.length - cdOffset

    // ZIP64 end record, locator, then a saturated classic EOCD.
    const zip64EocdOffset = out.length
    u32(0x06064b50)
    u64(44)
    u16(45)
    u16(45)
    u32(0)
    u32(0)
    u64(1)
    u64(1)
    u64(cdSize)
    u64(cdOffset)
    u32(0x07064b50)
    u32(0)
    u64(zip64EocdOffset)
    u32(1)
    u32(0x06054b50)
    u16(0)
    u16(0)
    u16(0xffff)
    u16(0xffff)
    u32(0xffffffff)
    u32(0xffffffff)
    u16(0)
    return new Uint8Array(out)
}

describe('ZIP64', () => {
    it('reads entries through the ZIP64 end record and extra fields', async () => {
        const content = strToU8('zip64 payload')
        const file = bytesTakeoutFile('big.zip', zip64Archive('Takeout/Mail/x.mbox', content))
        const [entry] = await readZipEntries(file)
        expect(entry).toMatchObject({
            name: 'Takeout/Mail/x.mbox',
            size: content.length,
            compressedSize: content.length,
            localHeaderOffset: 0,
        })
        expect(await readEntry(file, entry)).toEqual(content)
    })
})
