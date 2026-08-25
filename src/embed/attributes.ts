/**
 * Attribute parsing shared by the Markdown fence renderer and the AsciiDoc
 * processors. No `vscode` import — kept pure so it's unit-testable in plain
 * Node.
 */

export interface EmbedAttributes {
    theme?: string;
    name?: string;
    width?: string;
}

/** Markdown info string: 'kuml', 'kuml ', 'kuml\t', 'kuml{' — mirrors KumlMarkdownCodeFenceProvider.isApplicable. */
export function isKumlFenceInfo(info: string): boolean {
    const trimmed = info.trim();
    if (trimmed.length === 0) {
        return false;
    }
    // Info string starts with "kuml" and is immediately followed by end-of-string,
    // whitespace, or '{' (an attribute block) — but NOT another word character
    // (so "kumlx" does not match). Case-insensitive, matching the JetBrains provider.
    return /^kuml(?:$|[\s{])/i.test(trimmed);
}

const ATTR_PAIR = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*(\S+)/g;

function parseAttrPairs(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    let match: RegExpExecArray | null;
    ATTR_PAIR.lastIndex = 0;
    while ((match = ATTR_PAIR.exec(text)) !== null) {
        const key = match[1] ?? match[3];
        const value = match[2] ?? match[4];
        if (key) {
            result[key] = value ?? '';
        }
    }
    return result;
}

/** 'kuml {theme="plain" name=x width=800}' and 'kuml theme=plain name=x' both parse. */
export function parseFenceAttributes(info: string): EmbedAttributes {
    const trimmed = info.trim();
    // Strip the leading "kuml" token.
    const rest = trimmed.replace(/^kuml/i, '').trim();
    // Optional {...} wrapper — if present, parse only its contents; otherwise
    // parse the remainder of the line as space-separated key=value pairs.
    const braceMatch = rest.match(/^\{([\s\S]*)\}$/);
    const body = braceMatch ? braceMatch[1] : rest;
    const pairs = parseAttrPairs(body);

    return {
        theme: pairs.theme,
        name: pairs.name,
        width: pairs.width,
    };
}

/**
 * Asciidoctor.js hands positional attributes as an array under the `$positional`
 * key, NOT as '1'/'2'-numbered keys on the attributes object — verified against
 * a real `@asciidoctor/core` conversion (both for `block.getAttributes()` on a
 * `[source,kuml,name,svg]` listing and for the block-macro `attrs` argument on
 * `kuml::target[name,svg]`): `Object.keys(attrs)` comes back as e.g.
 * `['theme', '$positional']`, with `attrs['1']` always `undefined`.
 *
 * Where "the name" sits inside `$positional` differs by block form, because
 * Asciidoctor echoes the block's own classifier tokens back into the SAME
 * array (verified directly against @asciidoctor/core for all three forms):
 *   - block macro `kuml::target[name,svg]`               -> $positional = ['name', 'svg']
 *   - bare style block `[kuml,name,svg]`                  -> $positional = ['kuml', 'name', 'svg']            (slot 0 echoes the style)
 *   - source-style listing `[source,kuml,name,svg]`       -> $positional = ['source', 'kuml', 'name', 'svg']  (slots 0/1 echo style+language)
 * A block macro has no `style`/`language` attribute of its own, so nothing is
 * stripped there; a listing/style block does, so its own `style` value (and,
 * for `[source,...]`, its `language` value too) is stripped off the FRONT of
 * `$positional` before taking the first remaining entry as the name — that
 * first-after-classifiers slot matches CLAUDE.md's `[kuml, name, format]`
 * convention, the next slot being format (accepted, but only 'svg' is
 * honoured — anything else is ignored, never passed to the CLI).
 */
export function parseAsciidocAttributes(attrs: Record<string, unknown>): EmbedAttributes {
    const get = (key: string): string | undefined => {
        const value = attrs[key];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    };

    let positional = Array.isArray(attrs.$positional) ? [...(attrs.$positional as unknown[])] : [];
    if (typeof attrs.style === 'string' && positional[0] === attrs.style) {
        positional = positional.slice(1);
    }
    if (typeof attrs.language === 'string' && positional[0] === attrs.language) {
        positional = positional.slice(1);
    }
    const positionalName =
        typeof positional[0] === 'string' && (positional[0] as string).length > 0 ? (positional[0] as string) : undefined;

    return {
        theme: get('theme'),
        name: get('name') ?? positionalName,
        width: get('width'),
    };
}

const WIDTH_PATTERN = /^\d+(\.\d+)?(px|%|em|rem)?$/;

/** Only digits or a CSS length with a whitelisted unit; anything else -> undefined. */
export function normalizeWidth(raw: string | undefined): string | undefined {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    if (!WIDTH_PATTERN.test(trimmed)) {
        return undefined;
    }
    // Bare numbers are treated as pixels, matching CSS's own historical convention
    // for unitless lengths in places like <img width>.
    return /^\d+(\.\d+)?$/.test(trimmed) ? `${trimmed}px` : trimmed;
}
