/**
 * Tests `createAsciidoctorRegistrar` against a REAL `@asciidoctor/core`
 * registry (a devDependency, `import type`-only from `asciidoc.ts` itself so
 * it never ships in the VSIX — see Stolperfalle F7). This is the same
 * registry shape verified directly in this session's Gate 0 probe:
 * `registry.treeProcessor` / `registry.blockMacro` are real functions, their
 * `process()` callbacks must stay synchronous, and a `pass` block inlines
 * raw HTML unescaped.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Asciidoctor = require('@asciidoctor/core')();
import { BLOCK_BUDGET, createAsciidoctorRegistrar, type AsciidocDeps, type DocumentUriLike } from '../embed/asciidoc';
import { RenderCache, computeKey } from '../render/renderCache';
import type { GateResult } from '../embed/gate';
import type { RenderOutcome } from '../render/kumlRenderer';

const DOC_URI: DocumentUriLike = { fsPath: '/proj/doc.adoc', scheme: 'file' };

function allowedGate(documentDir: string): GateResult {
    return {
        allowed: true,
        config: { cliPath: 'kuml', serverUrl: '', defaultTheme: 'kuml', allowPathsOutsideWorkspace: false },
        documentDir,
        workspaceRoot: documentDir,
    };
}

function makeDeps(overrides: Partial<AsciidocDeps> = {}): AsciidocDeps & { cache: RenderCache } {
    return {
        evaluateGate: () => allowedGate('/proj'),
        scheduleRefresh: () => undefined,
        cache: new RenderCache(),
        render: async () => ({ kind: 'empty' }) as RenderOutcome,
        readDocumentText: async () => undefined,
        ...overrides,
    };
}

function convert(doc: string, registrar: ReturnType<typeof createAsciidoctorRegistrar>, mode: 'preview' | 'export' | 'load') {
    return (async () => {
        const registry = Asciidoctor.Extensions.create();
        await registrar(registry, { documentUri: DOC_URI, mode });
        return Asciidoctor.convert(doc, { extension_registry: registry, safe: 'safe' }) as string;
    })();
}

test('registers both a treeProcessor and a blockMacro without throwing', async () => {
    const registrar = createAsciidoctorRegistrar(makeDeps());
    const registry = Asciidoctor.Extensions.create();
    await assert.doesNotReject(registrar(registry, { documentUri: DOC_URI, mode: 'preview' }));
});

test("mode 'load' never renders, even for a matching [source,kuml] block — always a placeholder", async () => {
    let renderCalled = false;
    const deps = makeDeps({ render: async () => ((renderCalled = true), { kind: 'empty' }) as RenderOutcome });
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[source,kuml]', '----', 'classDiagram { }', '----'].join('\n');
    const html = await convert(doc, registrar, 'load');
    assert.ok(html.includes('kuml-embed--placeholder'));
    assert.equal(renderCalled, false, "mode:'load' must never call render() — it would spawn a JVM per keystroke");
});

test("mode 'preview' with a cache miss shows a placeholder and triggers a background render", async () => {
    let renderCalled = false;
    const deps = makeDeps({
        render: async () => {
            renderCalled = true;
            return { kind: 'svg', svg: '<svg><rect/></svg>' };
        },
    });
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[source,kuml]', '----', 'classDiagram { }', '----'].join('\n');
    const html = await convert(doc, registrar, 'preview');
    assert.ok(html.includes('kuml-embed--placeholder'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(renderCalled, true);
});

test("mode 'preview' with a warm cache renders the diagram inline, unescaped", async () => {
    const deps = makeDeps();
    const source = 'classDiagram { }';
    await deps.cache.request(computeKey(source, 'kuml', 'diagram'), async () => ({
        kind: 'svg',
        svg: '<svg><rect width="1"/></svg>',
    }));
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[source,kuml]', '----', source, '----'].join('\n');
    const html = await convert(doc, registrar, 'preview');
    assert.ok(html.includes('kuml-embed--diagram'));
    assert.ok(html.includes('<rect width="1"/>'));
});

test('a bare [kuml] style block (no [source,...]) is also recognized', async () => {
    const deps = makeDeps();
    const source = 'classDiagram { }';
    await deps.cache.request(computeKey(source, 'kuml', 'diagram'), async () => ({ kind: 'svg', svg: '<svg/>' }));
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[kuml]', '----', source, '----'].join('\n');
    const html = await convert(doc, registrar, 'preview');
    assert.ok(html.includes('kuml-embed--diagram'));
});

test('kuml::path[] macro renders once the target resolves and is cached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-adoc-macro-test-'));
    try {
        const target = path.join(dir, 'login.kuml.kts');
        fs.writeFileSync(target, 'classDiagram { }');
        const deps = makeDeps({
            evaluateGate: () => allowedGate(dir),
            render: async () => ({ kind: 'svg', svg: '<svg><circle/></svg>' }),
        });
        const registrar = createAsciidoctorRegistrar(deps);
        const html = await convert('kuml::login.kuml.kts[]', registrar, 'preview');
        assert.ok(html.includes('kuml-embed--placeholder'), 'first pass (cache miss) must show a placeholder');
        await new Promise((r) => setTimeout(r, 20));

        // Re-convert with a fresh registry (mirrors V3: a fresh registry per
        // render) — the cache should now be warm.
        const registrar2 = createAsciidoctorRegistrar(deps);
        const html2 = await convert('kuml::login.kuml.kts[]', registrar2, 'preview');
        assert.ok(html2.includes('kuml-embed--diagram'));
        assert.ok(html2.includes('<circle/>'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('kuml::path[] macro rejects a path escaping the workspace root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-adoc-macro-reject-'));
    try {
        const deps = makeDeps({ evaluateGate: () => allowedGate(dir) });
        const registrar = createAsciidoctorRegistrar(deps);
        const html = await convert('kuml::../../../etc/passwd.kuml.kts[]', registrar, 'preview');
        assert.ok(html.includes('kuml-embed--error'));
        assert.ok(html.includes('path rejected'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an untrusted workspace shows the restricted card for both listing blocks and macros', async () => {
    const deps = makeDeps({ evaluateGate: () => ({ allowed: false, reason: 'untrusted' }) });
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[source,kuml]', '----', 'classDiagram { }', '----', '', 'kuml::x.kuml.kts[]'].join('\n');
    const html = await convert(doc, registrar, 'preview');
    const restrictedCount = (html.match(/kuml-embed--restricted/g) ?? []).length;
    assert.equal(restrictedCount, 2);
});

test('a disabled setting leaves the original block untouched (passthrough)', async () => {
    const deps = makeDeps({ evaluateGate: () => ({ allowed: false, reason: 'disabled' }) });
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[source,kuml]', '----', 'classDiagram { }', '----'].join('\n');
    const html = await convert(doc, registrar, 'preview');
    assert.ok(!html.includes('kuml-embed'));
    assert.ok(html.includes('classDiagram'));
});

test('a disabled setting renders a kuml::[] macro as literal text rather than silently vanishing', async () => {
    // Regression test: a block macro is always intercepted once a handler is
    // registered for its name — unlike a listing block, there is no
    // "pretend this doesn't exist" fallback in asciidoctor.js. Verified
    // directly (this session) that returning `undefined` from process()
    // makes the macro disappear with no trace, which would silently discard
    // content from the reader's point of view.
    const deps = makeDeps({ evaluateGate: () => ({ allowed: false, reason: 'disabled' }) });
    const registrar = createAsciidoctorRegistrar(deps);
    const html = await convert('kuml::diagrams/x.kuml.kts[]', registrar, 'preview');
    assert.ok(!html.includes('kuml-embed'));
    assert.ok(html.includes('kuml::diagrams/x.kuml.kts[]'), 'the raw macro text must still be visible');
});

test("mode 'export' pre-renders before the synchronous pass runs, so the sync tree processor only ever sees a warm cache", async () => {
    const source = 'classDiagram { }';
    const doc = ['[source,kuml]', '----', source, '----'].join('\n');
    let renderCalled = false;
    const deps = makeDeps({
        readDocumentText: async () => doc,
        render: async () => {
            renderCalled = true;
            return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
        },
    });
    const registrar = createAsciidoctorRegistrar(deps);
    const html = await convert(doc, registrar, 'export');
    assert.equal(renderCalled, true, 'the export pre-render pass must have run before conversion');
    assert.ok(html.includes('kuml-embed--diagram'));
    assert.ok(html.includes('<rect width="9"/>'));
});

test("mode 'export' shows a budget-exceeded error for a block that never got pre-rendered", async () => {
    const source = 'classDiagram { }';
    const doc = ['[source,kuml]', '----', source, '----'].join('\n');
    // readDocumentText returns undefined (e.g. the document couldn't be read) —
    // the pre-render pass then does nothing, so the sync pass hits a cold cache.
    const deps = makeDeps({ readDocumentText: async () => undefined });
    const registrar = createAsciidoctorRegistrar(deps);
    const html = await convert(doc, registrar, 'export');
    assert.ok(html.includes('kuml-embed--error'));
    assert.ok(html.includes('export'));
});

test('process() callbacks never return a Promise (a Promise return would hard-throw)', async () => {
    // Regression guard for Gate 0 finding S3: verified separately in this
    // session that a Promise-returning process() callback throws
    // "lhs.$!= is not a function" instead of degrading silently. This test
    // simply proves our own registrar's callbacks survive a real conversion
    // even when render() itself is slow — i.e. we never await it inline.
    const deps = makeDeps({
        render: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return { kind: 'svg', svg: '<svg/>' };
        },
    });
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[source,kuml]', '----', 'classDiagram { }', '----'].join('\n');
    const html = await convert(doc, registrar, 'preview');
    assert.ok(html.includes('kuml-embed--placeholder'), 'conversion must complete synchronously with a placeholder');
});

test('a disabled setting escapes a malicious kuml::[] target instead of inlining it raw (HTML injection regression)', async () => {
    // Regression test for the passthrough branch: `subs: []` disables
    // Asciidoctor's own `specialcharacters` substitution, so an unescaped
    // `target` would land byte-for-byte in the converted HTML. Verified
    // directly against this real @asciidoctor/core conversion.
    const deps = makeDeps({ evaluateGate: () => ({ allowed: false, reason: 'disabled' }) });
    const registrar = createAsciidoctorRegistrar(deps);
    const maliciousTarget = '<img/src=x/onerror=alert(document.domain)>.kuml.kts';
    const html = await convert(`kuml::${maliciousTarget}[]`, registrar, 'preview');
    assert.ok(!html.includes('<img'), 'the raw <img> tag must never appear unescaped in the output');
    assert.ok(html.includes('&lt;img'), 'the target must be HTML-escaped instead');
});

test('a cached diagram past BLOCK_BUDGET is still shown (a cache hit must never be pre-empted by the render budget)', async () => {
    // Regression test: the budget counter must only throttle NEW render
    // attempts (cache misses), not blocks that are already fully cached —
    // otherwise a warm cache combined with enough blocks in one document
    // could wrongly replace an already-rendered diagram with the budget
    // notice. Build BLOCK_BUDGET + 1 listing blocks, all pre-warmed in the
    // cache, and confirm every single one renders as a diagram.
    const deps = makeDeps();
    const blockCount = BLOCK_BUDGET + 1;
    const parts: string[] = [];
    for (let i = 0; i < blockCount; i++) {
        const source = `classDiagram { block${i} }`;
        const name = `d${i}`;
        await deps.cache.request(computeKey(source, 'kuml', name), async () => ({
            kind: 'svg',
            svg: `<svg><rect id="r${i}"/></svg>`,
        }));
        parts.push(`[source,kuml,${name}]`, '----', source, '----', '');
    }
    const registrar = createAsciidoctorRegistrar(deps);
    const html = await convert(parts.join('\n'), registrar, 'preview');

    const diagramCount = (html.match(/kuml-embed--diagram/g) ?? []).length;
    assert.equal(diagramCount, blockCount, 'every cached block must render as a diagram, none replaced by a budget notice');
    assert.ok(!html.includes('kuml-embed--budget'), 'no budget notice should appear when every block is a cache hit');
});

test("mode 'export' pre-renders a positional-named listing block ([source,kuml,login,svg]) — regression for scanner/attrs cache-key drift", async () => {
    // Regression test: `scanAsciidocBlocks` (used by the export pre-render
    // pass) and `parseAsciidocAttributes` (used by the synchronous
    // treeProcessor pass against the real parsed document) must compute the
    // SAME cache key for a positional-named block, or the pre-render warms
    // the wrong key and the synchronous pass hits a guaranteed cache miss —
    // which, in 'export' mode, renders as a budget-exceeded error even
    // though exactly one render actually happened.
    const source = 'classDiagram { }';
    const doc = ['[source,kuml,login,svg]', '----', source, '----'].join('\n');
    let renderCount = 0;
    const deps = makeDeps({
        readDocumentText: async () => doc,
        render: async () => {
            renderCount++;
            return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
        },
    });
    const registrar = createAsciidoctorRegistrar(deps);
    const html = await convert(doc, registrar, 'export');
    assert.equal(renderCount, 1, 'the block must actually be rendered exactly once');
    assert.ok(html.includes('kuml-embed--diagram'), `expected a rendered diagram, got: ${html}`);
    assert.ok(!html.includes('kuml-embed--error'), 'must not fall back to the budget-exceeded error card');
});

test("mode 'export' pre-renders a positional-named kuml::path[] macro (kuml::x.kuml.kts[login,svg]) — regression for scanner/attrs cache-key drift", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-adoc-export-macro-test-'));
    try {
        const target = path.join(dir, 'a.kuml.kts');
        fs.writeFileSync(target, 'classDiagram { }');
        const doc = 'kuml::a.kuml.kts[login,svg]';
        let renderCount = 0;
        const deps = makeDeps({
            evaluateGate: () => allowedGate(dir),
            readDocumentText: async () => doc,
            render: async () => {
                renderCount++;
                return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
            },
        });
        const registrar = createAsciidoctorRegistrar(deps);
        const html = await convert(doc, registrar, 'export');
        assert.equal(renderCount, 1, 'the macro must actually be rendered exactly once');
        assert.ok(html.includes('kuml-embed--diagram'), `expected a rendered diagram, got: ${html}`);
        assert.ok(!html.includes('kuml-embed--error'), 'must not fall back to the budget-exceeded error card');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("mode 'export' pre-renders a bare-style [kuml] listing block — regression for LISTING_HEADER not matching the bare style", async () => {
    // Regression test: `isKumlListingBlock` (asciidoc.ts) recognizes a
    // listing block via EITHER `language === 'kuml'` (the `[source,kuml]`
    // form) OR `getStyle() === 'kuml'` (the bare `[kuml]` form) — confirmed
    // by the existing 'preview'-mode test above. The export-time scanner's
    // `LISTING_HEADER` must recognize both forms too, or a document made
    // entirely of bare `[kuml]` blocks pre-renders NOTHING and every block
    // falls back to the budget-exceeded error in export mode.
    const source = 'classDiagram { }';
    const doc = ['[kuml]', '----', source, '----'].join('\n');
    let renderCount = 0;
    const deps = makeDeps({
        readDocumentText: async () => doc,
        render: async () => {
            renderCount++;
            return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
        },
    });
    const registrar = createAsciidoctorRegistrar(deps);
    const html = await convert(doc, registrar, 'export');
    assert.equal(renderCount, 1, 'the bare-style block must actually be rendered exactly once');
    assert.ok(html.includes('kuml-embed--diagram'), `expected a rendered diagram, got: ${html}`);
    assert.ok(!html.includes('kuml-embed--error'), 'must not fall back to the budget-exceeded error card');
});

test("mode 'export' pre-renders a kUML block reached only via include:: (regression: pre-render pass must follow includes)", async () => {
    // Regression test: `preRenderForExport` used to read and scan only the
    // master document's own text — Asciidoctor's real converter resolves
    // `include::` directives before its tree processor runs, so a kUML block
    // living in an included file was invisible to the pre-render pass and
    // hit a guaranteed cache miss during export (2026-08 review finding).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-adoc-export-include-test-'));
    try {
        const incSource = 'classDiagram { included }';
        fs.writeFileSync(path.join(dir, 'inc.adoc'), ['[source,kuml]', '----', incSource, '----', ''].join('\n'));
        const masterPath = path.join(dir, 'master.adoc');
        const doc = ['= T', '', 'include::inc.adoc[]', ''].join('\n');
        fs.writeFileSync(masterPath, doc);

        let renderCount = 0;
        const deps = makeDeps({
            evaluateGate: () => allowedGate(dir),
            readDocumentText: async () => doc,
            render: async () => {
                renderCount++;
                return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
            },
        });
        const registrar = createAsciidoctorRegistrar(deps);
        const registry = Asciidoctor.Extensions.create();
        await registrar(registry, { documentUri: { fsPath: masterPath, scheme: 'file' }, mode: 'export' });
        const html = Asciidoctor.convert(doc, { extension_registry: registry, safe: 'safe', base_dir: dir }) as string;

        assert.equal(renderCount, 1, 'the included block must be pre-rendered exactly once');
        assert.ok(html.includes('kuml-embed--diagram'), `expected a rendered diagram, got: ${html}`);
        assert.ok(!html.includes('kuml-embed--error'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("mode 'export' pre-renders a kuml::[] macro reached only via include::", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-adoc-export-include-macro-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'b.kuml.kts'), 'classDiagram { }');
        fs.writeFileSync(path.join(dir, 'inc.adoc'), 'kuml::b.kuml.kts[]\n');
        const masterPath = path.join(dir, 'master.adoc');
        const doc = ['= T', '', 'include::inc.adoc[]', ''].join('\n');
        fs.writeFileSync(masterPath, doc);

        let renderCount = 0;
        const deps = makeDeps({
            evaluateGate: () => allowedGate(dir),
            readDocumentText: async () => doc,
            render: async () => {
                renderCount++;
                return { kind: 'svg', svg: '<svg><circle/></svg>' };
            },
        });
        const registrar = createAsciidoctorRegistrar(deps);
        const registry = Asciidoctor.Extensions.create();
        await registrar(registry, { documentUri: { fsPath: masterPath, scheme: 'file' }, mode: 'export' });
        const html = Asciidoctor.convert(doc, { extension_registry: registry, safe: 'safe', base_dir: dir }) as string;

        assert.equal(renderCount, 1, 'the included macro target must be pre-rendered exactly once');
        assert.ok(html.includes('kuml-embed--diagram'), `expected a rendered diagram, got: ${html}`);
        assert.ok(!html.includes('kuml-embed--error'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("mode 'export' with a mix of an included block and a local block renders both", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-adoc-export-include-mixed-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'inc.adoc'), ['[source,kuml,inc]', '----', 'classDiagram { a }', '----', ''].join('\n'));
        const masterPath = path.join(dir, 'master.adoc');
        const doc = ['= T', '', 'include::inc.adoc[]', '', '[source,kuml,local]', '----', 'classDiagram { b }', '----', ''].join(
            '\n',
        );
        fs.writeFileSync(masterPath, doc);

        let renderCount = 0;
        const deps = makeDeps({
            evaluateGate: () => allowedGate(dir),
            readDocumentText: async () => doc,
            render: async () => {
                renderCount++;
                return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
            },
        });
        const registrar = createAsciidoctorRegistrar(deps);
        const registry = Asciidoctor.Extensions.create();
        await registrar(registry, { documentUri: { fsPath: masterPath, scheme: 'file' }, mode: 'export' });
        const html = Asciidoctor.convert(doc, { extension_registry: registry, safe: 'safe', base_dir: dir }) as string;

        assert.equal(renderCount, 2, 'both the included and the local block must be pre-rendered');
        const diagramCount = (html.match(/kuml-embed--diagram/g) ?? []).length;
        assert.equal(diagramCount, 2, `expected 2 rendered diagrams, got: ${html}`);
        assert.ok(!html.includes('kuml-embed--error'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("mode 'export' does NOT inline a whole file for include::target[tag=...] (partial-include over-render regression)", async () => {
    // Regression test: the pre-render pass previously followed EVERY
    // `include::` directive as if it were a whole-file include, even one
    // restricted to a `tag=`/`tags=`/`lines=` subset — that inlined content
    // Asciidoctor's real conversion would never emit, wasting a render call
    // and a BLOCK_BUDGET slot on a block that should stay invisible (2026-08
    // review finding).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-adoc-export-include-tag-test-'));
    try {
        fs.writeFileSync(
            path.join(dir, 'inc.adoc'),
            [
                '[source,kuml,dropped]',
                '----',
                'classDiagram { dropped }',
                '----',
                '',
                '// tag::keep[]',
                '[source,kuml,kept]',
                '----',
                'classDiagram { kept }',
                '----',
                '// end::keep[]',
                '',
            ].join('\n'),
        );
        const masterPath = path.join(dir, 'master.adoc');
        const doc = ['= T', '', 'include::inc.adoc[tag=keep]', ''].join('\n');
        fs.writeFileSync(masterPath, doc);

        let renderCount = 0;
        const deps = makeDeps({
            evaluateGate: () => allowedGate(dir),
            readDocumentText: async (uri) => (uri.fsPath === masterPath ? doc : undefined),
            render: async () => {
                renderCount++;
                return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
            },
        });
        const registrar = createAsciidoctorRegistrar(deps);
        const registry = Asciidoctor.Extensions.create();
        await registrar(registry, { documentUri: { fsPath: masterPath, scheme: 'file' }, mode: 'export' });
        const html = Asciidoctor.convert(doc, { extension_registry: registry, safe: 'safe', base_dir: dir });

        assert.equal(renderCount, 0, 'a partial (tag=) include must not be inlined and pre-rendered as a whole file');
        // Regression: classifyExportMiss previously trusted `attemptedKeys`
        // even when expandIncludesForExport had to leave this very include
        // unresolved, so the "kept" block it never saw was misclassified as
        // a BLOCK_BUDGET overflow ("more than 20 diagrams (1 found so far)")
        // instead of the honest "not pre-rendered before export" deadline
        // error every other unresolvable-scan case already produced.
        assert.ok(html.includes('kuml-embed--error'), 'the unresolved-include block must fall back to the deadline error state');
        assert.ok(!html.includes('kuml-embed--budget'), 'a single tag-restricted include must never look like a BLOCK_BUDGET overflow');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("mode 'export' distinguishes a real budget overflow from a false deadline error", async () => {
    // Regression test: previously `renderedCount` in the synchronous pass
    // only counted cache MISSES. With BLOCK_BUDGET (20) blocks pre-rendered
    // and 4 more genuinely beyond the budget, those 4 overflow blocks each
    // reached a `renderedCount` of only 1..4 and never crossed BLOCK_BUDGET —
    // landing them in the export-deadline-error branch instead of the
    // budget-notice branch, even though nothing was actually overdue
    // (2026-08 review finding).
    const overflow = 4;
    const blockCount = BLOCK_BUDGET + overflow;
    const parts: string[] = [];
    for (let i = 0; i < blockCount; i++) {
        parts.push(`[source,kuml,d${i}]`, '----', `classDiagram { block${i} }`, '----', '');
    }
    const doc = parts.join('\n');

    let renderCount = 0;
    const deps = makeDeps({
        readDocumentText: async () => doc,
        render: async () => {
            renderCount++;
            return { kind: 'svg', svg: '<svg><rect width="9"/></svg>' };
        },
    });
    const registrar = createAsciidoctorRegistrar(deps);
    const html = await convert(doc, registrar, 'export');

    assert.equal(renderCount, BLOCK_BUDGET, 'only the first BLOCK_BUDGET blocks are pre-rendered');
    const diagramCount = (html.match(/kuml-embed--diagram/g) ?? []).length;
    const budgetCount = (html.match(/kuml-embed--budget/g) ?? []).length;
    assert.equal(diagramCount, BLOCK_BUDGET, `expected ${BLOCK_BUDGET} rendered diagrams, got: ${html}`);
    assert.equal(budgetCount, overflow, `expected ${overflow} budget notices for the genuinely over-budget blocks, got: ${html}`);
    assert.ok(
        !html.includes('kuml-embed--error'),
        'no block should show the misleading "not pre-rendered before export deadline" error when the doc simply exceeds BLOCK_BUDGET',
    );
});

test('an empty [source,kuml] block shows a static "empty" notice, not the forever-loading placeholder', async () => {
    const deps = makeDeps({ render: async () => ({ kind: 'empty' }) });
    // Pre-warm the cache directly with the 'empty' outcome, mirroring what
    // renderKuml({source: ''}) actually returns and what ends up cached.
    await deps.cache.request(computeKey('', 'kuml', 'diagram'), async () => ({ kind: 'empty' }));
    const registrar = createAsciidoctorRegistrar(deps);
    const doc = ['[source,kuml]', '----', '----'].join('\n');
    const html = await convert(doc, registrar, 'preview');
    assert.ok(html.includes('kuml-embed--empty'), 'an empty block must show the dedicated empty-state notice');
    assert.ok(!html.includes('kuml-embed--placeholder'), 'an empty block must NOT show the pulsing loading placeholder');
});
