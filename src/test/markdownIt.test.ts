/**
 * Tests `createMarkdownItPlugin` against a REAL `markdown-it@14` instance
 * (a devDependency) — this is the actual integration surface VS Code's
 * built-in Markdown preview drives, so faking `markdown-it` itself would
 * test much less than the real thing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { BLOCK_BUDGET, createMarkdownItPlugin, type MarkdownItDeps } from '../embed/markdownIt';
import { RenderCache, computeKey } from '../render/renderCache';
import type { GateResult } from '../embed/gate';
import type { RenderOutcome } from '../render/kumlRenderer';

const ALLOWED_GATE: GateResult = {
    allowed: true,
    config: { cliPath: 'kuml', serverUrl: '', defaultTheme: 'kuml', allowPathsOutsideWorkspace: false },
    documentDir: '/proj',
};

/**
 * markdown-it's fence tokenizer includes the block's own trailing newline in
 * `token.content` (verified directly against markdown-it@14: parsing
 * "```kuml\nX\n```\n" yields `fence.content === "X\n"`, not `"X"`). Tests that
 * pre-populate the cache with a specific source string must account for that
 * so the key they compute matches the key the plugin actually looks up.
 */
function fenceContent(sourceLine: string): string {
    return `${sourceLine}\n`;
}

function makeDeps(overrides: Partial<MarkdownItDeps> = {}): MarkdownItDeps & { cache: RenderCache } {
    return {
        evaluateGate: () => ALLOWED_GATE,
        scheduleRefresh: () => undefined,
        cache: new RenderCache(),
        render: async () => ({ kind: 'empty' }) as RenderOutcome,
        ...overrides,
    };
}

test('a non-kuml fence is chained to the previous renderer (syntax highlighting survives)', () => {
    const md = new MarkdownIt();
    createMarkdownItPlugin(makeDeps())(md);
    const html = md.render('```typescript\nconst x = 1;\n```\n');
    assert.ok(html.includes('language-typescript'), 'the default fence renderer must still run for non-kuml languages');
    assert.ok(!html.includes('kuml-embed'));
});

test('a kuml fence with the feature disabled falls back to a plain code block', () => {
    const md = new MarkdownIt();
    const deps = makeDeps({ evaluateGate: () => ({ allowed: false, reason: 'disabled' }) });
    createMarkdownItPlugin(deps)(md);
    const html = md.render('```kuml\nclassDiagram { }\n```\n');
    assert.ok(!html.includes('kuml-embed'));
    assert.ok(html.includes('<pre>') || html.includes('<code'));
});

test('a kuml fence in an untrusted workspace shows the restricted card', () => {
    const md = new MarkdownIt();
    const deps = makeDeps({ evaluateGate: () => ({ allowed: false, reason: 'untrusted' }) });
    createMarkdownItPlugin(deps)(md);
    const html = md.render('```kuml\nclassDiagram { }\n```\n');
    assert.ok(html.includes('kuml-embed--restricted'));
});

test('a kuml fence with env.currentDocument undefined falls back to plain code (unknown-document)', () => {
    const md = new MarkdownIt();
    const deps = makeDeps({ evaluateGate: () => ({ allowed: false, reason: 'unknown-document' }) });
    createMarkdownItPlugin(deps)(md);
    const html = md.render('```kuml\nclassDiagram { }\n```\n', {});
    assert.ok(!html.includes('kuml-embed'));
});

test('a kuml fence with no cache entry renders a placeholder and kicks off a background render', async () => {
    const md = new MarkdownIt();
    let renderCalled = false;
    const deps = makeDeps({
        render: async () => {
            renderCalled = true;
            return { kind: 'svg', svg: '<svg><rect/></svg>' };
        },
    });
    createMarkdownItPlugin(deps)(md);
    const html = md.render('```kuml\nclassDiagram { }\n```\n');
    assert.ok(html.includes('kuml-embed--placeholder'));
    // Let the fire-and-forget cache.request() promise chain settle.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(renderCalled, true);
    assert.notEqual(deps.cache.peek(computeKey(fenceContent('classDiagram { }'), 'kuml', 'diagram')), undefined);
});

test('a warm cache entry renders the diagram directly (no placeholder)', async () => {
    const md = new MarkdownIt();
    const deps = makeDeps();
    const source = 'classDiagram { }';
    const outcome: RenderOutcome = { kind: 'svg', svg: '<svg><rect width="1"/></svg>' };
    await deps.cache.request(computeKey(fenceContent(source), 'kuml', 'diagram'), async () => outcome);
    createMarkdownItPlugin(deps)(md);
    const html = md.render('```kuml\n' + source + '\n```\n');
    assert.ok(html.includes('kuml-embed--diagram'));
    assert.ok(html.includes('<rect width="1"/>'));
});

test('a cached error outcome renders the error card', async () => {
    const md = new MarkdownIt();
    const deps = makeDeps();
    const source = 'broken';
    await deps.cache.request(computeKey(fenceContent(source), 'kuml', 'diagram'), async () => ({
        kind: 'error',
        summary: 'kUML render failed',
    }));
    createMarkdownItPlugin(deps)(md);
    const html = md.render('```kuml\n' + source + '\n```\n');
    assert.ok(html.includes('kuml-embed--error'));
});

test('more than BLOCK_BUDGET kuml fences in one document show a budget notice past the limit', () => {
    const md = new MarkdownIt();
    const deps = makeDeps();
    createMarkdownItPlugin(deps)(md);
    const fences = Array.from(
        { length: BLOCK_BUDGET + 3 },
        (_, i) => `\`\`\`kuml\nclassDiagram { name = "${i}" }\n\`\`\``,
    ).join('\n\n');
    const html = md.render(fences);
    const budgetNotices = (html.match(/kuml-embed--budget/g) ?? []).length;
    assert.equal(budgetNotices, 3, 'exactly the blocks past BLOCK_BUDGET must show the budget notice');
});

test('a warm cache past BLOCK_BUDGET is still shown (a cache hit must never be pre-empted by the render budget)', async () => {
    // Regression test: `env.__kumlRendered` previously counted every kuml
    // fence, including cache HITS, so a fully pre-warmed document with more
    // than BLOCK_BUDGET fences permanently replaced diagrams past the limit
    // with a budget notice, even though displaying an already-rendered
    // diagram costs nothing. The AsciiDoc registrar has always had the
    // opposite (correct) behavior for this exact scenario, with its own
    // regression test — this brings Markdown in line (2026-08 review
    // finding).
    const md = new MarkdownIt();
    const deps = makeDeps();
    const blockCount = BLOCK_BUDGET + 4;
    const parts: string[] = [];
    for (let i = 0; i < blockCount; i++) {
        const source = `classDiagram { block${i} }`;
        await deps.cache.request(computeKey(fenceContent(source), 'kuml', 'diagram'), async () => ({
            kind: 'svg',
            svg: `<svg><rect id="r${i}"/></svg>`,
        }));
        parts.push('```kuml\n' + source + '\n```');
    }
    createMarkdownItPlugin(deps)(md);
    const html = md.render(parts.join('\n\n'));

    const diagramCount = (html.match(/kuml-embed--diagram/g) ?? []).length;
    assert.equal(diagramCount, blockCount, 'every cached block must render as a diagram, none replaced by a budget notice');
    assert.ok(!html.includes('kuml-embed--budget'), 'no budget notice should appear when every block is a cache hit');
});

test('a cached "empty" outcome shows a static empty-state notice, not the forever-loading placeholder', async () => {
    // Regression test: `{ kind: 'empty' }` is a terminal, cached outcome (the
    // block will never produce a diagram) — it must not reuse the same
    // pulsing "rendering…" placeholder used for genuinely in-flight renders,
    // which would otherwise animate forever.
    const md = new MarkdownIt();
    const deps = makeDeps();
    // An empty fence's `token.content` is `''`, not `fenceContent('')` (`'\n'`) —
    // markdown-it only appends the trailing newline when there's at least one
    // content line between the fences.
    await deps.cache.request(computeKey('', 'kuml', 'diagram'), async () => ({ kind: 'empty' }));
    createMarkdownItPlugin(deps)(md);
    const html = md.render('```kuml\n```\n');
    assert.ok(html.includes('kuml-embed--empty'));
    assert.ok(!html.includes('kuml-embed--placeholder'));
});

test('width is honoured for rendering but excluded from the cache key (Stolperfalle F10)', async () => {
    const md = new MarkdownIt();
    const deps = makeDeps();
    const source = 'classDiagram { }';
    await deps.cache.request(computeKey(fenceContent(source), 'kuml', 'diagram'), async () => ({
        kind: 'svg',
        svg: '<svg/>',
    }));
    createMarkdownItPlugin(deps)(md);
    // Same source/theme/name, only width differs — must still be a cache hit.
    const html = md.render('```kuml {width=800}\n' + source + '\n```\n');
    assert.ok(html.includes('kuml-embed--diagram'), 'a width-only variation must still hit the cache');
    assert.ok(html.includes('--kuml-width: 800px'));
});
