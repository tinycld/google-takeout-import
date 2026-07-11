import { describe, expect, it } from 'vitest'
import type { ParsedMailThread } from '../types'
import { parseMboxStream } from './mail'

// Build an mbox from complete raw messages (each already including its headers
// and body). A synthetic "From " envelope line is prepended per message.
function mbox(messages: string[]): Uint8Array {
    const text = messages.map(m => `From 1234567890@xxx\n${m}`).join('\n')
    return new TextEncoder().encode(text)
}

function threads(messages: string[]): ParsedMailThread[] {
    return [...parseMboxStream(mbox(messages))]
}

function onlyThread(messages: string[]): ParsedMailThread {
    const t = threads(messages)
    expect(t).toHaveLength(1)
    return t[0]
}

const HEADERS = [
    'X-GM-THRID: 1',
    'X-Gmail-Labels: Inbox',
    'Message-ID: <m1@example.com>',
    'From: sender@example.com',
    'To: rcpt@example.com',
    'Date: Wed, 01 Jan 2025 10:00:00 +0000',
]

function message(extraHeaders: string[], body: string): string {
    return [...HEADERS, ...extraHeaders, '', body].join('\n')
}

describe('parseMbox charset-aware decoding', () => {
    it('decodes a UTF-8 base64 encoded-word subject', () => {
        // "Café ☕" as UTF-8 base64
        const b64 = Buffer.from('Café ☕', 'utf-8').toString('base64')
        const t = onlyThread([
            message(
                [`Subject: =?UTF-8?B?${b64}?=`, 'Content-Type: text/plain; charset=utf-8'],
                'body'
            ),
        ])
        expect(t.messages[0].subject).toBe('Café ☕')
    })

    it('decodes a UTF-8 quoted-printable encoded-word subject', () => {
        // "naïve" — ï is C3 AF in UTF-8
        const t = onlyThread([
            message(
                ['Subject: =?UTF-8?Q?na=C3=AFve?=', 'Content-Type: text/plain; charset=utf-8'],
                'body'
            ),
        ])
        expect(t.messages[0].subject).toBe('naïve')
    })

    it('honors ISO-8859-1 charset in a quoted-printable subject (=E9 → é)', () => {
        const t = onlyThread([
            message(
                ['Subject: =?ISO-8859-1?Q?caf=E9?=', 'Content-Type: text/plain; charset=utf-8'],
                'body'
            ),
        ])
        expect(t.messages[0].subject).toBe('café')
    })

    it('decodes an encoded-word display name into sender_name', () => {
        const b64 = Buffer.from('Renée Dupont', 'utf-8').toString('base64')
        const t = onlyThread([
            message(
                [
                    `From: =?UTF-8?B?${b64}?= <renee@example.com>`,
                    'Content-Type: text/plain; charset=utf-8',
                ],
                'body'
            ),
        ])
        expect(t.messages[0].sender_name).toBe('Renée Dupont')
        expect(t.messages[0].sender_email).toBe('renee@example.com')
    })

    it('cleanly decodes a single-part text/plain quoted-printable body (=E2=80=99)', () => {
        // =E2=80=99 is the UTF-8 encoding of the right single quote (’).
        const t = onlyThread([
            message(
                [
                    'Subject: QP body',
                    'Content-Type: text/plain; charset=utf-8',
                    'Content-Transfer-Encoding: quoted-printable',
                ],
                'It=E2=80=99s working'
            ),
        ])
        expect(t.messages[0].body_html).toBe('<pre>It’s working</pre>')
        // No leaked quoted-printable artifacts in the HTML.
        expect(t.messages[0].body_html).not.toContain('=E2')
    })

    it('decodes a base64 UTF-8 body', () => {
        const b64 = Buffer.from('Grüße aus Köln', 'utf-8').toString('base64')
        const t = onlyThread([
            message(
                [
                    'Subject: b64 body',
                    'Content-Type: text/plain; charset=utf-8',
                    'Content-Transfer-Encoding: base64',
                ],
                b64
            ),
        ])
        expect(t.messages[0].body_html).toBe('<pre>Grüße aus Köln</pre>')
    })

    it('honors a per-part ISO-8859-1 charset in a multipart body', () => {
        const boundary = 'BOUND'
        const raw = [
            ...HEADERS,
            'Subject: multipart iso',
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            'Content-Type: text/plain; charset=ISO-8859-1',
            'Content-Transfer-Encoding: quoted-printable',
            '',
            'Pr=E9nom',
            `--${boundary}--`,
        ].join('\n')
        const t = onlyThread([raw])
        // The é is recovered from the ISO-8859-1 part charset (=E9), not mojibake.
        expect(t.messages[0].body_html).toContain('Prénom')
        expect(t.messages[0].body_html.startsWith('<pre>')).toBe(true)
        expect(t.messages[0].body_html).not.toContain('=E9')
    })

    it('falls back to UTF-8 for an unknown charset label without throwing', () => {
        const t = onlyThread([
            message(
                [
                    'Subject: =?x-unknown-charset?Q?hello?=',
                    'Content-Type: text/plain; charset=x-unknown-charset',
                    'Content-Transfer-Encoding: quoted-printable',
                ],
                'plain body'
            ),
        ])
        // The encoded-word text is plain ASCII, so it survives the utf-8 fallback.
        expect(t.messages[0].subject).toBe('hello')
        expect(t.messages[0].body_html).toBe('<pre>plain body</pre>')
    })

    it('groups messages sharing a Gmail thread id into one thread', () => {
        const msgA = [
            'X-GM-THRID: 99',
            'X-Gmail-Labels: Inbox',
            'Message-ID: <a@example.com>',
            'From: a@example.com',
            'Date: Wed, 01 Jan 2025 10:00:00 +0000',
            'Subject: A',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'first',
        ].join('\n')
        const msgB = [
            'X-GM-THRID: 99',
            'X-Gmail-Labels: Inbox',
            'Message-ID: <b@example.com>',
            'From: b@example.com',
            'Date: Wed, 01 Jan 2025 11:00:00 +0000',
            'Subject: B',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'second',
        ].join('\n')
        const t = threads([msgA, msgB])
        expect(t).toHaveLength(1)
        expect(t[0].messages).toHaveLength(2)
    })
})
