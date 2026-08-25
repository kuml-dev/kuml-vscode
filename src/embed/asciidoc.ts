import * as fs from 'fs';
import * as path from 'path';
import type { Extensions } from '@asciidoctor/core';
import { sanitizeSvg } from '../svgSanitize';
import { computeKey, type RenderCache } from '../render/renderCache';
import type { RenderOutcome, RenderRequest } from '../render/kumlRenderer';
import { parseAsciidocAttributes, normalizeWidth } from './attributes';
import { scanAsciidocBlocks } from './asciidocScan';
import { resolveEmbeddedPath, resolveIncludeTarget } from './pathGuard';
import {
    buildBudgetNotice,
    buildCliMissing,
    buildDiagram,
    buildEmpty,
    buildError,
    buildPlaceholder,
    buildRestricted,
    escapeHtml,
} from './embedHtml';
import type { GateResult } from './gate';

/**
 * Registers kUML rendering into an AsciiDoc preview/export via the
 * `asciidoc.asciidoctorExtensions` contribution point exposed by
 * `asciidoctor.asciidoctor-vscode` >= 4.0.0.
 *
 * Verified against `@asciidoctor/core` directly (Gate 0, this session):
 *  - `registry.treeProcessor` / `registry.blockMacro` are real functions,
 *    and their `process()` callbacks MUST be synchronous — a callback that
 *    returns a Promise breaks conversion outright (`lhs.$!= is not a
 *    function`), it does not silently degrade. Never make these async.
 *  - `self.createBlock(parent, 'pass', html, {}, { subs: [] })` inlines
 *    `html` completely unescaped into the converted output.
 *
 * `context.mode` distinguishes three call sites in asciidoctor-vscode's
 * `AsciidocEngine` (`export` / `preview` / `load`) with a fresh `Extensions`
 * registry created per conversion. `'load'` fires on every diagnostics pass
 * (i.e. potentially every keystroke) even with no preview open — rendering
 * there would mean spawning a JVM per keystroke, so `'load'` NEVER renders,
 * only ever shows a placeholder.
 *
 * No `vscode` import here — kept pure so it's testable against a real
 * `@asciidoctor/core` registry in plain Node. The `vscode`-aware wiring is
 * assembled once, in `extension.ts`.
 */

/** A structural subset of `vscode.Uri` — avoids importing `vscode` in this module. */
export interface DocumentUriLike {
    fsPath: string;
    scheme: string;
}

export type AsciidoctorMode = 'preview' | 'export' | 'load';

export interface AsciidoctorExtensionContext {
    documentUri?: DocumentUriLike;
    mode: AsciidoctorMode;
}

export interface AsciidocDeps {
    evaluateGate: (documentUri: DocumentUriLike | undefined) => GateResult;
    scheduleRefresh: () => void;
    cache: RenderCache;
    render: (req: RenderRequest) => Promise<RenderOutcome>;
    /**
     * Reads the live document text for the `'export'` pre-render pass.
     * Real implementation checks `vscode.workspace.textDocuments` first
     * (Stolperfalle F11 — an unsaved buffer must win over the on-disk copy),
     * falling back to `vscode.workspace.fs.readFile`.
     */
    readDocumentText: (documentUri: DocumentUriLike) => Promise<string | undefined>;
}

export const BLOCK_BUDGET = 20;
export const EXPORT_DEADLINE_MS = 120_000;
const MAX_MACRO_SOURCE_BYTES = 1024 * 1024;
const MAX_INCLUDE_DEPTH = 8;
// Deliberately approximate: matches a bare `include::target[...]` directive
// line. Group 2 captures the raw attribute list so `expandIncludesForExport`
// can detect (and refuse to approximate) a partial-selection include —
// `leveloffset=` alone is harmless to ignore (it only affects heading
// levels, never content presence), but is not specially handled either.
const INCLUDE_DIRECTIVE = /^\s*include::([^\s[\]]+)\[([^\]]*)\]\s*$/;
// `tag=`/`tags=`/`lines=` select a SUBSET of the included file's content —
// reproducing that selection correctly requires actually parsing the
// included file (tag regions via `tag::name[]`/`end::name[]` markers, line
// ranges like `1..10,15`), which this line-based scanner cannot safely do.
// Inlining the WHOLE included file for one of these directives would let a
// kUML block OUTSIDE the requested subset get pre-rendered and occupy a
// budget slot even though Asciidoctor's real conversion never emits it
// (2026-08 review finding — an over-render, not a false error, but still
// wasted CLI/JVM work and a burned `BLOCK_BUDGET` slot).
const PARTIAL_INCLUDE_SELECTOR = /(^|,)\s*(tag|tags|lines)\s*=/;

function outcomeToHtml(outcome: RenderOutcome, name: string, theme: string, width: string | undefined): string {
    switch (outcome.kind) {
        case 'svg':
            return buildDiagram({ svg: sanitizeSvg(outcome.svg), name, theme, width });
        case 'empty':
            return buildEmpty({ name });
        case 'cli-missing':
            return buildCliMissing({ name });
        case 'error':
            return buildError({ name, summary: outcome.summary, detail: outcome.detail });
    }
}

/**
 * Resolves after `ms`, or immediately once `cancel()` is called — either way
 * the underlying timer is cleared, so a `Promise.race` loser never leaves a
 * live `Timeout` handle behind (verified with `process.getActiveResourcesInfo()`:
 * without the `clearTimeout`, a `registrar()` call that resolves in 2ms from
 * an all-cache-hit `pending` array still left the 120s timer running and
 * holding the event loop open).
 */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
    let handle: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve) => {
        handle = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(handle) };
}

/** Synchronous, size-capped read — never loads more than MAX_MACRO_SOURCE_BYTES into memory. */
function readCappedSync(resolvedPath: string): string | undefined {
    try {
        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile() || stat.size > MAX_MACRO_SOURCE_BYTES) {
            return undefined;
        }
        return fs.readFileSync(resolvedPath, { encoding: 'utf8' });
    } catch {
        return undefined;
    }
}

async function readCappedAsync(resolvedPath: string): Promise<string | undefined> {
    try {
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile() || stat.size > MAX_MACRO_SOURCE_BYTES) {
            return undefined;
        }
        return await fs.promises.readFile(resolvedPath, { encoding: 'utf8' });
    } catch {
        return undefined;
    }
}

type Action = 'passthrough' | 'restricted' | 'placeholder-only' | 'render';

function decideAction(mode: AsciidoctorMode, gate: GateResult): Action {
    if (!gate.allowed) {
        return gate.reason === 'untrusted' ? 'restricted' : 'passthrough';
    }
    return mode === 'load' ? 'placeholder-only' : 'render';
}

/**
 * Recursively inlines `include::target[]` directives in `text` so the
 * line-based `scanAsciidocBlocks` sees kUML blocks that live in an included
 * file, not just the master document (2026-08 review finding — Asciidoctor's
 * real converter resolves includes before its tree processor runs, but this
 * scanner previously only ever read the master document's own text via
 * `deps.readDocumentText`, so an included block was invisible to the
 * pre-render pass and hit a guaranteed cache miss — surfacing as a
 * budget-exceeded error card during export even though nothing was actually
 * over budget).
 *
 * Approximate on purpose, matching the rest of this file's line-scanner
 * approach: only a bare `include::target[]` (no `leveloffset=`, `tag=`,
 * `lines=`, or attribute-reference targets) is followed, and unresolved
 * attribute conditions inside the included text are handled the same way
 * `scanAsciidocBlocks` handles them for the master document. `seen` guards
 * against include cycles and `MAX_INCLUDE_DEPTH` bounds runaway nesting;
 * either limit is hit, the directive line is left as plain text (same as an
 * include the path guard rejects) rather than throwing.
 */
interface ExpandIncludesResult {
    text: string;
    /**
     * True when any `include::` directive in this text (or a nested include
     * it pulled in) could NOT be inlined — a partial-include selector, a
     * path the guard rejected, a self-include cycle, or an unreadable file —
     * and was left as a literal directive line instead. When this is true,
     * `scanAsciidocBlocks` on the returned `text` is known-INCOMPLETE: real
     * Asciidoctor may still resolve and render kUML blocks this scan never
     * saw (2026-08 review finding — see `classifyExportMiss`, whose 'budget'
     * classification is only trustworthy when every block in the document
     * was actually visible to the scan).
     */
    hadUnresolvedIncludes: boolean;
}

async function expandIncludesForExport(
    text: string,
    documentDir: string,
    gate: Extract<GateResult, { allowed: true }>,
    depth: number,
    seen: Set<string>,
): Promise<ExpandIncludesResult> {
    if (depth >= MAX_INCLUDE_DEPTH) {
        return { text, hadUnresolvedIncludes: true };
    }

    const lines = text.split('\n');
    const out: string[] = [];
    let hadUnresolvedIncludes = false;
    for (const line of lines) {
        const match = INCLUDE_DIRECTIVE.exec(line);
        if (!match) {
            out.push(line);
            continue;
        }

        if (PARTIAL_INCLUDE_SELECTOR.test(match[2])) {
            // Leave the directive line as plain text — same degraded-but-safe
            // fallback as an include the path guard rejects below. A kUML
            // block inside such a partial include stays invisible to export
            // pre-rendering (falling back to the existing export-deadline
            // error/placeholder path for it — see hadUnresolvedIncludes),
            // which is preferable to over-rendering content Asciidoctor's
            // real conversion would never include.
            out.push(line);
            hadUnresolvedIncludes = true;
            continue;
        }

        const resolved = resolveIncludeTarget({
            target: match[1],
            documentDir,
            workspaceRoot: gate.workspaceRoot,
            allowOutsideWorkspace: gate.config.allowPathsOutsideWorkspace,
        });
        if (!resolved.ok || seen.has(resolved.resolved)) {
            out.push(line);
            hadUnresolvedIncludes = true;
            continue;
        }

        const included = await readCappedAsync(resolved.resolved);
        if (included === undefined) {
            out.push(line);
            hadUnresolvedIncludes = true;
            continue;
        }

        const nextSeen = new Set(seen);
        nextSeen.add(resolved.resolved);
        const nested = await expandIncludesForExport(included, path.dirname(resolved.resolved), gate, depth + 1, nextSeen);
        out.push(nested.text);
        hadUnresolvedIncludes = hadUnresolvedIncludes || nested.hadUnresolvedIncludes;
    }
    return { text: out.join('\n'), hadUnresolvedIncludes };
}

/**
 * Pre-renders every kUML block/macro in the document (bounded by
 * BLOCK_BUDGET and EXPORT_DEADLINE_MS) BEFORE the synchronous
 * treeProcessor/blockMacro run during an `'export'` conversion, so those
 * synchronous callbacks only ever hit a warm cache. `RenderCache` already
 * caps real concurrency at MAX_CONCURRENT_RENDERS — the requests below are
 * fired without awaiting each individually so that cap is actually used.
 *
 * Stolperfalle (budget-vs-scan-order mismatch): this function slices
 * `scanAsciidocBlocks(text)` — true document order, mixing listings and
 * macros — to the first BLOCK_BUDGET blocks. The synchronous conversion pass
 * does NOT see the same order: asciidoctor.js substitutes block macros
 * during parsing (before any treeProcessor runs), so ALL macros in the
 * document are encountered before ANY listing, regardless of where each sits
 * in the source text. Because of that, the synchronous pass must NEVER count
 * a cache HIT against `BLOCK_BUDGET` — a cached block costs nothing to
 * display and must display regardless of counting order. The budget below
 * only throttles genuinely NEW render attempts (cache misses), which keeps
 * behavior consistent no matter which of the two orders is in play.
 *
 * Returns which cache keys were actually considered within the pre-render
 * window (`attemptedKeys`, populated for both cache hits and misses) plus
 * whether the document could be scanned at all (`scanned` — false only when
 * `readDocumentText` itself returned `undefined`). The synchronous pass uses
 * both to tell apart two very different situations for a block it finds
 * still cold (2026-08 review finding — previously conflated into a single,
 * frequently-wrong message): a block that WAS in the pre-render window but
 * didn't finish rendering before `EXPORT_DEADLINE_MS` (a genuine deadline
 * problem — `buildError`), versus a block that fell beyond `BLOCK_BUDGET`
 * entirely and was never even attempted (a genuine budget overflow —
 * `buildBudgetNotice`). Counting cache MISSES in encounter order (as the
 * synchronous pass's own `renderedCount` does) cannot make this distinction:
 * with e.g. 24 total blocks and 20 pre-rendered, blocks 21-24 each reach a
 * `renderedCount` of only 1-4 and never cross `BLOCK_BUDGET`, so they always
 * looked like deadline failures even though nothing was actually overdue.
 */
async function preRenderForExport(
    deps: AsciidocDeps,
    gate: Extract<GateResult, { allowed: true }>,
    documentUri: DocumentUriLike,
): Promise<{ scanned: boolean; attemptedKeys: Set<string>; fullyResolved: boolean }> {
    const attemptedKeys = new Set<string>();
    const text = await deps.readDocumentText(documentUri);
    if (text === undefined) {
        return { scanned: false, attemptedKeys, fullyResolved: false };
    }

    const documentDir = gate.documentDir ?? path.dirname(documentUri.fsPath);
    const { text: expanded, hadUnresolvedIncludes } = await expandIncludesForExport(text, documentDir, gate, 0, new Set());
    const blocks = scanAsciidocBlocks(expanded).slice(0, BLOCK_BUDGET);
    const pending: Array<Promise<unknown>> = [];

    for (const block of blocks) {
        if (block.kind === 'listing') {
            const theme = block.attributes.theme ?? gate.config.defaultTheme;
            const name = block.attributes.name ?? 'diagram';
            const key = computeKey(block.source, theme, name);
            attemptedKeys.add(key);
            if (deps.cache.peek(key)) {
                continue;
            }
            pending.push(
                deps.cache.request(key, () =>
                    deps.render({ source: block.source, theme, name, cliPath: gate.config.cliPath, serverUrl: gate.config.serverUrl }),
                ),
            );
        } else {
            const resolved = resolveEmbeddedPath({
                target: block.target,
                documentDir: gate.documentDir!,
                workspaceRoot: gate.workspaceRoot,
                allowOutsideWorkspace: gate.config.allowPathsOutsideWorkspace,
            });
            if (!resolved.ok) {
                continue;
            }
            const source = await readCappedAsync(resolved.resolved);
            if (source === undefined) {
                continue;
            }
            const theme = block.attributes.theme ?? gate.config.defaultTheme;
            const name = block.attributes.name ?? path.basename(resolved.resolved, '.kuml.kts');
            const key = computeKey(source, theme, name);
            attemptedKeys.add(key);
            if (deps.cache.peek(key)) {
                continue;
            }
            pending.push(
                deps.cache.request(key, () =>
                    deps.render({ source, theme, name, cliPath: gate.config.cliPath, serverUrl: gate.config.serverUrl }),
                ),
            );
        }
    }

    const deadline = delay(EXPORT_DEADLINE_MS);
    try {
        await Promise.race([Promise.all(pending), deadline.promise]);
    } finally {
        deadline.cancel();
    }
    return { scanned: true, attemptedKeys, fullyResolved: !hadUnresolvedIncludes };
}

/**
 * Classifies a still-cold cache key encountered by the synchronous `'export'`
 * pass: `'deadline'` when the block genuinely was inside the pre-render
 * window (or the pre-render pass couldn't run/scan at all, or an include it
 * couldn't safely expand means the scan is known-incomplete — in all three
 * cases we conservatively assume every block was "supposed to" be in-window
 * rather than blaming the budget), `'budget'` only when we positively know —
 * from a successful, FULLY resolved scan — that the block fell beyond
 * `BLOCK_BUDGET` and was never attempted. Without the `fullyResolved` check
 * (2026-08 review finding), a document containing only a tag-/lines-
 * restricted `include::` — whose target block is therefore invisible to
 * `attemptedKeys` for reasons entirely unrelated to `BLOCK_BUDGET` — wrongly
 * showed a "more than 20 diagrams" notice for as few as a single diagram.
 */
function classifyExportMiss(
    key: string,
    preRender: { scanned: boolean; attemptedKeys: Set<string>; fullyResolved: boolean } | undefined,
): 'deadline' | 'budget' {
    if (!preRender || !preRender.scanned || !preRender.fullyResolved) {
        return 'deadline';
    }
    return preRender.attemptedKeys.has(key) ? 'deadline' : 'budget';
}

function isKumlListingBlock(block: { getStyle(): string | undefined; getAttribute(name: string): unknown }): boolean {
    return block.getAttribute('language') === 'kuml' || block.getStyle() === 'kuml';
}

/**
 * Builds the `(registry, context) => Promise<void>` function the
 * `asciidoc.asciidoctorExtensions` contribution point expects, closing over
 * the supplied dependencies.
 */
export function createAsciidoctorRegistrar(
    deps: AsciidocDeps,
): (registry: Extensions.Registry, context: AsciidoctorExtensionContext) => Promise<void> {
    return async function registerAsciidoctorExtensions(
        registry: Extensions.Registry,
        context: AsciidoctorExtensionContext,
    ): Promise<void> {
        const gate = deps.evaluateGate(context.documentUri);
        const action = decideAction(context.mode, gate);
        // `action === 'render'` (per decideAction) implies `gate.allowed === true`;
        // this narrowed alias exists purely so TypeScript can see that too.
        const allowedGate: Extract<GateResult, { allowed: true }> | undefined = gate.allowed ? gate : undefined;

        let exportPreRender: { scanned: boolean; attemptedKeys: Set<string>; fullyResolved: boolean } | undefined;
        if (action === 'render' && context.mode === 'export' && context.documentUri) {
            exportPreRender = await preRenderForExport(deps, allowedGate!, context.documentUri);
        }

        let renderedCount = 0;

        registry.treeProcessor(function (this: unknown) {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const self = this as {
                process: (fn: (doc: unknown) => unknown) => void;
                createBlock: (parent: unknown, ctx: string, html: string, attrs: unknown, opts: unknown) => unknown;
            };
            self.process((doc: unknown) => {
                const document = doc as {
                    findBy: (selector: Record<string, string>) => Array<{
                        getParent: () => { getBlocks: () => unknown[] };
                        getStyle: () => string | undefined;
                        getAttribute: (name: string) => unknown;
                        getAttributes: () => Record<string, unknown>;
                        getSource: () => string;
                    }>;
                };
                const blocks = document.findBy({ context: 'listing' });
                for (const block of blocks) {
                    if (!isKumlListingBlock(block)) {
                        continue;
                    }
                    if (action === 'passthrough') {
                        continue;
                    }

                    let html: string;
                    if (action === 'restricted') {
                        html = buildRestricted({ name: 'diagram' });
                    } else if (action === 'placeholder-only') {
                        html = buildPlaceholder({ name: 'diagram' });
                    } else {
                        const attrs = parseAsciidocAttributes(block.getAttributes());
                        const source = block.getSource();
                        const theme = attrs.theme ?? allowedGate!.config.defaultTheme;
                        const name = attrs.name ?? 'diagram';
                        const width = normalizeWidth(attrs.width);
                        const key = computeKey(source, theme, name);
                        const cached = deps.cache.peek(key);
                        if (cached) {
                            // A cache hit costs nothing to display, so it must
                            // never be pre-empted by the render budget below —
                            // the budget throttles NEW render work, not
                            // already-rendered diagrams (see Stolperfalle:
                            // budget-vs-scan-order mismatch in the class doc
                            // comment of `preRenderForExport`).
                            html = outcomeToHtml(cached, name, theme, width);
                        } else {
                            renderedCount++;
                            if (context.mode === 'export') {
                                html =
                                    classifyExportMiss(key, exportPreRender) === 'budget'
                                        ? buildBudgetNotice({ rendered: renderedCount, limit: BLOCK_BUDGET })
                                        : buildError({
                                              name,
                                              summary: 'kUML diagram not pre-rendered before export',
                                              detail: 'This block was not rendered before the export deadline.',
                                          });
                            } else if (renderedCount > BLOCK_BUDGET) {
                                html = buildBudgetNotice({ rendered: renderedCount, limit: BLOCK_BUDGET });
                            } else {
                                void deps.cache.request(
                                    key,
                                    () =>
                                        deps.render({
                                            source,
                                            theme,
                                            name,
                                            cliPath: allowedGate!.config.cliPath,
                                            serverUrl: allowedGate!.config.serverUrl,
                                        }),
                                    () => deps.scheduleRefresh(),
                                );
                                html = buildPlaceholder({ name, reservedHeight: deps.cache.sizeOf(key)?.height });
                            }
                        }
                    }

                    const parent = block.getParent();
                    const passBlock = self.createBlock(parent, 'pass', html, {}, { subs: [] });
                    const siblings = parent.getBlocks();
                    const idx = siblings.indexOf(block);
                    if (idx >= 0) {
                        siblings[idx] = passBlock;
                    }
                }
                return doc;
            });
        });

        registry.blockMacro('kuml', function (this: unknown) {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const self = this as {
                process: (fn: (parent: unknown, target: string, attrs: Record<string, unknown>) => unknown) => void;
                createBlock: (parent: unknown, ctx: string, html: string, attrs: unknown, opts: unknown) => unknown;
            };
            self.process((parent: unknown, target: string, rawAttrs: Record<string, unknown>) => {
                if (action === 'passthrough') {
                    // Unlike a listing block (where "leave it untouched" means
                    // literally not touching the block), a block macro is
                    // always intercepted once a handler is registered for its
                    // name — there is no "pretend this macro doesn't exist"
                    // fallback in asciidoctor.js. Returning `undefined` here
                    // was verified (this session) to make the macro vanish
                    // completely and silently, with no trace in the output —
                    // confusing for a document author who just disabled the
                    // feature and would otherwise see nothing indicating a
                    // diagram used to be there. Render the raw macro syntax
                    // back as a literal paragraph instead.
                    //
                    // `subs: []` disables Asciidoctor's own `specialcharacters`
                    // substitution, so `target` (attacker-controlled document
                    // text) MUST be escaped here ourselves — verified against
                    // a real @asciidoctor/core conversion that an unescaped
                    // `target` containing e.g. `<img onerror=...>` lands raw
                    // in the converted HTML and is not caught by any
                    // sanitizer downstream (asciidoctor-vscode's preview
                    // webview runs with enableScripts and no output sanitizer
                    // of its own — see the note on svgSanitize.ts).
                    return self.createBlock(parent, 'paragraph', `kuml::${escapeHtml(target)}[]`, {}, { subs: [] });
                }
                if (action === 'restricted') {
                    return self.createBlock(parent, 'pass', buildRestricted({ name: target }), {}, { subs: [] });
                }
                if (action === 'placeholder-only') {
                    return self.createBlock(parent, 'pass', buildPlaceholder({ name: target }), {}, { subs: [] });
                }

                const attrs = parseAsciidocAttributes(rawAttrs);
                const resolved = resolveEmbeddedPath({
                    target,
                    documentDir: allowedGate!.documentDir!,
                    workspaceRoot: allowedGate!.workspaceRoot,
                    allowOutsideWorkspace: allowedGate!.config.allowPathsOutsideWorkspace,
                });
                if (!resolved.ok) {
                    return self.createBlock(
                        parent,
                        'pass',
                        buildError({ name: target, summary: 'kuml::[] path rejected', detail: resolved.reason }),
                        {},
                        { subs: [] },
                    );
                }

                const theme = attrs.theme ?? allowedGate!.config.defaultTheme;
                const name = attrs.name ?? path.basename(resolved.resolved, '.kuml.kts');
                const width = normalizeWidth(attrs.width);

                const source = readCappedSync(resolved.resolved);
                if (source === undefined) {
                    return self.createBlock(
                        parent,
                        'pass',
                        buildError({ name, summary: 'kuml::[] target could not be read', detail: resolved.resolved }),
                        {},
                        { subs: [] },
                    );
                }

                const key = computeKey(source, theme, name);
                const cached = deps.cache.peek(key);
                let html: string;
                if (cached) {
                    // A cache hit costs nothing to display, so it must never
                    // be pre-empted by the render budget below — the budget
                    // throttles NEW render work, not already-rendered
                    // diagrams (see Stolperfalle: budget-vs-scan-order
                    // mismatch in the class doc comment of `preRenderForExport`).
                    html = outcomeToHtml(cached, name, theme, width);
                } else {
                    renderedCount++;
                    if (context.mode === 'export') {
                        html =
                            classifyExportMiss(key, exportPreRender) === 'budget'
                                ? buildBudgetNotice({ rendered: renderedCount, limit: BLOCK_BUDGET })
                                : buildError({
                                      name,
                                      summary: 'kUML diagram not pre-rendered before export',
                                      detail: 'This macro was not rendered before the export deadline.',
                                  });
                    } else if (renderedCount > BLOCK_BUDGET) {
                        html = buildBudgetNotice({ rendered: renderedCount, limit: BLOCK_BUDGET });
                    } else {
                        void deps.cache.request(
                            key,
                            () =>
                                deps.render({
                                    source,
                                    theme,
                                    name,
                                    cliPath: allowedGate!.config.cliPath,
                                    serverUrl: allowedGate!.config.serverUrl,
                                }),
                            () => deps.scheduleRefresh(),
                        );
                        html = buildPlaceholder({ name, reservedHeight: deps.cache.sizeOf(key)?.height });
                    }
                }

                return self.createBlock(parent, 'pass', html, {}, { subs: [] });
            });
        });
    };
}
