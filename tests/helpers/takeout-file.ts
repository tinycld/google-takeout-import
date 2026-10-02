import { readFileSync } from 'node:fs'
import { type Zippable, zipSync } from 'fflate'
import type { TakeoutFile } from '~/tinycld/google-takeout-import/lib/takeout-import/types'

export interface RecordingTakeoutFile extends TakeoutFile {
    /** Length of every range read, in order. */
    reads: number[]
}

/** An in-memory archive that records each range read, to assert nothing loads it whole. */
export function bytesTakeoutFile(name: string, bytes: Uint8Array): RecordingTakeoutFile {
    const reads: number[] = []
    return {
        name,
        reads,
        byteLength: async () => bytes.length,
        readRange: async (start, length) => {
            reads.push(length)
            return bytes.slice(start, Math.min(bytes.length, start + length))
        },
    }
}

export function zipTakeoutFile(entries: Zippable, name = 'takeout.zip') {
    return bytesTakeoutFile(name, zipSync(entries))
}

export function diskTakeoutFile(path: string) {
    return bytesTakeoutFile(path.split('/').pop() ?? path, new Uint8Array(readFileSync(path)))
}
