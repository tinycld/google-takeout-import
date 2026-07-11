import type { ParsedDriveFile, ParsedDriveFolder } from '../types'

const DRIVE_PREFIX = 'Takeout/Drive/'

const MIME_MAP: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'text/xml',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
    zip: 'application/zip',
    gz: 'application/gzip',
    md: 'text/markdown',
}

function inferMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    return MIME_MAP[ext] || 'application/octet-stream'
}

/** True for entry paths the drive importer owns (files, not Google metadata). */
export function isDrivePath(path: string): boolean {
    if (!path.startsWith(DRIVE_PREFIX)) return false
    const relativePath = path.slice(DRIVE_PREFIX.length)
    if (!relativePath) return false
    if (path.endsWith('/')) return false
    if (relativePath.endsWith('-metadata.json')) return false
    return true
}

/** Number of importable drive files, counted from entry names alone. */
export function countDriveFiles(paths: Iterable<string>): number {
    let count = 0
    for (const path of paths) {
        if (isDrivePath(path)) count++
    }
    return count
}

/**
 * Derive the folder tree from entry *names* only (no decompression). Explicit
 * directory entries and every parent directory of a file become folders,
 * sorted parents-first so they can be inserted before their children.
 */
export function foldersFromPaths(paths: Iterable<string>): ParsedDriveFolder[] {
    const folderPaths = new Set<string>()

    for (const path of paths) {
        if (!path.startsWith(DRIVE_PREFIX)) continue
        const relativePath = path.slice(DRIVE_PREFIX.length)
        if (!relativePath) continue
        if (relativePath.endsWith('-metadata.json')) continue

        if (path.endsWith('/')) {
            folderPaths.add(relativePath.replace(/\/$/, ''))
            continue
        }

        const parts = relativePath.split('/')
        for (let i = 1; i < parts.length; i++) {
            folderPaths.add(parts.slice(0, i).join('/'))
        }
    }

    return [...folderPaths]
        .filter(p => p.length > 0)
        .sort((a, b) => a.split('/').length - b.split('/').length)
        .map(
            (path): ParsedDriveFolder => ({
                recordType: 'drive_folder',
                path,
                name: path.split('/').pop() || path,
            })
        )
}

/**
 * Build a drive-file record from a single streamed entry. The entry bytes flow
 * straight into the record and on to the PocketBase create, then are released —
 * they are never accumulated across files.
 */
export function driveFileFromEntry(path: string, data: Uint8Array): ParsedDriveFile | null {
    if (!isDrivePath(path)) return null
    const relativePath = path.slice(DRIVE_PREFIX.length)
    const parts = relativePath.split('/')
    const name = parts[parts.length - 1]
    const parentPath = parts.slice(0, -1).join('/')

    return {
        recordType: 'drive_file',
        path: relativePath,
        name,
        parentPath,
        mime_type: inferMimeType(name),
        size: data.byteLength,
        bytes: new Uint8Array(data).buffer as ArrayBuffer,
    }
}
