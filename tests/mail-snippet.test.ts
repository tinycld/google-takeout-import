import { describe, expect, it } from 'vitest'
import { parseMailMessage } from '~/tinycld/google-takeout-import/lib/takeout-import/parsers/mail'

const htmlMessage = (html: string) =>
    new TextEncoder().encode(
        [
            'From: Sender <sender@example.org>',
            'Subject: Hi',
            'Content-Type: text/html; charset=utf-8',
            '',
            html,
        ].join('\r\n')
    )

const snippetOf = (html: string) => parseMailMessage(htmlMessage(html))?.snippet

describe('mail snippet', () => {
    it('leaves out the head, style and script content', () => {
        const html =
            '<html><head><title>Newsletter</title><style>#outlook a { padding:0; }</style></head>' +
            '<body><style>.cta{border-top:12px solid}</style><script>track()</script>' +
            '<!-- preheader --><p>Hi Nathan</p></body></html>'
        expect(snippetOf(html)).toBe('Hi Nathan')
    })

    it('decodes each entity once', () => {
        expect(
            snippetOf('<p>Tom &amp; Jerry say &quot;&amp;lt;&quot; &#39;&#x41;&#66;&#39;</p>')
        ).toBe(`Tom & Jerry say "&lt;" 'AB'`)
    })

    it('keeps a header element that is not the document head', () => {
        expect(snippetOf('<header>Your order</header><p>shipped</p>')).toBe('Your order shipped')
    })
})
