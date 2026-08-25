/**
 * Unit tests for `src/embed/attributes.ts`. Pure logic, no `vscode` import.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isKumlFenceInfo, normalizeWidth, parseAsciidocAttributes, parseFenceAttributes } from '../embed/attributes';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Asciidoctor = require('@asciidoctor/core')();

test('isKumlFenceInfo matches "kuml" alone', () => {
    assert.equal(isKumlFenceInfo('kuml'), true);
});

test('isKumlFenceInfo matches "kuml " (trailing space)', () => {
    assert.equal(isKumlFenceInfo('kuml theme=plain'), true);
});

test('isKumlFenceInfo matches "kuml\\t" (tab)', () => {
    assert.equal(isKumlFenceInfo('kuml\ttheme=plain'), true);
});

test('isKumlFenceInfo matches "kuml{...}"', () => {
    assert.equal(isKumlFenceInfo('kuml{theme="plain"}'), true);
});

test('isKumlFenceInfo is case-insensitive', () => {
    assert.equal(isKumlFenceInfo('KUML'), true);
    assert.equal(isKumlFenceInfo('KuMl theme=plain'), true);
});

test('isKumlFenceInfo rejects "kumlx" (not a real kuml fence)', () => {
    assert.equal(isKumlFenceInfo('kumlx'), false);
});

test('isKumlFenceInfo rejects an unrelated language', () => {
    assert.equal(isKumlFenceInfo('typescript'), false);
});

test('isKumlFenceInfo rejects an empty info string', () => {
    assert.equal(isKumlFenceInfo(''), false);
    assert.equal(isKumlFenceInfo('   '), false);
});

test('parseFenceAttributes parses the brace form', () => {
    const attrs = parseFenceAttributes('kuml {theme="plain" name=x width=800}');
    assert.deepEqual(attrs, { theme: 'plain', name: 'x', width: '800' });
});

test('parseFenceAttributes parses the bare key=value form', () => {
    const attrs = parseFenceAttributes('kuml theme=plain name=x');
    assert.equal(attrs.theme, 'plain');
    assert.equal(attrs.name, 'x');
    assert.equal(attrs.width, undefined);
});

test('parseFenceAttributes returns all-undefined for a bare "kuml"', () => {
    const attrs = parseFenceAttributes('kuml');
    assert.deepEqual(attrs, { theme: undefined, name: undefined, width: undefined });
});

// Positional attributes arrive from a real @asciidoctor/core conversion as an
// array under `$positional` — NOT as '1'/'2'-numbered keys (verified directly
// against @asciidoctor/core in this session: `kuml::a.kuml.kts[mydiag,svg]`
// produces `{ '$positional': ['mydiag', 'svg'] }`, `attrs['1']` is always
// `undefined`). The tests below use that real shape; the end-to-end tests
// further down additionally run an actual conversion rather than a
// hand-built attrs object, so this doesn't silently drift from reality again.

test('parseAsciidocAttributes reads positional slot 0 (the real @asciidoctor/core shape) as name', () => {
    const attrs = parseAsciidocAttributes({ $positional: ['login', 'svg'] });
    assert.equal(attrs.name, 'login');
});

test('parseAsciidocAttributes prefers an explicit "name" attribute over the positional name', () => {
    const attrs = parseAsciidocAttributes({ $positional: ['login'], name: 'explicit-name' });
    assert.equal(attrs.name, 'explicit-name');
});

test('parseAsciidocAttributes ignores a malformed/absent $positional', () => {
    assert.equal(parseAsciidocAttributes({}).name, undefined);
    assert.equal(parseAsciidocAttributes({ $positional: 'not-an-array' as unknown as unknown[] }).name, undefined);
    assert.equal(parseAsciidocAttributes({ $positional: [] }).name, undefined);
    assert.equal(parseAsciidocAttributes({ $positional: [42 as unknown as string] }).name, undefined);
});

test("parseAsciidocAttributes against a REAL @asciidoctor/core block-macro conversion reads the positional name (regression for the '1'/'2' shape that Asciidoctor never actually produces)", () => {
    let seenAttrs: Record<string, unknown> | undefined;
    const registry = Asciidoctor.Extensions.create();
    registry.blockMacro('kuml', function (this: unknown) {
        const self = this as {
            process: (fn: (parent: unknown, target: string, attrs: Record<string, unknown>) => unknown) => void;
            createBlock: (p: unknown, c: string, h: string, a: unknown, o: unknown) => unknown;
        };
        self.process((parent: unknown, _target: string, attrs: Record<string, unknown>) => {
            seenAttrs = attrs;
            return self.createBlock(parent, 'pass', '', {}, { subs: [] });
        });
    });
    Asciidoctor.convert('kuml::a.kuml.kts[login,svg]', { extension_registry: registry });

    assert.ok(seenAttrs, 'the block macro must have been invoked');
    const parsed = parseAsciidocAttributes(seenAttrs!);
    assert.equal(parsed.name, 'login');
});

test("parseAsciidocAttributes against a REAL @asciidoctor/core [source,kuml,name,svg] listing reads the positional name", () => {
    let seenAttrs: Record<string, unknown> | undefined;
    const registry = Asciidoctor.Extensions.create();
    registry.treeProcessor(function (this: unknown) {
        const self = this as { process: (fn: (doc: unknown) => unknown) => void };
        self.process((doc: unknown) => {
            const document = doc as { findBy: (sel: Record<string, string>) => Array<{ getAttributes: () => Record<string, unknown> }> };
            const [block] = document.findBy({ context: 'listing' });
            seenAttrs = block?.getAttributes();
            return doc;
        });
    });
    const source = ['[source,kuml,login,svg]', '----', 'classDiagram { }', '----'].join('\n');
    Asciidoctor.convert(source, { extension_registry: registry });

    assert.ok(seenAttrs, 'the listing block must have been found');
    const parsed = parseAsciidocAttributes(seenAttrs!);
    assert.equal(parsed.name, 'login');
});

test('parseAsciidocAttributes reads theme and width when present', () => {
    const attrs = parseAsciidocAttributes({ theme: 'plain', width: '800' });
    assert.equal(attrs.theme, 'plain');
    assert.equal(attrs.width, '800');
});

test('parseAsciidocAttributes ignores non-string / empty values', () => {
    const attrs = parseAsciidocAttributes({ theme: '', width: 42 as unknown as string });
    assert.equal(attrs.theme, undefined);
    assert.equal(attrs.width, undefined);
});

test('normalizeWidth accepts bare numbers and adds px', () => {
    assert.equal(normalizeWidth('800'), '800px');
});

test('normalizeWidth accepts an explicit unit', () => {
    assert.equal(normalizeWidth('80%'), '80%');
    assert.equal(normalizeWidth('20em'), '20em');
    assert.equal(normalizeWidth('12.5rem'), '12.5rem');
});

test('normalizeWidth rejects a CSS-injection attempt', () => {
    assert.equal(normalizeWidth('800px;background:url(evil)'), undefined);
});

test('normalizeWidth rejects an unrecognized unit', () => {
    assert.equal(normalizeWidth('800vh'), undefined);
});

test('normalizeWidth passes through undefined', () => {
    assert.equal(normalizeWidth(undefined), undefined);
});
