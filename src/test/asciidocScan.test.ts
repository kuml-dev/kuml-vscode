/**
 * Unit tests for `src/embed/asciidocScan.ts` — the regexes are a verbatim
 * port of `AsciidocBlockExtractor.kt` (`kuml-dev/kUML`), so these fixtures
 * mirror that Kotlin test suite's shape.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanAsciidocBlocks } from '../embed/asciidocScan';

test('scans a plain [source,kuml] listing block', () => {
    const doc = ['= Title', '', '[source,kuml]', '----', 'classDiagram { }', '----', ''].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], { kind: 'listing', source: 'classDiagram { }', attributes: {} });
});

test('scans a [source,kuml,name="x",width=800] listing block with attributes', () => {
    const doc = ['[source,kuml,name="x",width=800]', '----', 'a', 'b', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].source, 'a\nb');
        assert.deepEqual(blocks[0].attributes, { theme: undefined, name: 'x', width: '800' });
    }
});

test('scans a kuml::path[] block macro', () => {
    const doc = 'kuml::diagrams/login.kuml.kts[width=800]';
    const blocks = scanAsciidocBlocks(doc);
    assert.deepEqual(blocks, [
        { kind: 'macro', target: 'diagrams/login.kuml.kts', attributes: { theme: undefined, name: undefined, width: '800' } },
    ]);
});

test('scans a kuml::path[] macro with no attributes', () => {
    const doc = 'kuml::diagrams/login.kuml.kts[]';
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'macro');
});

test('ignores a [source,kuml] header with no following fence', () => {
    const doc = ['[source,kuml]', 'not a fence, just text'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 0);
});

test('tolerates a blank line between the header and the opening fence', () => {
    const doc = ['[source,kuml]', '', '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
});

test('tolerates CRLF line endings', () => {
    const doc = ['[source,kuml]', '----', 'classDiagram { }', '----'].join('\r\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    if (blocks[0].kind === 'listing') {
        // The \r remains part of the line content since scanning splits only
        // on \n — that's expected/acceptable for a line-oriented scanner and
        // doesn't affect kUML DSL parsing (trailing whitespace is insignificant).
        assert.ok(blocks[0].source.replace(/\r/g, '') === 'classDiagram { }');
    }
});

test('scans multiple blocks in document order', () => {
    const doc = [
        '[source,kuml]',
        '----',
        'first',
        '----',
        '',
        'kuml::a.kuml.kts[]',
        '',
        '[source,kuml]',
        '----',
        'second',
        '----',
    ].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].kind, 'listing');
    assert.equal(blocks[1].kind, 'macro');
    assert.equal(blocks[2].kind, 'listing');
});

test('ignores an unrelated [source,typescript] block', () => {
    const doc = ['[source,typescript]', '----', 'const x = 1;', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 0);
});

test('scans a bare [kuml] style header (no [source,...])', () => {
    const doc = ['[kuml]', '----', 'classDiagram { }', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], { kind: 'listing', source: 'classDiagram { }', attributes: {} });
});

test('a [source,kuml,login,svg] positional name+format header resolves the SAME name attributes.ts would', () => {
    // Regression test for the Round-1 fix regression: this scanner must
    // agree with `parseAsciidocAttributes` (attributes.ts) on the name for a
    // positional-only block, because the export pre-render pass (which uses
    // this scanner) and the synchronous conversion pass (which uses
    // `parseAsciidocAttributes` against the real asciidoctor.js parse tree)
    // must compute the same cache key for the same block.
    const doc = ['[source,kuml,login,svg]', '----', 'classDiagram { }', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.name, 'login');
    }
});

test('a bare [kuml,login,svg] positional name+format header also resolves to name=login', () => {
    const doc = ['[kuml,login,svg]', '----', 'classDiagram { }', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.name, 'login');
    }
});

test('kuml::path[login,svg] positional name+format macro attributes resolve to name=login', () => {
    const doc = 'kuml::diagrams/login.kuml.kts[login,svg]';
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'macro');
    if (blocks[0].kind === 'macro') {
        assert.equal(blocks[0].attributes.name, 'login');
    }
});

test('an explicit name= attribute wins over a positional token', () => {
    const doc = ['[source,kuml,name="explicit",svg]', '----', 'a', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.name, 'explicit');
    }
});

test('a quoted attribute value containing a comma is not split apart', () => {
    const doc = ['[source,kuml,theme="a,b",login]', '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.theme, 'a,b');
        assert.equal(blocks[0].attributes.name, 'login');
    }
});

test('a quoted positional name has its surrounding quotes stripped, matching parseAsciidocAttributes', () => {
    // Regression test: Asciidoctor's real $positional array for
    // `[source,kuml,"my name",svg]` is `['my name', 'svg']` — already
    // unquoted — so this scanner must strip the quotes too, or the export
    // pre-render pass computes a different cache key than the synchronous
    // pass for the exact same block (2026-08 review finding, one level
    // deeper than the Round-2 fix for the unquoted positional-name case).
    const doc = ['[source,kuml,"my name",svg]', '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.name, 'my name');
    }
});

test('a quoted positional macro name has its surrounding quotes stripped', () => {
    const doc = 'kuml::a.kuml.kts["my name",svg]';
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks[0].kind, 'macro');
    if (blocks[0].kind === 'macro') {
        assert.equal(blocks[0].attributes.name, 'my name');
    }
});

test('a block title (.My title) after the attribute list is tolerated, not just blank lines', () => {
    // Regression test: Asciidoctor accepts a block title, anchor, or further
    // attribute line between `[source,kuml]` and the opening fence — the
    // scanner previously discarded the whole block on anything but a blank
    // line there (2026-08 review finding).
    const doc = ['[source,kuml]', '.My title', '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
});

test('an anchor ([[id]]) after the attribute list is tolerated', () => {
    const doc = ['[source,kuml]', '[[anch]]', '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
});

test('a further attribute line ([#id]) after the attribute list is tolerated', () => {
    const doc = ['[source,kuml]', '[#id]', '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
});

test('title/anchor/attr metadata may combine with blank lines, in any order', () => {
    const doc = ['[source,kuml]', '', '.My title', '[[anch]]', '', '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
});

test('a kUML block inside a //// comment block is not scanned', () => {
    const doc = [
        '////',
        '[source,kuml]',
        '----',
        'commented out',
        '----',
        '////',
        '',
        '[source,kuml]',
        '----',
        'real',
        '----',
    ].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].source, 'real');
    }
});

test('a kUML block inside an ifdef::never[] whose attribute is never defined is not scanned', () => {
    const doc = [
        'ifdef::never[]',
        '[source,kuml]',
        '----',
        'excluded',
        '----',
        'endif::[]',
        '',
        '[source,kuml]',
        '----',
        'real',
        '----',
    ].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].source, 'real');
    }
});

test('a kUML block inside an ifdef whose attribute IS defined earlier in the document is scanned', () => {
    const doc = [':on:', '', 'ifdef::on[]', '[source,kuml]', '----', 'included', '----', 'endif::[]'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].source, 'included');
    }
});

test('a kUML block inside an ifndef::set[] whose attribute IS defined is not scanned', () => {
    const doc = [':set:', '', 'ifndef::set[]', '[source,kuml]', '----', 'excluded', '----', 'endif::[]'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 0);
});

test('a //// line INSIDE a kUML listing source is literal content, not a real comment delimiter (fence-blind regression)', () => {
    // Regression test: `stripNonRenderedRegions` previously ran purely
    // line-based with no notion of a `----` delimited block's content being
    // opaque, so a `////` line inside a kUML block's own source (a
    // completely legal Kotlin comment marker) toggled comment-blanking state
    // and blanked the rest of the document, destroying every subsequent
    // block (2026-08 review finding).
    const doc = [
        '[source,kuml,first]',
        '----',
        'classDiagram {',
        '  ////',
        '}',
        '----',
        '',
        '[source,kuml,second]',
        '----',
        'classDiagram { }',
        '----',
    ].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 2, `expected both blocks to survive, got: ${JSON.stringify(blocks)}`);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].source, 'classDiagram {\n  ////\n}');
    }
    assert.equal(blocks[1].kind, 'listing');
    if (blocks[1].kind === 'listing') {
        assert.equal(blocks[1].source, 'classDiagram { }');
    }
});

test('a :attr: line INSIDE a kUML listing source does not leak into ifdef state (fence-blind regression)', () => {
    // Same fence-blindness class as the //// case above, for ATTR_ENTRY: a
    // `:foo: bar`-shaped line inside a kUML block's own source must not be
    // treated as a real document attribute definition.
    const doc = [
        '[source,kuml,first]',
        '----',
        ':foo: bar',
        '----',
        '',
        'ifdef::foo[]',
        '[source,kuml,cond]',
        '----',
        'excluded',
        '----',
        'endif::[]',
    ].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1, `the ifdef::foo[] branch must stay excluded, got: ${JSON.stringify(blocks)}`);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].source, ':foo: bar');
    }
});

test('ifdef::backend-html5[] is scanned even though the document never defines it (intrinsic attribute)', () => {
    // Regression test: `backend-html5`/`basebackend-html`/`doctype-article`
    // are always set by Asciidoctor for the (default) html5/article
    // conversion this extension's preview/export always target — a common
    // idiom for HTML-only content in multi-backend documents. Before this
    // fix, only document-defined `:name:` entries populated the scanner's
    // `defined` set, so this branch was always (wrongly) excluded.
    const doc = ['ifdef::backend-html5[]', '[source,kuml]', '----', 'htmlonly', '----', 'endif::[]'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].source, 'htmlonly');
    }
});

test('ifdef::never[] still excludes an ordinary, never-defined attribute (intrinsic seeding is not a full fail-open)', () => {
    const doc = ['ifdef::never[]', '[source,kuml]', '----', 'excluded', '----', 'endif::[]'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 0);
});

test('a leading-bang :!attr: entry unsets a previously-set attribute, same as the trailing-bang form', () => {
    const doc = [':on:', ':!on:', '', 'ifdef::on[]', '[source,kuml]', '----', 'excluded', '----', 'endif::[]'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 0, ':!on: must unset :on: just like :on!: would');
});

test('a single-quoted positional name has its surrounding quotes stripped, matching the double-quoted case', () => {
    const doc = ["[source,kuml,'my name',svg]", '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.name, 'my name');
    }
});

test("a name='...' attribute value containing a space is parsed as a key=value pair, not a positional token", () => {
    const doc = ["[source,kuml,name='Login Flow']", '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.name, 'Login Flow');
    }
});

test('a single-quoted attribute value containing a comma is not split apart', () => {
    const doc = ["[source,kuml,name=x,theme='a,b']", '----', 'x', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks[0].kind, 'listing');
    if (blocks[0].kind === 'listing') {
        assert.equal(blocks[0].attributes.name, 'x');
        assert.equal(blocks[0].attributes.theme, 'a,b');
    }
});

test('an unrelated [source,java] header is never swallowed as metadata belonging to a preceding [kuml] header', () => {
    // Regression test: `BLOCK_ATTR_LINE` used to accept ANY bracketed line
    // between a block's header and its fence as tolerated metadata — this
    // must stop as soon as it sees another block's own `[source,...]`
    // header, or that other block's fenced content gets scanned as if it
    // were the kUML block's own source (2026-08 review finding).
    const doc = ['[kuml]', '', '[source,java]', '----', 'const x = 1;', '----'].join('\n');
    const blocks = scanAsciidocBlocks(doc);
    assert.equal(blocks.length, 0, `the java block must never be mistaken for a kUML block, got: ${JSON.stringify(blocks)}`);
});
