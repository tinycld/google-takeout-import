// PocketBase checks a file field's type by sniffing the content, not by the
// declared type, and only counts content as HTML when it opens with one of a
// short list of tags. A plain-text message rendered as `<pre>…</pre>`, or an
// HTML part that opens with text, a comment or `<meta>`, sniffs as text/plain
// and fails mail_messages.body_html's text/html rule. The sniffer also wants a
// space or `>` right after the tag, so `<html\n` does not count. A leading
// doctype makes every body sniff as HTML and does not change how it renders.
const SNIFFS_AS_HTML = /^\s*<(!doctype html|html)[ >]/i

export function asHtmlDocument(html: string): string {
    const body = html || '<p></p>'
    if (SNIFFS_AS_HTML.test(body)) return body
    return `<!DOCTYPE html>\n${body}`
}
