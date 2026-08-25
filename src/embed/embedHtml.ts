/**
 * HTML fragment builders for embedded kUML diagrams (Markdown fence renderer
 * and AsciiDoc processors). Every builder returns exactly one root
 * `<div class="kuml-embed …">` element. No `vscode` import here — kept pure
 * so it's unit-testable in plain Node.
 *
 * These fragments are inlined into previews that do NOT run an output
 * sanitizer of their own (see the note on `svgSanitize.ts`) — escaping here
 * is the only thing standing between a crafted `name`/`theme`/error string
 * and script execution in the reader's preview webview.
 */

const MAX_DETAIL_CHARS = 2000;

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeAttr(text: string): string {
    return escapeHtml(text);
}

const WARNING_TRIANGLE =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5 15 14.5H1z"/><line x1="8" y1="6" x2="8" y2="9.5"/>' +
    '<circle cx="8" cy="11.8" r="0.15" fill="currentColor" stroke="none"/></svg>';

function widthStyle(width: string | undefined): string {
    return width ? ` style="--kuml-width: ${escapeAttr(width)}"` : '';
}

export function buildPlaceholder(o: { name: string; reservedHeight?: number }): string {
    const heightStyle = o.reservedHeight ? ` style="--kuml-reserved-h: ${Math.round(o.reservedHeight)}px"` : '';
    return (
        `<div class="kuml-embed kuml-embed--placeholder" role="img" aria-label="Rendering kUML diagram: ${escapeAttr(o.name)}"${heightStyle}>` +
        `<span class="kuml-embed__dots"><i></i><i></i><i></i></span>` +
        `</div>`
    );
}

/**
 * A `kuml` block/macro whose source is empty (or whitespace-only). Distinct
 * from `buildPlaceholder`: this is a terminal, cached outcome — not "still
 * rendering" — so it must NOT show the pulsing loading dots, which would
 * otherwise animate forever for a block that will never produce a diagram.
 */
export function buildEmpty(o: { name: string }): string {
    return (
        `<div class="kuml-embed kuml-embed--notice kuml-embed--empty" role="status">` +
        `${WARNING_TRIANGLE}<span>This kUML block is empty — add DSL source to render a diagram ` +
        `(${escapeAttr(o.name)})</span>` +
        `</div>`
    );
}

export function buildDiagram(o: { svg: string; name: string; theme: string; width?: string }): string {
    return (
        `<div class="kuml-embed kuml-embed--diagram" data-kuml-theme="${escapeAttr(o.theme)}"${widthStyle(o.width)}>` +
        o.svg +
        `</div>`
    );
}

export function buildError(o: { name: string; summary: string; detail?: string }): string {
    const detail = o.detail ? o.detail.slice(0, MAX_DETAIL_CHARS) : undefined;
    const detailBlock = detail
        ? `<details><summary>Details</summary><pre>${escapeHtml(detail)}</pre></details>`
        : '';
    return (
        `<div class="kuml-embed kuml-embed--notice kuml-embed--error" role="alert">` +
        `${WARNING_TRIANGLE}<span>${escapeHtml(o.summary)} (${escapeAttr(o.name)})</span>${detailBlock}` +
        `</div>`
    );
}

export function buildCliMissing(o: { name: string }): string {
    return (
        `<div class="kuml-embed kuml-embed--notice kuml-embed--cli-missing" role="status">` +
        `${WARNING_TRIANGLE}<span>kUML CLI not found — install it or set <code>kuml.cliPath</code> ` +
        `(${escapeAttr(o.name)})</span>` +
        `</div>`
    );
}

export function buildRestricted(o: { name: string }): string {
    return (
        `<div class="kuml-embed kuml-embed--notice kuml-embed--restricted" role="status">` +
        `${WARNING_TRIANGLE}<span>kUML diagrams are not rendered in restricted (untrusted) workspaces, ` +
        `because kUML compiles and executes Kotlin script (${escapeAttr(o.name)}). Trust this workspace to enable rendering.</span>` +
        `</div>`
    );
}

export function buildBudgetNotice(o: { rendered: number; limit: number }): string {
    // `o.rendered` is the count of kUML blocks *encountered* so far (this one
    // included), not the count actually rendered — only the first `o.limit`
    // of those were rendered, the rest (including this one) were skipped.
    // The wording below must say "found"/"encountered", never "rendered",
    // or it overstates how many diagrams the document actually got (2026-08
    // review finding: with 24 blocks and a limit of 20, the notice used to
    // claim "24 rendered" when only 20 were).
    return (
        `<div class="kuml-embed kuml-embed--notice kuml-embed--budget" role="status">` +
        `${WARNING_TRIANGLE}<span>This document has more than ${o.limit} kUML diagrams (${o.rendered} found so far); ` +
        `further blocks are not rendered, to keep the preview responsive.</span>` +
        `</div>`
    );
}
