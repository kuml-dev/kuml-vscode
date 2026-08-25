/**
 * Sanitizes a `kuml render`-produced SVG string before it is inlined into
 * any of the three surfaces that embed it: the live-preview webview
 * (`previewPanel.ts`), the built-in Markdown preview (`embed/markdownIt.ts`),
 * and the AsciiDoc preview (`embed/asciidoc.ts`).
 *
 * In the live-preview webview this genuinely is defense-in-depth on top of
 * the panel's nonce-scoped CSP (`script-src 'nonce-<random>'` — only the
 * panel's own inline zoom-toolbar script can run).
 *
 * In the Markdown and AsciiDoc previews it is NOT defense-in-depth — it is
 * the *only* line of defense. VS Code's built-in Markdown preview renders
 * with `html: true` and no DOMPurify/output sanitizer of its own (verified
 * against `markdown-language-features`), and nothing in the AsciiDoc preview
 * pipeline re-sanitizes a `pass` block's raw HTML either. If this function
 * ever stops running before an SVG reaches either of those two webviews, an
 * SVG carrying `<script>`, `<foreignObject>`, or `on*` handlers renders with
 * full script execution in an unsandboxed(-by-us) context. Do not remove
 * this call from `embed/markdownIt.ts` / `embed/asciidoc.ts` with the
 * (outdated) reasoning that it's "just" a defense-in-depth layer.
 *
 * No `vscode` import here — kept pure so it's unit-testable in plain Node.
 */

/** Strips `<script>...</script>` blocks (including empty ones), case-insensitively. */
function stripScriptTags(svg: string): string {
    return svg.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
}

/** Strips `<foreignObject>...</foreignObject>` blocks — can smuggle arbitrary HTML/JS. */
function stripForeignObject(svg: string): string {
    return svg.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '');
}

/** Strips `on*="..."` / `on*='...'` inline event-handler attributes from any tag. */
function stripEventHandlerAttrs(svg: string): string {
    return svg.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
}

/**
 * Neutralizes `href`/`xlink:href` attributes whose value is not a same-document
 * anchor (`#...`) or an inline image data URI (`data:image/...`). External
 * references (http(s), file, javascript: URIs) are dropped entirely.
 */
function neutralizeExternalHrefs(svg: string): string {
    return svg.replace(
        /\s(xlink:href|href)\s*=\s*("([^"]*)"|'([^']*)')/gi,
        (full, attrName: string, _quoted: string, dq?: string, sq?: string) => {
            const value = (dq ?? sq ?? '').trim();
            if (value.startsWith('#') || /^data:image\//i.test(value)) {
                return full;
            }
            return '';
        },
    );
}

/** Strips a leading XML declaration and DOCTYPE so the fragment embeds cleanly into HTML. */
function stripXmlPreamble(svg: string): string {
    return svg
        .replace(/<\?xml[^>]*\?>/gi, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .trim();
}

export function sanitizeSvg(raw: string): string {
    let svg = raw;
    svg = stripXmlPreamble(svg);
    svg = stripScriptTags(svg);
    svg = stripForeignObject(svg);
    svg = stripEventHandlerAttrs(svg);
    svg = neutralizeExternalHrefs(svg);
    return svg;
}
