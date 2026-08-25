import type { EmbedAttributes } from './attributes';

/**
 * Line-based scanner for kUML blocks in an AsciiDoc document. TypeScript port
 * of `AsciidocBlockExtractor.kt` (`kuml-dev/kUML`, `kuml-docs/kuml-asciidoc`)
 * — the regexes below are copied verbatim so the two ecosystems agree on
 * syntax. Used only for the `'export'` pre-render pass (see `asciidoc.ts`);
 * the live-preview path uses asciidoctor.js's own tree processor / block
 * macro instead, which parses the *real* document tree rather than
 * approximating it line-by-line.
 *
 * No `vscode` import here — kept pure so it's unit-testable in plain Node.
 */

export type ScannedBlock =
    | { kind: 'listing'; source: string; attributes: EmbedAttributes }
    | { kind: 'macro'; target: string; attributes: EmbedAttributes };

// Matches both `[source,kuml, ...]` and the bare style form `[kuml, ...]` —
// asciidoctor.js recognizes a kUML listing block either way (see
// `isKumlListingBlock` in asciidoc.ts, which checks `language === 'kuml'` OR
// `style === 'kuml'`), so the export-time scanner must recognize both too.
// Group 1 captures whatever follows `kuml` up to the closing `]` — i.e. the
// SAME token list `parseAttributes` below receives for both forms, already
// stripped of the `source`/`kuml` classifier tokens themselves.
const LISTING_HEADER = /^\s*\[(?:source\s*,\s*)?kuml(?:\s*,\s*([^\]]*))?\s*\]\s*$/;
const LISTING_FENCE = /^\s*----\s*$/;
const BLOCK_MACRO = /^\s*kuml::([^\s[\]]+)\[([^\]]*)\]\s*$/;
const KEY_VALUE = /^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S*))$/;

// Block metadata lines Asciidoctor accepts between a block's attribute list
// header (`[source,kuml,...]` / `[kuml,...]`) and its opening `----` fence —
// a block title (`.My title`), an anchor (`[[id]]`), or any other bracketed
// attribute line (`[#id]`, `[role=x]`, `[caption="..."]`, …). Previously the
// scanner tolerated only BLANK lines there and discarded the whole block on
// anything else, even though Asciidoctor itself renders it fine (2026-08
// review finding — a block title/anchor placed after the attribute list,
// which is valid and common, e.g. for `xref` targets, silently vanished from
// the export pre-render pass and fell back to a budget-exceeded error card).
const BLOCK_TITLE = /^\s*\.[^\s.].*$/;
const BLOCK_ANCHOR = /^\s*\[\[[^\]]+\]\]\s*$/;
const BLOCK_ATTR_LINE = /^\s*\[[^[\]]*\]\s*$/;
// A bracketed line that is itself the START of an UNRELATED block (most
// commonly `[source,<other-language>]`) must never be swallowed as "metadata
// belonging to the kUML block above" just because it happens to match the
// generic `BLOCK_ATTR_LINE` shape — otherwise a `[kuml]` header with no
// content of its own (malformed, or simply followed by a blank line and a
// completely different block) causes the scanner to skip past the OTHER
// block's own header and mistake ITS fenced content for the kUML block's
// source (2026-08 review finding, reproduced with `[kuml]` / blank line /
// `[source,java]` / `----` / java source / `----`).
const OTHER_BLOCK_HEADER = /^\s*\[source\b/i;
const COMMENT_BLOCK_DELIM = /^\s*\/{4,}\s*$/;
const IFDEF = /^\s*ifdef::([^\s[\]]+)\[\]\s*$/;
const IFNDEF = /^\s*ifndef::([^\s[\]]+)\[\]\s*$/;
const ENDIF = /^\s*endif::(?:[^\s[\]]*)?\[\]\s*$/;
// Asciidoctor accepts EITHER a trailing bang (`:name!:`) OR a leading one
// (`:!name:`) to unset a previously-set attribute — both forms are
// documented, equally common syntax. Previously only the trailing form was
// recognized, so a document using `:!name:` left the attribute wrongly
// marked as still "defined" for every subsequent `ifdef::name[]` (2026-08
// review finding).
const ATTR_ENTRY = /^:(!)?([A-Za-z0-9_][A-Za-z0-9_-]*)(!)?:(?:\s+(.*))?$/;

// Intrinsic attributes Asciidoctor ALWAYS defines while converting to the
// (default) html5 backend with the (default) article doctype — which is
// exactly what this extension's preview/export always target. `ifdef::
// backend-html5[]` / `ifdef::basebackend-html[]` / `ifdef::doctype-article[]`
// are standard idioms for HTML-only content in multi-backend AsciiDoc
// documents; before this fix these names were invisible to this line
// scanner (only document-defined `:name:` entries populated the `defined`
// set), so the branch was always treated as false and a working document
// silently lost content during export (2026-08 review finding — a
// regression introduced by the ifdef/ifndef support itself).
//
// Deliberately NOT a full fail-open: an attribute name that is neither one
// of these known intrinsics nor explicitly `:name:`-defined in the document
// is still treated as undefined, preserving the existing (and correct)
// "never defined -> excluded" contract for ordinary document attributes. A
// document that explicitly `:name!:`/`:!name:`-unsets one of these
// intrinsics still wins, since it goes through the same ATTR_ENTRY handling
// as any other attribute below.
const INTRINSIC_ATTRS = ['backend-html5', 'basebackend-html', 'doctype-article'];

function isBlockMetadataLine(line: string): boolean {
    if (OTHER_BLOCK_HEADER.test(line)) {
        return false;
    }
    return line.trim().length === 0 || BLOCK_TITLE.test(line) || BLOCK_ANCHOR.test(line) || BLOCK_ATTR_LINE.test(line);
}

/**
 * Blanks out AsciiDoc regions the scanner must not treat as live document
 * content: `////`-delimited comment blocks, and `ifdef::attr[]` /
 * `ifndef::attr[]` branches whose condition the document itself resolves as
 * false via a preceding `:attr:` / `:attr!:` entry (2026-08 review finding —
 * a kUML block inside either construct was pre-rendered and counted against
 * `BLOCK_BUDGET` even though Asciidoctor's real conversion never emits it).
 *
 * Fence-aware (2026-08 review finding, Round 4): once inside a `----`
 * delimited block, its content is opaque, literal source to Asciidoctor —
 * NOT a place where `////`, `ifdef::`/`ifndef::`, or `:name:` lines carry
 * their usual directive meaning. A kUML listing's own DSL source is free to
 * contain a legal-in-Kotlin `////` comment line or a `:foo: bar`-shaped
 * line; before this fix such a line was mistaken for a real AsciiDoc
 * directive, corrupting (or entirely blanking the rest of) the document.
 * The fence toggle below is intentionally generic (ANY `----` line flips
 * it, matching `LISTING_FENCE`) rather than tied to a preceding kUML
 * header — Asciidoctor treats every `----`-delimited block's content as
 * literal the same way, regardless of language, so this stays consistent
 * with the real converter without needing to duplicate the header-matching
 * logic from `scanAsciidocBlocks` up here.
 *
 * Deliberately conservative: no nested `ifdef`/`ifndef` support (single
 * level only, matching the common case), and attribute state is only what
 * the document itself defines via `:name:`/`:name!:`/`:!name:` plus a small
 * fixed set of Asciidoctor's own intrinsic attributes (`INTRINSIC_ATTRS`) —
 * CLI-supplied `-a name=value` attributes are invisible to this line scanner
 * just like `include::` targets are (see `preRenderForExport`'s doc comment
 * in `asciidoc.ts`). Blanking (not removing) lines keeps the array length
 * stable, so nothing downstream needs to re-index.
 */
function stripNonRenderedRegions(lines: string[]): string[] {
    const out = lines.slice();
    const defined = new Set<string>(INTRINSIC_ATTRS);
    let inComment = false;
    let skipUntilEndif = false;
    let inFence = false;

    for (let i = 0; i < out.length; i++) {
        const line = out[i];

        if (inFence) {
            if (LISTING_FENCE.test(line)) {
                inFence = false;
            }
            // Leave delimited-block content completely untouched — it is
            // literal source, not AsciiDoc directive syntax.
            continue;
        }

        if (COMMENT_BLOCK_DELIM.test(line)) {
            inComment = !inComment;
            out[i] = '';
            continue;
        }
        if (inComment) {
            out[i] = '';
            continue;
        }

        if (skipUntilEndif) {
            if (ENDIF.test(line)) {
                skipUntilEndif = false;
            }
            out[i] = '';
            continue;
        }

        const attrMatch = ATTR_ENTRY.exec(line);
        if (attrMatch) {
            const [, leadingBang, name, trailingBang] = attrMatch;
            if (leadingBang || trailingBang) {
                defined.delete(name);
            } else {
                defined.add(name);
            }
            continue;
        }

        const ifdefMatch = IFDEF.exec(line);
        if (ifdefMatch) {
            if (!defined.has(ifdefMatch[1])) {
                skipUntilEndif = true;
            }
            out[i] = '';
            continue;
        }
        const ifndefMatch = IFNDEF.exec(line);
        if (ifndefMatch) {
            if (defined.has(ifndefMatch[1])) {
                skipUntilEndif = true;
            }
            out[i] = '';
            continue;
        }

        if (LISTING_FENCE.test(line)) {
            inFence = true;
            continue;
        }
    }

    return out;
}

/**
 * Splits a comma-separated attribute list on top-level commas only — a comma
 * inside a `"..."`- OR `'...'`-quoted value (e.g. `theme="a,b"` or
 * `theme='a,b'`) must not split the value apart. AsciiDoc treats both quote
 * characters equally for attribute values (2026-08 review finding — this
 * function previously tracked only `"`, so a single-quoted value containing
 * a comma was split apart exactly like the unquoted case the double-quote
 * handling was originally written to prevent). Mirrors how asciidoctor.js
 * itself tokenizes an attribute list before handing it to an extension as
 * `$positional`/named attributes.
 */
function splitTopLevelCommas(raw: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quoteChar: '"' | "'" | undefined;
    for (const ch of raw) {
        if ((ch === '"' || ch === "'") && (quoteChar === undefined || quoteChar === ch)) {
            quoteChar = quoteChar === ch ? undefined : ch;
            current += ch;
        } else if (ch === ',' && quoteChar === undefined) {
            tokens.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    tokens.push(current);
    return tokens.map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Strips one layer of surrounding `"..."` or `'...'` quotes, if present; otherwise returns the token unchanged. */
function stripQuotes(token: string): string {
    if (token.length < 2) {
        return token;
    }
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
        return token.slice(1, -1);
    }
    return token;
}

/**
 * Parses the attribute-list text captured after `kuml` in a listing header
 * (`[source,kuml,<raw>]` / `[kuml,<raw>]`) or inside a block-macro's `[...]`
 * (`kuml::target[<raw>]`). Must compute the SAME `name` that
 * `parseAsciidocAttributes` (attributes.ts) computes from asciidoctor.js's
 * real `$positional` array for the corresponding block — otherwise the
 * export pre-render pass (which uses this scanner) and the synchronous
 * conversion pass (which uses `parseAsciidocAttributes` against the real
 * parsed document) disagree on the cache key for the exact same block, and
 * every export with a positional-named block/macro hits a guaranteed cache
 * miss (see CLAUDE.md-mandated regression fix, 2026-08 review).
 *
 * Convention (matches `parseAsciidocAttributes`'s doc comment): the first
 * token that is NOT a `key=value` pair is the block's positional name; any
 * further positional token (e.g. a trailing `svg` format token) is ignored
 * here exactly as it is on the `parseAsciidocAttributes` side.
 */
function parseAttributes(raw: string): EmbedAttributes {
    if (raw.trim().length === 0) {
        return {};
    }
    const map: Record<string, string> = {};
    let positionalName: string | undefined;
    for (const token of splitTopLevelCommas(raw)) {
        const match = KEY_VALUE.exec(token);
        if (match) {
            const key = match[1];
            const value = match[2] ?? match[3] ?? match[4] ?? '';
            map[key] = value;
        } else if (positionalName === undefined) {
            // Asciidoctor hands back positional attributes already stripped
            // of their surrounding quotes (`$positional` for `[source,kuml,
            // "my name",svg]` is `[..., 'my name', 'svg']`, not `'"my name"'`)
            // — this scanner must strip them too, or a quoted positional name
            // (required whenever the name contains a space) computes a
            // different cache key here than `parseAsciidocAttributes`
            // (attributes.ts) computes from the real parsed block, and the
            // export pre-render pass warms a key the synchronous pass never
            // looks up (2026-08 review finding — same drift class the
            // Round-2 fix closed for the unquoted case, one level deeper).
            positionalName = stripQuotes(token);
        }
    }
    return { theme: map.theme, name: map.name ?? positionalName, width: map.width };
}

/** Scans an AsciiDoc document, in document order, for `[source,kuml]` listings and `kuml::path[]` macros. */
export function scanAsciidocBlocks(text: string): ScannedBlock[] {
    const lines = stripNonRenderedRegions(text.split('\n'));
    const result: ScannedBlock[] = [];
    let i = 0;

    while (i < lines.length) {
        const macroMatch = BLOCK_MACRO.exec(lines[i]);
        if (macroMatch) {
            result.push({ kind: 'macro', target: macroMatch[1], attributes: parseAttributes(macroMatch[2]) });
            i++;
            continue;
        }

        const headerMatch = LISTING_HEADER.exec(lines[i]);
        if (headerMatch) {
            const attrs = parseAttributes(headerMatch[1] ?? '');
            let j = i + 1;
            while (j < lines.length && isBlockMetadataLine(lines[j])) {
                j++;
            }
            if (j >= lines.length || !LISTING_FENCE.test(lines[j])) {
                // No listing fence follows the header — not a real block, move on.
                i++;
                continue;
            }
            let k = j + 1;
            const buf: string[] = [];
            while (k < lines.length && !LISTING_FENCE.test(lines[k])) {
                buf.push(lines[k]);
                k++;
            }
            result.push({ kind: 'listing', source: buf.join('\n'), attributes: attrs });
            i = Math.min(k + 1, lines.length);
            continue;
        }

        i++;
    }

    return result;
}
