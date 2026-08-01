import { unzip } from 'fflate'
import type { TakeoutFile } from './types'

/**
 * Streaming zip access. The old pipeline decompressed every entry of every zip
 * into a single retained `Map<string, Uint8Array>` and did it twice (detect +
 * import), so a multi-GB export fully materialized in memory. These helpers
 * decompress one entry at a time and never retain the full set:
 *
 * - `scanZipEntries` reads entry names + uncompressed sizes from the zip
 *   directory and only decompresses the (small) entries a caller opts into via
 *   `wantContent`. Drive-file and attachment payloads are never decompressed
 *   here, so detection is cheap.
 * - `streamZipEntries` decompresses entries sequentially, handing each entry's
 *   complete bytes to `onEntry` and releasing them before reading the next.
 */

export interface ScannedEntry {
    path: string
    /** Uncompressed size in bytes, from the zip directory (no decompression). */
    originalSize: number
}

/**
 * Walk every entry across all zips. For each, `wantContent(entry)` decides
 * whether to decompress it; when it decompresses, `onContent(path, bytes)` is
 * called. Returns the total uncompressed byte size across all entries.
 */
export async function scanZipEntries(
    files: TakeoutFile[],
    wantContent: (entry: ScannedEntry) => boolean,
    onContent: (path: string, bytes: Uint8Array) => void
): Promise<number> {
    let totalSize = 0

    for (const file of files) {
        const buffer = await file.arrayBuffer()
        const uint8 = new Uint8Array(buffer)

        const decompressed = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
            unzip(
                uint8,
                {
                    filter: info => {
                        totalSize += info.originalSize
                        return wantContent({ path: info.name, originalSize: info.originalSize })
                    },
                },
                (err, result) => {
                    if (err) reject(err)
                    else resolve(result)
                }
            )
        })

        for (const [path, bytes] of Object.entries(decompressed)) {
            onContent(path, bytes)
        }
    }

    return totalSize
}

/**
 * Decompress entries one at a time. `onEntry` receives each entry's complete
 * bytes; the bytes are dropped once it resolves, before the next entry is read.
 */
export async function streamZipEntries(
    files: TakeoutFile[],
    onEntry: (path: string, bytes: Uint8Array) => void | Promise<void>
): Promise<void> {
    for (const file of files) {
        const buffer = await file.arrayBuffer()
        const uint8 = new Uint8Array(buffer)
        await streamOneZip(uint8, onEntry)
    }
}

// Decompress one entry at a time via the CENTRAL DIRECTORY, not fflate's
// streaming `Unzip`. Google Takeout writes data-descriptor entries (bit 3: the
// local header carries no sizes), which forces a streaming reader to scan the
// byte stream for the next header signature — and a Drive export contains
// docx/pptx/xlsx payloads that are themselves zips. Deflate stores their
// already-compressed bytes in STORED blocks, i.e. verbatim, so the INNER
// archives' "PK\x03\x04" headers appear literally inside the outer entry's
// compressed stream. fflate's scanner misparsed those as new outer entries:
// it fabricated phantom entries and failed with "unexpected EOF" / "invalid
// distance" on the real takeout fixture. The central directory at the end of
// the file has authoritative offsets and sizes, so enumerating from it is
// immune — and inflating one filtered entry per `unzip` call keeps the
// bounded-memory property this module exists for.
async function streamOneZip(
    zipBytes: Uint8Array,
    onEntry: (path: string, bytes: Uint8Array) => void | Promise<void>
): Promise<void> {
    // Enumerate names in central-directory order without decompressing.
    const names: string[] = []
    await new Promise<void>((resolve, reject) => {
        unzip(
            zipBytes,
            {
                filter: info => {
                    names.push(info.name)
                    return false
                },
            },
            err => (err ? reject(err) : resolve())
        )
    })

    for (let target = 0; target < names.length; target++) {
        // Match by position, not name — zip files may carry duplicate names,
        // and the filter is invoked in the same central-directory order the
        // enumeration pass saw.
        let index = 0
        const single = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
            unzip(zipBytes, { filter: () => index++ === target }, (err, result) =>
                err ? reject(err) : resolve(result)
            )
        })
        const bytes = single[names[target]]
        if (bytes) await onEntry(names[target], bytes)
    }
}
