/**
 * Unit tests for `src/embed/embedHtml.ts`. Since the Markdown preview runs
 * with no output sanitizer of its own, every fragment here MUST escape
 * user-controlled strings — that's what most of these tests check for.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildBudgetNotice,
    buildCliMissing,
    buildDiagram,
    buildError,
    buildPlaceholder,
    buildRestricted,
    escapeAttr,
    escapeHtml,
} from '../embed/embedHtml';

test('escapeHtml escapes all five special characters', () => {
    assert.equal(escapeHtml(`<script>&"'</script>`), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
});

test('escapeAttr behaves like escapeHtml', () => {
    assert.equal(escapeAttr('"><script>'), escapeHtml('"><script>'));
});

test('every builder returns exactly one root .kuml-embed div', () => {
    const fragments = [
        buildPlaceholder({ name: 'x' }),
        buildDiagram({ svg: '<svg/>', name: 'x', theme: 'kuml' }),
        buildError({ name: 'x', summary: 'boom' }),
        buildCliMissing({ name: 'x' }),
        buildRestricted({ name: 'x' }),
        buildBudgetNotice({ rendered: 21, limit: 20 }),
    ];
    for (const html of fragments) {
        const opens = (html.match(/<div class="kuml-embed/g) ?? []).length;
        assert.equal(opens, 1, `expected exactly one root div in: ${html}`);
        assert.ok(html.trim().startsWith('<div class="kuml-embed'));
        assert.ok(html.trim().endsWith('</div>'));
    }
});

test('buildError escapes a malicious name', () => {
    const html = buildError({ name: '<img src=x onerror=alert(1)>', summary: 'render failed' });
    assert.ok(!/<img/.test(html));
    assert.ok(html.includes('&lt;img'));
});

test('buildError escapes a malicious summary and detail, and puts detail in <details>', () => {
    const html = buildError({ name: 'x', summary: '<script>alert(1)</script>', detail: '<script>alert(2)</script>' });
    assert.ok(!/<script>alert/.test(html));
    assert.ok(html.includes('&lt;script&gt;alert(1)'));
    assert.ok(html.includes('<details>'));
    assert.ok(html.includes('&lt;script&gt;alert(2)'));
});

test('buildError truncates detail at 2000 characters', () => {
    const longDetail = 'x'.repeat(5000);
    const html = buildError({ name: 'n', summary: 's', detail: longDetail });
    // Only 2000 raw chars of "x" go in, and "x" needs no escaping, so the
    // detail payload length itself should be exactly 2000.
    const match = html.match(/<pre>(x+)<\/pre>/);
    assert.ok(match);
    assert.equal(match![1].length, 2000);
});

test('buildDiagram sets --kuml-width only when a width is supplied', () => {
    const withWidth = buildDiagram({ svg: '<svg/>', name: 'x', theme: 'kuml', width: '800px' });
    assert.ok(withWidth.includes('--kuml-width: 800px'));

    const withoutWidth = buildDiagram({ svg: '<svg/>', name: 'x', theme: 'kuml' });
    assert.ok(!withoutWidth.includes('--kuml-width'));
});

test('buildDiagram inlines the svg without additional escaping (it was already sanitized upstream)', () => {
    const html = buildDiagram({ svg: '<svg><rect/></svg>', name: 'x', theme: 'kuml' });
    assert.ok(html.includes('<svg><rect/></svg>'));
});

test('buildPlaceholder sets --kuml-reserved-h only when a height is supplied', () => {
    const withHeight = buildPlaceholder({ name: 'x', reservedHeight: 240 });
    assert.ok(withHeight.includes('--kuml-reserved-h: 240px'));
    const withoutHeight = buildPlaceholder({ name: 'x' });
    assert.ok(!withoutHeight.includes('--kuml-reserved-h'));
});

test('buildCliMissing and buildRestricted escape the name', () => {
    const name = '"><script>x</script>';
    for (const html of [buildCliMissing({ name }), buildRestricted({ name })]) {
        assert.ok(!/<script>x/.test(html));
    }
});

test('buildBudgetNotice mentions the found count and limit', () => {
    const html = buildBudgetNotice({ rendered: 25, limit: 20 });
    assert.ok(html.includes('25'));
    assert.ok(html.includes('20'));
});

test('buildBudgetNotice never claims more diagrams were "rendered" than the limit actually allows', () => {
    // Regression test: `rendered` counts blocks *encountered*, not actually
    // rendered — only the first `limit` of those were rendered. The word
    // "rendered" attached to the encountered-count overstates what the
    // document actually produced (2026-08 review finding).
    const html = buildBudgetNotice({ rendered: 24, limit: 20 });
    assert.ok(!/24 rendered/.test(html), `must not claim 24 were rendered when only 20 were: ${html}`);
});
