import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { MboxSplitter } from '~/tinycld/google-takeout-import/lib/takeout-import/parsers/mbox-splitter'

const decoder = new TextDecoder()

function split(chunks: Uint8Array[]) {
    const splitter = new MboxSplitter()
    const out = chunks.flatMap(chunk => splitter.push(chunk))
    return [...out, ...splitter.end()].map(m => decoder.decode(m))
}

const MBOX = [
    'From 1@xxx Mon\r\nSubject: one\r\n\r\nbody one\r\n',
    'From 2@xxx Tue\r\nSubject: two\r\n\r\n>From quoted, not a separator\r\nMail From someone\r\n',
    'From 3@xxx Wed\r\nSubject: three\r\n\r\nlast',
]

describe('MboxSplitter', () => {
    it('splits a whole mbox into its messages', () => {
        expect(split([strToU8(MBOX.join(''))])).toEqual(MBOX)
    })

    it('finds every separator wherever a chunk boundary falls', () => {
        const bytes = strToU8(MBOX.join(''))
        for (let cut = 1; cut < bytes.length; cut++) {
            const result = split([bytes.subarray(0, cut), bytes.subarray(cut)])
            expect(result, `cut at ${cut}`).toEqual(MBOX)
        }
    })

    it('handles one-byte chunks', () => {
        const bytes = strToU8(MBOX.join(''))
        const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1))
        expect(split(chunks)).toEqual(MBOX)
    })

    it('reports bytes before the first separator instead of dropping them', () => {
        expect(split([strToU8(`garbage\n${MBOX[0]}`)])).toEqual(['garbage\n', MBOX[0]])
    })

    it('ignores whitespace before the first separator', () => {
        expect(split([strToU8(`\n\n${MBOX[0]}`)])).toEqual([MBOX[0]])
    })

    it('emits nothing for an empty stream', () => {
        expect(split([])).toEqual([])
    })
})
