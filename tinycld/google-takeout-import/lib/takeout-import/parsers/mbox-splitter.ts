const FROM_LINE = [70, 114, 111, 109, 32] // "From "
const NEWLINE = 10

// Bytes kept back from the end of each chunk: a "From " separator split across
// two chunks is only recognised once its last byte has arrived.
const HOLD_BACK = FROM_LINE.length

function isFromLineAt(buf: Uint8Array, i: number) {
    for (let k = 0; k < FROM_LINE.length; k++) {
        if (buf[i + k] !== FROM_LINE[k]) return false
    }
    return true
}

function nextLineStart(buf: Uint8Array, from: number) {
    const nl = buf.indexOf(NEWLINE, from)
    return nl === -1 ? -1 : nl + 1
}

function concat(parts: Uint8Array[]) {
    if (parts.length === 1) return parts[0]
    const total = parts.reduce((sum, p) => sum + p.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
        out.set(p, offset)
        offset += p.length
    }
    return out
}

function hasContent(bytes: Uint8Array) {
    // Anything other than whitespace (space, tab, CR, LF).
    return bytes.some(b => b !== 32 && b !== 9 && b !== 13 && b !== 10)
}

/**
 * Splits an mbox into raw messages as its bytes stream in, so only the message
 * being assembled is held. Each emitted message starts with its "From " line.
 * Bytes before the first separator are emitted too when they hold anything, so
 * a damaged start of file is reported as an unreadable message, not lost.
 */
export class MboxSplitter {
    private parts: Uint8Array[] = []
    private held = new Uint8Array(0)
    private atLineStart = true
    private seenSeparator = false

    /** Feed the next chunk; returns the messages it completed. */
    push(chunk: Uint8Array): Uint8Array[] {
        const buf = concat([this.held, chunk])
        const limit = buf.length - HOLD_BACK
        if (limit <= 0) {
            this.held = buf.slice()
            return []
        }

        const completed: Uint8Array[] = []
        let segmentStart = 0
        let pos = this.atLineStart ? 0 : nextLineStart(buf, 0)
        while (pos !== -1 && pos < limit) {
            if (isFromLineAt(buf, pos)) {
                this.finishSegment(buf.subarray(segmentStart, pos), completed)
                segmentStart = pos
            }
            pos = nextLineStart(buf, pos)
        }

        this.parts.push(buf.subarray(segmentStart, limit))
        this.atLineStart = buf[limit - 1] === NEWLINE
        this.held = buf.slice(limit)
        return completed
    }

    /** Flush the last message once the stream has ended. */
    end(): Uint8Array[] {
        this.parts.push(this.held)
        this.held = new Uint8Array(0)
        const last = concat(this.parts)
        this.parts = []
        return hasContent(last) ? [last] : []
    }

    private finishSegment(tail: Uint8Array, completed: Uint8Array[]) {
        this.parts.push(tail)
        const message = concat(this.parts)
        this.parts = []
        if (this.seenSeparator || hasContent(message)) completed.push(message)
        this.seenSeparator = true
    }
}
