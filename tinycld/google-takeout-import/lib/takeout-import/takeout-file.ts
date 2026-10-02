import type { TakeoutFile } from './types'

/** A web `File` (or any Blob with a name), read with `Blob.slice`. */
export function webTakeoutFile(file: Blob & { name: string }): TakeoutFile {
    return {
        name: file.name,
        byteLength: async () => file.size,
        readRange: async (start, length) =>
            new Uint8Array(await file.slice(start, start + length).arrayBuffer()),
    }
}

// expo-file-system is imported lazily so this module stays loadable in
// vitest's node environment (same pattern as drive's save-to-drive).
async function openNativeFile(uri: string) {
    const { File } = await import('expo-file-system')
    return new File(uri)
}

/** A picked native document, read through a `FileHandle` at an offset. */
export function nativeTakeoutFile(uri: string, name: string): TakeoutFile {
    return {
        name,
        byteLength: async () => (await openNativeFile(uri)).size,
        readRange: async (start, length) => {
            const handle = (await openNativeFile(uri)).open()
            try {
                handle.offset = start
                return handle.readBytes(length)
            } finally {
                handle.close()
            }
        },
    }
}
