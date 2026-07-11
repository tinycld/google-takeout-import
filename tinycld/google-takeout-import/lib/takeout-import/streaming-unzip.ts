import { Unzip, UnzipInflate, unzip } from 'fflate'
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

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
    }
    return out
}

function streamOneZip(
    zipBytes: Uint8Array,
    onEntry: (path: string, bytes: Uint8Array) => void | Promise<void>
): Promise<void> {
    return new Promise((resolve, reject) => {
        // Entries complete in order; each completed entry is queued and drained
        // sequentially so `onEntry` back-pressures reading of the next payload.
        const queue: Array<{ path: string; bytes: Uint8Array }> = []
        let draining = false
        let finished = false
        let failed = false

        const drain = async () => {
            if (draining) return
            draining = true
            try {
                while (queue.length > 0) {
                    const next = queue.shift()
                    if (!next) break
                    await onEntry(next.path, next.bytes)
                }
            } catch (err) {
                failed = true
                reject(err instanceof Error ? err : new Error(String(err)))
                return
            } finally {
                draining = false
            }
            if (finished && queue.length === 0) resolve()
        }

        const unz = new Unzip(entry => {
            const chunks: Uint8Array[] = []
            let size = 0
            entry.ondata = (err, chunk, final) => {
                if (failed) return
                if (err) {
                    failed = true
                    reject(err)
                    return
                }
                chunks.push(chunk)
                size += chunk.length
                if (final) {
                    queue.push({ path: entry.name, bytes: concatChunks(chunks, size) })
                    void drain()
                }
            }
            entry.start()
        })
        unz.register(UnzipInflate)

        try {
            unz.push(zipBytes, true)
        } catch (err) {
            failed = true
            reject(err instanceof Error ? err : new Error(String(err)))
            return
        }

        finished = true
        // If nothing was queued (empty zip) or draining already flushed, resolve.
        if (queue.length === 0 && !draining) resolve()
    })
}
