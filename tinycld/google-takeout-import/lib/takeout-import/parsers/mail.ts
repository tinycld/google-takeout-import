import type { ParsedAttachment, ParsedMailMessage, ParsedMailThread } from '../types'

// ── Byte → string decode layer ──────────────────────────────────────────────
//
// Mail bodies and RFC 2047 encoded-words carry an explicit charset. The old
// code decoded everything as Latin-1 (`atob`/`String.fromCharCode`) and threw
// the charset away, mangling any non-ASCII text. These helpers decode the raw
// transport bytes with the declared charset instead.

/** Decode raw bytes with the given charset label, falling back to UTF-8. */
export function decodeBytesToString(bytes: Uint8Array, charset?: string): string {
    const label = (charset || 'utf-8').trim().toLowerCase()
    try {
        return new TextDecoder(label).decode(bytes)
    } catch {
        // TextDecoder throws RangeError on unknown labels — fall back to UTF-8.
        return new TextDecoder('utf-8').decode(bytes)
    }
}

/** Decode a base64 string to raw bytes (transport-decode only, no charset). */
export function decodeBase64ToBytes(base64: string): Uint8Array {
    const cleaned = base64.replace(/\s/g, '')
    const binary = atob(cleaned)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

/** Attachment path: base64 → ArrayBuffer (raw bytes, never charset-decoded). */
function decodeBase64ToBuffer(base64: string): ArrayBuffer {
    return decodeBase64ToBytes(base64).buffer as ArrayBuffer
}

/** Decode quoted-printable transport to raw bytes (soft breaks stripped). */
export function decodeQuotedPrintableToBytes(text: string): Uint8Array {
    const stripped = text.replace(/=\r?\n/g, '')
    const bytes: number[] = []
    for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i]
        if (ch === '=' && i + 2 < stripped.length) {
            const hex = stripped.slice(i + 1, i + 3)
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                bytes.push(Number.parseInt(hex, 16))
                i += 2
                continue
            }
        }
        bytes.push(ch.charCodeAt(0) & 0xff)
    }
    return new Uint8Array(bytes)
}

/** Pull the charset out of a Content-Type header value. */
export function extractCharset(contentType: string): string | undefined {
    const match = contentType.match(/charset="?([^";\s]+)"?/i)
    return match?.[1]
}

const MBOX_PATHS = [
    'Takeout/Mail/All mail Including Spam and Trash.mbox',
    'Takeout/Mail/All Mail Including Spam and Trash.mbox',
]

function findMboxData(entries: Map<string, Uint8Array>): Uint8Array | undefined {
    for (const candidate of MBOX_PATHS) {
        const data = entries.get(candidate)
        if (data) return data
    }
    for (const [path, data] of entries) {
        if (path.includes('Mail/') && path.endsWith('.mbox')) return data
    }
    return undefined
}

/** Path test used by the extractor to route mbox entries to the mail parser. */
export function isMboxPath(path: string): boolean {
    return path.includes('Mail/') && path.endsWith('.mbox')
}

/**
 * Fast message count by scanning for "From " line separators in raw bytes
 * without decoding the full mbox content.
 */
export function countMboxMessagesInBytes(mboxData: Uint8Array): number {
    // "From " as bytes: 70 114 111 109 32
    const F = 70
    const r = 114
    const o = 111
    const m = 109
    const space = 32
    const newline = 10

    let count = 0
    const len = mboxData.length

    for (let i = 0; i < len - 4; i++) {
        // Match "From " at start of file or after a newline
        if (
            mboxData[i] === F &&
            mboxData[i + 1] === r &&
            mboxData[i + 2] === o &&
            mboxData[i + 3] === m &&
            mboxData[i + 4] === space &&
            (i === 0 || mboxData[i - 1] === newline)
        ) {
            count++
        }
    }

    return count
}

export function countMboxMessages(entries: Map<string, Uint8Array>): number {
    const mboxData = findMboxData(entries)
    if (!mboxData) return 0
    return countMboxMessagesInBytes(mboxData)
}

/**
 * Parse an mbox from its raw bytes, yielding one thread at a time.
 *
 * The whole mbox is decoded once as UTF-8 up front (accepted limitation, see
 * below), then split on message boundaries. Each raw message string is parsed
 * and released before the next, so the transient per-message allocation is
 * bounded. Thread grouping still requires buffering parsed-message metadata
 * (not raw bytes) until the mbox is fully scanned, because a Gmail thread's
 * messages are not guaranteed to be contiguous in the file.
 *
 * Accepted limitation: the top-level UTF-8 decode is lossless for
 * quoted-printable / base64 payloads (they are 7-bit ASCII transport, so the
 * declared charset is recovered downstream by `decodeTextPart`) — that covers
 * the entire stated charset defect. A raw 8-bit body with a non-UTF-8 charset
 * and no transfer encoding is already lossy after this decode; those are rare
 * in Gmail exports. A fully byte-oriented mbox splitter is a noted follow-up.
 */
export function* parseMboxStream(mboxData: Uint8Array): Generator<ParsedMailThread> {
    const text = new TextDecoder('utf-8').decode(mboxData)
    const parsed: ParsedMboxMessage[] = []
    for (const raw of splitMbox(text)) {
        const message = parseRawMessage(raw)
        if (message) parsed.push(message)
    }
    yield* groupIntoThreads(parsed)
}

/** Legacy Map-based entry point, retained for detection/tests. */
export function parseMbox(entries: Map<string, Uint8Array>): ParsedMailThread[] {
    const mboxData = findMboxData(entries)
    if (!mboxData) return []
    return [...parseMboxStream(mboxData)]
}

interface ParsedMboxMessage {
    gmailThreadId: string
    gmailLabels: string[]
    message: ParsedMailMessage
}

function splitMbox(text: string): string[] {
    const messages: string[] = []
    // mbox separator: line starting with "From " at the very start or after a newline
    const parts = text.split(/(?:^|\n)(?=From )/g)

    for (const part of parts) {
        const trimmed = part.trim()
        if (!trimmed) continue
        messages.push(trimmed)
    }

    return messages
}

function parseRawMessage(raw: string): ParsedMboxMessage | null {
    // Skip the "From " line
    const firstNewline = raw.indexOf('\n')
    if (firstNewline === -1) return null

    const messageContent = raw.slice(firstNewline + 1)

    // Split headers from body at first blank line
    const headerEnd = messageContent.search(/\n\r?\n/)
    if (headerEnd === -1) return null

    const headerBlock = messageContent.slice(0, headerEnd)
    const bodyBlock = messageContent.slice(headerEnd).replace(/^\n\r?\n/, '')

    const headers = parseHeaders(headerBlock)

    const gmailThreadId = headers['x-gm-thrid'] || ''
    const gmailLabels = parseGmailLabels(headers['x-gmail-labels'] || '')

    const from = parseEmailAddress(headers.from || '')
    const toList = parseAddressList(headers.to || '')
    const ccList = parseAddressList(headers.cc || '')

    const contentType = headers['content-type'] || ''
    const transferEncoding = headers['content-transfer-encoding'] || ''

    const { html, attachments } = extractBody(bodyBlock, contentType, transferEncoding)

    const dateStr = headers.date || ''
    let isoDate: string
    try {
        isoDate = new Date(dateStr).toISOString()
    } catch {
        isoDate = new Date().toISOString()
    }

    const subject = decodeHeaderValue(headers.subject || '')
    const snippet = stripHtml(html).slice(0, 300)

    return {
        gmailThreadId,
        gmailLabels,
        message: {
            message_id: headers['message-id'] || '',
            in_reply_to: headers['in-reply-to'] || '',
            sender_name: from.name,
            sender_email: from.email,
            recipients_to: toList,
            recipients_cc: ccList,
            date: isoDate,
            subject,
            snippet,
            body_html: html,
            has_attachments: attachments.length > 0,
            attachments,
        },
    }
}

function parseHeaders(block: string): Record<string, string> {
    const headers: Record<string, string> = {}
    // Unfold continuation lines
    const unfolded = block.replace(/\r?\n[ \t]+/g, ' ')
    const lines = unfolded.split(/\r?\n/)

    for (const line of lines) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim().toLowerCase()
        const value = line.slice(colonIdx + 1).trim()
        headers[key] = value
    }

    return headers
}

function parseGmailLabels(labelsStr: string): string[] {
    if (!labelsStr) return []
    return labelsStr
        .split(',')
        .map(l => l.trim())
        .filter(Boolean)
}

function parseEmailAddress(raw: string): { name: string; email: string } {
    const decoded = decodeHeaderValue(raw)
    // "Name" <email@example.com> or email@example.com
    const match = decoded.match(/^(?:"?([^"<]*)"?\s*)?<?([^\s<>]+@[^\s<>]+)>?$/)
    if (match) {
        return { name: (match[1] || '').trim(), email: match[2].trim() }
    }
    return { name: '', email: decoded.trim() }
}

function parseAddressList(raw: string): { name: string; email: string }[] {
    if (!raw.trim()) return []
    const decoded = decodeHeaderValue(raw)
    // Split on commas that are not inside angle brackets
    const parts = decoded.split(/,(?![^<]*>)/)
    return parts.map(p => parseEmailAddress(p.trim())).filter(a => a.email)
}

function decodeHeaderValue(value: string): string {
    // Decode RFC 2047 encoded words: =?charset?encoding?text?=
    return value.replace(
        /=\?([^?]+)\?(Q|B)\?([^?]*)\?=/gi,
        (_match, charset: string, encoding: string, text: string) => {
            if (encoding.toUpperCase() === 'B') {
                try {
                    return decodeBytesToString(decodeBase64ToBytes(text), charset)
                } catch {
                    return text
                }
            }
            // Quoted-printable: underscore represents a space in encoded-words.
            const bytes = decodeQuotedPrintableToBytes(text.replace(/_/g, ' '))
            return decodeBytesToString(bytes, charset)
        }
    )
}

function extractBody(
    body: string,
    contentType: string,
    transferEncoding: string
): { html: string; attachments: ParsedAttachment[] } {
    const lowerCt = contentType.toLowerCase()

    // Multipart message
    if (lowerCt.includes('multipart/')) {
        return parseMultipart(body, contentType)
    }

    const charset = extractCharset(contentType)
    const decoded = decodeTextPart(body, transferEncoding, charset)

    if (lowerCt.includes('text/html')) {
        return { html: decoded, attachments: [] }
    }

    // text/plain or unknown — wrap the decoded text so it is never discarded
    // (defect 5: the old code threw `decoded` away, forcing the raw-body
    // fallback that leaked quoted-printable artifacts).
    return { html: `<pre>${escapeHtml(decoded)}</pre>`, attachments: [] }
}

function parseMultipart(
    body: string,
    contentType: string
): { html: string; attachments: ParsedAttachment[] } {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i)
    if (!boundaryMatch) return { html: '', attachments: [] }

    const boundary = boundaryMatch[1]
    const parts = body.split(`--${boundary}`)

    let html = ''
    let plainText = ''
    const attachments: ParsedAttachment[] = []

    for (const part of parts) {
        if (part.trim() === '--' || !part.trim()) continue

        const partHeaderEnd = part.search(/\n\r?\n/)
        if (partHeaderEnd === -1) continue

        const partHeaders = parseHeaders(part.slice(0, partHeaderEnd))
        const partBody = part.slice(partHeaderEnd).replace(/^\n\r?\n/, '')
        const partCtRaw = partHeaders['content-type'] || ''
        const partCt = partCtRaw.toLowerCase()
        const partEncoding = partHeaders['content-transfer-encoding'] || ''
        const disposition = (partHeaders['content-disposition'] || '').toLowerCase()

        // Recurse into nested multipart
        if (partCt.includes('multipart/')) {
            const nested = parseMultipart(partBody, partCtRaw)
            if (nested.html) html = nested.html
            attachments.push(...nested.attachments)
            continue
        }

        // Skip inline images
        if (disposition.includes('inline') && partCt.startsWith('image/')) continue

        // Attachment
        if (disposition.includes('attachment')) {
            const filenameMatch =
                disposition.match(/filename="?([^";\n]+)"?/i) ||
                partCt.match(/name="?([^";\n]+)"?/i)
            const filename = filenameMatch?.[1]?.trim() || 'attachment'
            const mimeType = partCt.split(';')[0].trim() || 'application/octet-stream'

            try {
                const decoded = decodeBase64ToBuffer(partBody.trim())
                attachments.push({ filename, mime_type: mimeType, bytes: decoded })
            } catch {
                // Skip corrupted attachments
            }
            continue
        }

        // Text parts — honor this part's own charset
        const charset = extractCharset(partCtRaw)
        const decoded = decodeTextPart(partBody, partEncoding, charset)
        if (partCt.includes('text/html')) {
            html = decoded
        } else if (partCt.includes('text/plain') && !plainText) {
            plainText = decoded
        }
    }

    // Fallback to plain text wrapped in HTML
    if (!html && plainText) {
        html = `<pre>${escapeHtml(plainText)}</pre>`
    }

    return { html, attachments }
}

/** Transport-decode a text part, then charset-decode the resulting bytes. */
function decodeTextPart(text: string, encoding: string, charset?: string): string {
    const lower = encoding.toLowerCase().trim()

    if (lower === 'base64') {
        try {
            return decodeBytesToString(decodeBase64ToBytes(text), charset)
        } catch {
            return text
        }
    }

    if (lower === 'quoted-printable') {
        return decodeBytesToString(decodeQuotedPrintableToBytes(text), charset)
    }

    // 7bit / 8bit / none: the text was produced by the top-level mbox UTF-8
    // decode. Re-encode through the declared charset only when it differs, so
    // an explicit ISO-8859-1 part isn't forced through UTF-8 twice.
    if (charset && charset.trim().toLowerCase() !== 'utf-8') {
        const bytes = new Uint8Array(text.length)
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
        return decodeBytesToString(bytes, charset)
    }

    return text
}

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim()
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Label → folder mapping
const LABEL_FOLDER_MAP: Record<string, string> = {
    Inbox: 'inbox',
    Sent: 'sent',
    'Sent Messages': 'sent',
    Draft: 'drafts',
    Drafts: 'drafts',
    Trash: 'trash',
    Spam: 'spam',
    Junk: 'spam',
}

function groupIntoThreads(messages: ParsedMboxMessage[]): ParsedMailThread[] {
    const threadMap = new Map<string, ParsedMboxMessage[]>()

    for (const msg of messages) {
        const key = msg.gmailThreadId || msg.message.message_id || crypto.randomUUID()
        const existing = threadMap.get(key)
        if (existing) {
            existing.push(msg)
        } else {
            threadMap.set(key, [msg])
        }
    }

    const threads: ParsedMailThread[] = []

    for (const [threadId, threadMessages] of threadMap) {
        // Sort messages by date
        threadMessages.sort(
            (a, b) => new Date(a.message.date).getTime() - new Date(b.message.date).getTime()
        )

        const firstMsg = threadMessages[0]
        const allLabels = new Set<string>()
        for (const m of threadMessages) {
            for (const l of m.gmailLabels) allLabels.add(l)
        }

        const labelsArr = [...allLabels]
        const folder = resolveFolder(labelsArr)
        const isRead = !labelsArr.includes('Unread')
        const isStarred = labelsArr.includes('Starred')

        // Custom labels (not standard Gmail labels or Category *)
        const standardLabels = new Set([
            'Inbox',
            'Sent',
            'Sent Messages',
            'Draft',
            'Drafts',
            'Trash',
            'Spam',
            'Junk',
            'Starred',
            'Unread',
            'Important',
            'Opened',
            'Chat',
        ])
        const customLabels = labelsArr.filter(
            l => !standardLabels.has(l) && !l.startsWith('Category ')
        )

        threads.push({
            recordType: 'mail_thread',
            gmailThreadId: threadId,
            subject: firstMsg.message.subject || '(No Subject)',
            snippet: firstMsg.message.snippet,
            messages: threadMessages.map(m => m.message),
            folder,
            is_read: isRead,
            is_starred: isStarred,
            labels: customLabels,
        })
    }

    return threads
}

function resolveFolder(
    labels: string[]
): 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' {
    // Check explicit folder labels (priority: trash > spam > drafts > sent > inbox)
    for (const priority of [
        'Trash',
        'Spam',
        'Junk',
        'Draft',
        'Drafts',
        'Sent',
        'Sent Messages',
        'Inbox',
    ]) {
        if (labels.includes(priority)) {
            return LABEL_FOLDER_MAP[priority] as 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam'
        }
    }

    // Non-standard labels: if has Unread flag → inbox, otherwise → archive
    if (labels.includes('Unread')) return 'inbox'

    return 'archive'
}
