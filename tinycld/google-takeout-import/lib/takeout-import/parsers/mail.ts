import type { ParsedAttachment, ParsedMailMessage } from '../types'

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

/**
 * Attachment path: transport-decode to raw bytes, never charset-decoded.
 * Attachments are usually base64, but quoted-printable and unencoded 7bit/8bit
 * parts are legal and must not be treated as corrupt base64.
 */
function decodeAttachmentBytes(body: string, encoding: string): ArrayBuffer {
    const lower = encoding.toLowerCase().trim()
    if (lower === 'base64') return decodeBase64ToBytes(body.trim()).buffer as ArrayBuffer
    if (lower === 'quoted-printable')
        return decodeQuotedPrintableToBytes(body).buffer as ArrayBuffer
    return new TextEncoder().encode(body).buffer as ArrayBuffer
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

/** Path test used by the extractor to route mbox entries to the mail parser. */
export function isMboxPath(path: string): boolean {
    return path.includes('Mail/') && path.endsWith('.mbox')
}

const NEWLINE = 10
const messageDecoder = new TextDecoder('utf-8')

export interface MailAddress {
    name: string
    email: string
}

/** What the plan pass needs from a message: its headers, never its body. */
export interface MailHeaderInfo {
    gmailThreadId: string
    messageId: string
    date: string
    subject: string
    labels: string[]
    participants: MailAddress[]
}

// End of the header block in raw bytes: the first blank line ("\n\n" or
// "\n\r\n"), or the whole message when it has no body.
function headerByteEnd(raw: Uint8Array) {
    for (let nl = raw.indexOf(NEWLINE); nl !== -1; nl = raw.indexOf(NEWLINE, nl + 1)) {
        if (raw[nl + 1] === NEWLINE) return nl
        if (raw[nl + 1] === 13 && raw[nl + 2] === NEWLINE) return nl
    }
    return raw.length
}

interface RawParts {
    headers: Record<string, string>
    body: string
}

// Each message is decoded on its own, as UTF-8. That is lossless for
// quoted-printable / base64 payloads (7-bit ASCII transport, so the declared
// charset is recovered downstream by `decodeTextPart`). A raw 8-bit body with
// a non-UTF-8 charset and no transfer encoding stays lossy; those are rare in
// Gmail exports.
function splitRawMessage(raw: string): RawParts | null {
    // Skip the "From " line
    const firstNewline = raw.indexOf('\n')
    if (firstNewline === -1) return null

    const messageContent = raw.slice(firstNewline + 1)

    // Split headers from body at the first blank line. A message with an empty
    // body has none once the mbox chunk is trimmed — it is all headers.
    const headerEnd = messageContent.search(/\n\r?\n/)
    const headerBlock = headerEnd === -1 ? messageContent : messageContent.slice(0, headerEnd)
    const body = headerEnd === -1 ? '' : messageContent.slice(headerEnd).replace(/^\n\r?\n/, '')
    return { headers: parseHeaders(headerBlock), body }
}

function isoDate(dateHeader: string) {
    try {
        return new Date(dateHeader).toISOString()
    } catch {
        return new Date().toISOString()
    }
}

/** Header-only parse of one raw mbox message; null when it has no headers. */
export function readMailHeaders(raw: Uint8Array): MailHeaderInfo | null {
    const parts = splitRawMessage(messageDecoder.decode(raw.subarray(0, headerByteEnd(raw))).trim())
    if (!parts) return null
    const { headers } = parts
    return {
        gmailThreadId: headers['x-gm-thrid'] || '',
        messageId: headers['message-id'] || '',
        date: isoDate(headers.date || ''),
        subject: decodeHeaderValue(headers.subject || ''),
        labels: parseGmailLabels(headers['x-gmail-labels'] || ''),
        participants: [
            senderAddress(headers),
            ...parseAddressList(headers.to || ''),
            ...parseAddressList(headers.cc || ''),
        ],
    }
}

/** Full parse of one raw mbox message; null when it has no headers. */
export function parseMailMessage(raw: Uint8Array): ParsedMailMessage | null {
    const parts = splitRawMessage(messageDecoder.decode(raw).trim())
    if (!parts) return null
    const { headers, body } = parts

    const from = senderAddress(headers)
    const contentType = headers['content-type'] || ''
    const transferEncoding = headers['content-transfer-encoding'] || ''
    const { html, attachments, problems } = extractBody(body, contentType, transferEncoding)

    return {
        message_id: headers['message-id'] || '',
        in_reply_to: headers['in-reply-to'] || '',
        sender_name: from.name,
        sender_email: from.email,
        recipients_to: parseAddressList(headers.to || ''),
        recipients_cc: parseAddressList(headers.cc || ''),
        date: isoDate(headers.date || ''),
        subject: decodeHeaderValue(headers.subject || ''),
        snippet: stripHtml(html).slice(0, 300),
        body_html: html,
        has_attachments: attachments.length > 0,
        attachments,
        problems,
    }
}

// mail_messages requires a sender address, but Gmail keeps messages that have
// none: app notifications sent with no From header, and Apple Mail notes whose
// From is only a name. Fall back through the other sender headers, then to a
// reserved .invalid address so the message still imports.
export const UNKNOWN_SENDER_EMAIL = 'unknown-sender@invalid'

function senderAddress(headers: Record<string, string>): MailAddress {
    const from = parseEmailAddress(headers.from || '')
    if (from.email) return from
    for (const key of ['sender', 'reply-to', 'return-path']) {
        const fallback = parseEmailAddress(headers[key] || '')
        if (fallback.email) return { name: from.name || fallback.name, email: fallback.email }
    }
    return { name: from.name, email: UNKNOWN_SENDER_EMAIL }
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
    const decoded = decodeHeaderValue(raw).trim()
    // "Name" <email@example.com> — the name is only what precedes the brackets.
    // A bare email@example.com has no name; a bare value with no "@" is only a
    // name, never an address.
    const bracketed = decoded.match(/^(.*?)<([^<>]+)>$/)
    if (bracketed) {
        const name = bracketed[1].trim().replace(/^"(.*)"$/, '$1')
        return { name, email: bracketed[2].trim() }
    }
    if (!decoded.includes('@')) return { name: decoded.replace(/^"(.*)"$/, '$1'), email: '' }
    return { name: '', email: decoded }
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

interface BodyResult {
    html: string
    attachments: ParsedAttachment[]
    /** Parts that could not be imported; the message itself still imports. */
    problems: string[]
}

function extractBody(body: string, contentType: string, transferEncoding: string): BodyResult {
    const lowerCt = contentType.toLowerCase()

    // Multipart message
    if (lowerCt.includes('multipart/')) {
        return parseMultipart(body, contentType)
    }

    const charset = extractCharset(contentType)
    const decoded = decodeTextPart(body, transferEncoding, charset)

    if (lowerCt.includes('text/html')) {
        return { html: decoded, attachments: [], problems: [] }
    }

    // text/plain or unknown — wrap the decoded text so it is never discarded
    // (defect 5: the old code threw `decoded` away, forcing the raw-body
    // fallback that leaked quoted-printable artifacts).
    return { html: `<pre>${escapeHtml(decoded)}</pre>`, attachments: [], problems: [] }
}

function parseMultipart(body: string, contentType: string): BodyResult {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i)
    if (!boundaryMatch) {
        return {
            html: `<pre>${escapeHtml(body)}</pre>`,
            attachments: [],
            problems: ['The body has no MIME boundary, so it was imported as raw text'],
        }
    }

    const boundary = boundaryMatch[1]
    const parts = body.split(`--${boundary}`)

    let html = ''
    let plainText = ''
    const attachments: ParsedAttachment[] = []
    const problems: string[] = []

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
            problems.push(...nested.problems)
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
                const decoded = decodeAttachmentBytes(partBody, partEncoding)
                attachments.push({ filename, mime_type: mimeType, bytes: decoded })
            } catch {
                problems.push(`Attachment "${filename}" could not be decoded`)
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

    return { html, attachments, problems }
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
