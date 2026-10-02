import { Inflate } from 'fflate'
import type { TakeoutFile } from './types'

/**
 * Range-reading zip access. Nothing here loads a whole archive or a whole
 * entry unless the caller asks for one entry with `readEntry`.
 *
 * Entries are enumerated from the central directory, never by scanning local
 * headers: Google Takeout writes data-descriptor entries (bit 3, no sizes in
 * the local header), and a Drive export contains docx/pptx/xlsx files that are
 * themselves zips, whose inner "PK\x03\x04" headers appear verbatim inside the
 * outer entry's stored bytes. A header scanner misreads those as new entries.
 *
 * Decompression uses fflate's synchronous streaming `Inflate`. Its async API
 * inflates large entries in a Worker built from a blob URL, which Hermes does
 * not have, so a large entry failed on native.
 */

export interface ZipEntry {
    name: string
    method: number
    compressedSize: number
    size: number
    localHeaderOffset: number
}

/**
 * A failure to read one entry (corrupt data, unsupported compression, an entry
 * too large to hold). The import reports it against that entry and goes on;
 * any other error still stops the import.
 */
export class EntryReadError extends Error {}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_LENGTH = 22
const ZIP64_LOCATOR_LENGTH = 20
const ZIP64_EOCD_LENGTH = 56
const MAX_COMMENT_LENGTH = 0xffff
const ZIP64_EXTRA_ID = 0x0001
const STORED = 0
const DEFLATE = 8

export const READ_CHUNK_BYTES = 1024 * 1024

function u16(b: Uint8Array, o: number) {
    return b[o] | (b[o + 1] << 8)
}

function u32(b: Uint8Array, o: number) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

function u64(b: Uint8Array, o: number) {
    return u32(b, o) + u32(b, o + 4) * 2 ** 32
}

const nameDecoder = new TextDecoder('utf-8')

async function readExact(file: TakeoutFile, start: number, length: number) {
    const bytes = await file.readRange(start, length)
    if (bytes.length !== length) {
        throw new Error(`${file.name} is truncated (wanted ${length} bytes at ${start})`)
    }
    return bytes
}

function findEocd(tail: Uint8Array) {
    for (let i = tail.length - EOCD_LENGTH; i >= 0; i--) {
        if (u32(tail, i) === EOCD_SIG) return i
    }
    return -1
}

interface Directory {
    count: number
    size: number
    offset: number
}

async function readDirectoryLocation(file: TakeoutFile): Promise<Directory> {
    const fileSize = await file.byteLength()
    const tailLength = Math.min(fileSize, EOCD_LENGTH + MAX_COMMENT_LENGTH)
    const tailStart = fileSize - tailLength
    const tail = await readExact(file, tailStart, tailLength)
    const eocd = findEocd(tail)
    if (eocd === -1) throw new Error(`${file.name} is not a zip file`)

    const directory = {
        count: u16(tail, eocd + 10),
        size: u32(tail, eocd + 12),
        offset: u32(tail, eocd + 16),
    }
    const saturated =
        directory.count === 0xffff ||
        directory.size === 0xffffffff ||
        directory.offset === 0xffffffff
    if (!saturated) return directory

    // ZIP64: archives over 4 GB or 65,535 entries keep the real values in a
    // ZIP64 end record, found through the locator just before the EOCD.
    const locatorOffset = tailStart + eocd - ZIP64_LOCATOR_LENGTH
    const locator = await readExact(file, locatorOffset, ZIP64_LOCATOR_LENGTH)
    if (u32(locator, 0) !== ZIP64_LOCATOR_SIG) {
        throw new Error(`${file.name} has a damaged ZIP64 directory`)
    }
    const record = await readExact(file, u64(locator, 8), ZIP64_EOCD_LENGTH)
    if (u32(record, 0) !== ZIP64_EOCD_SIG) {
        throw new Error(`${file.name} has a damaged ZIP64 directory`)
    }
    return { count: u64(record, 32), size: u64(record, 40), offset: u64(record, 48) }
}

function applyZip64Extra(entry: ZipEntry, extra: Uint8Array) {
    for (let p = 0; p + 4 <= extra.length; ) {
        const id = u16(extra, p)
        const length = u16(extra, p + 2)
        if (id === ZIP64_EXTRA_ID) {
            // Only the saturated fields are present, in this fixed order.
            let q = p + 4
            if (entry.size === 0xffffffff) {
                entry.size = u64(extra, q)
                q += 8
            }
            if (entry.compressedSize === 0xffffffff) {
                entry.compressedSize = u64(extra, q)
                q += 8
            }
            if (entry.localHeaderOffset === 0xffffffff) {
                entry.localHeaderOffset = u64(extra, q)
            }
            return
        }
        p += 4 + length
    }
}

/** Every entry in the archive, in central-directory order. */
export async function readZipEntries(file: TakeoutFile): Promise<ZipEntry[]> {
    const directory = await readDirectoryLocation(file)
    const cd = await readExact(file, directory.offset, directory.size)
    const entries: ZipEntry[] = []

    for (let p = 0; entries.length < directory.count; ) {
        if (p + 46 > cd.length || u32(cd, p) !== CENTRAL_SIG) {
            throw new Error(`${file.name} has a damaged directory`)
        }
        const nameLength = u16(cd, p + 28)
        const extraLength = u16(cd, p + 30)
        const commentLength = u16(cd, p + 32)
        const nameStart = p + 46
        const entry: ZipEntry = {
            name: nameDecoder.decode(cd.subarray(nameStart, nameStart + nameLength)),
            method: u16(cd, p + 10),
            compressedSize: u32(cd, p + 20),
            size: u32(cd, p + 24),
            localHeaderOffset: u32(cd, p + 42),
        }
        const extraStart = nameStart + nameLength
        applyZip64Extra(entry, cd.subarray(extraStart, extraStart + extraLength))
        entries.push(entry)
        p = extraStart + extraLength + commentLength
    }

    return entries
}

async function dataOffset(file: TakeoutFile, entry: ZipEntry) {
    const header = await readExact(file, entry.localHeaderOffset, 30)
    if (u32(header, 0) !== LOCAL_SIG) {
        throw new EntryReadError(`${entry.name}: damaged entry header`)
    }
    return entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28)
}

/**
 * Decompress one entry, handing each output chunk to `onChunk` and awaiting it
 * before reading on, so nothing is read ahead of the consumer.
 */
export async function streamEntry(
    file: TakeoutFile,
    entry: ZipEntry,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
    readChunkBytes = READ_CHUNK_BYTES
): Promise<void> {
    if (entry.method !== STORED && entry.method !== DEFLATE) {
        throw new EntryReadError(`${entry.name}: unsupported compression method ${entry.method}`)
    }

    const start = await dataOffset(file, entry)
    const output: Uint8Array[] = []
    const inflater =
        entry.method === DEFLATE
            ? new Inflate(chunk => {
                  output.push(chunk)
              })
            : null
    let produced = 0

    for (let read = 0; read < entry.compressedSize; ) {
        const length = Math.min(readChunkBytes, entry.compressedSize - read)
        const chunk = await readExact(file, start + read, length)
        read += length
        if (inflater) {
            try {
                inflater.push(chunk, read === entry.compressedSize)
            } catch (err) {
                const reason = err instanceof Error ? err.message : 'corrupt data'
                throw new EntryReadError(`${entry.name}: ${reason}`)
            }
        } else {
            output.push(chunk)
        }
        for (const out of output.splice(0)) {
            produced += out.length
            await onChunk(out)
        }
    }

    if (produced !== entry.size) {
        throw new EntryReadError(`${entry.name}: ended after ${produced} of ${entry.size} bytes`)
    }
}

/** Decompress one entry whole. Use only where the consumer needs every byte at once. */
export async function readEntry(file: TakeoutFile, entry: ZipEntry): Promise<Uint8Array> {
    let bytes: Uint8Array
    try {
        bytes = new Uint8Array(entry.size)
    } catch {
        const gb = (entry.size / 1024 ** 3).toFixed(1)
        throw new EntryReadError(`${entry.name}: too large to import (${gb} GB)`)
    }
    let filled = 0
    await streamEntry(file, entry, chunk => {
        if (filled + chunk.length > bytes.length) {
            throw new EntryReadError(`${entry.name}: holds more data than its directory says`)
        }
        bytes.set(chunk, filled)
        filled += chunk.length
    })
    return bytes
}
