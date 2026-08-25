import type MarkdownIt from 'markdown-it';
import { sanitizeSvg } from '../svgSanitize';
import { computeKey, type RenderCache } from '../render/renderCache';
import type { RenderOutcome, RenderRequest } from '../render/kumlRenderer';
import { isKumlFenceInfo, normalizeWidth, parseFenceAttributes } from './attributes';
import {
    buildBudgetNotice,
    buildCliMissing,
    buildDiagram,
    buildEmpty,
    buildError,
    buildPlaceholder,
    buildRestricted,
} from './embedHtml';
import type { GateResult } from './gate';

/**
 * markdown-it `fence` rule override that renders ```` ```kuml ```` fenced
 * code blocks as live kUML diagrams in VS Code's built-in Markdown preview.
 *
 * No `vscode` import here — kept pure so it's testable against a real
 * `markdown-it` instance in plain Node. The `vscode`-aware wiring (gate,
 * refresh, config) is injected via `MarkdownItDeps` and assembled once, in
 * `extension.ts`, using the real `gateHost`/`refreshHost` modules.
 */

/** A structural subset of `vscode.Uri` — avoids importing `vscode` in this module. */
export interface DocumentUriLike {
    fsPath: string;
    scheme: string;
}

export interface MarkdownItDeps {
    /** Evaluates the trust/enablement gate for the 'markdown' kind. */
    evaluateGate: (documentUri: DocumentUriLike | undefined) => GateResult;
    /** Debounced+throttled "please refresh the Markdown preview" signal. */
    scheduleRefresh: () => void;
    cache: RenderCache;
    render: (req: RenderRequest) => Promise<RenderOutcome>;
}

/** Blocks beyond this count per document render as a single budget notice instead of individually rendering. */
export const BLOCK_BUDGET = 20;

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
 * Builds the `(md) => md` function VS Code's `markdown.markdownItPlugins`
 * contribution point expects, closing over the supplied dependencies.
 */
export function createMarkdownItPlugin(deps: MarkdownItDeps): (md: MarkdownIt) => MarkdownIt {
    return function extendMarkdownIt(md: MarkdownIt): MarkdownIt {
        const prevFence: MarkdownIt.Renderer.RenderRule =
            md.renderer.rules.fence ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

        md.renderer.rules.fence = (tokens: MarkdownIt.Token[], idx: number, options, env, self) => {
            const token = tokens[idx];
            if (!isKumlFenceInfo(token.info)) {
                return prevFence(tokens, idx, options, env, self);
            }

            const documentUri: DocumentUriLike | undefined = env?.currentDocument;
            const gate = deps.evaluateGate(documentUri);

            if (!gate.allowed) {
                if (gate.reason === 'untrusted') {
                    return buildRestricted({ name: 'diagram' });
                }
                // 'disabled' and 'unknown-document' both fall back to plain code rendering.
                return prevFence(tokens, idx, options, env, self);
            }

            const attrs = parseFenceAttributes(token.info);
            const source = token.content;
            const theme = attrs.theme ?? gate.config.defaultTheme;
            const name = attrs.name ?? 'diagram';
            const width = normalizeWidth(attrs.width);
            // `width` is deliberately excluded from the cache key (F10): it's a
            // pure display option, not part of what was rendered.
            const key = computeKey(source, theme, name);

            const cached = deps.cache.peek(key);
            if (cached) {
                // A cache hit costs nothing to display, so it must never be
                // pre-empted by the render budget below — mirrors the
                // AsciiDoc registrar's identical reasoning (see the
                // Stolperfalle note in `preRenderForExport`'s doc comment in
                // asciidoc.ts). Previously this check ran AFTER the budget
                // counter below, so a warm cache still burned a budget slot
                // and could permanently hide diagrams past BLOCK_BUDGET
                // behind a budget notice even though displaying them costs
                // nothing (2026-08 review finding).
                return outcomeToHtml(cached, name, theme, width);
            }

            const renderedSoFar = ((env.__kumlRendered as number | undefined) ?? 0) + 1;
            env.__kumlRendered = renderedSoFar;
            if (renderedSoFar > BLOCK_BUDGET) {
                return buildBudgetNotice({ rendered: renderedSoFar, limit: BLOCK_BUDGET });
            }

            void deps.cache.request(
                key,
                () =>
                    deps.render({
                        source,
                        theme,
                        name,
                        cliPath: gate.config.cliPath,
                        serverUrl: gate.config.serverUrl,
                    }),
                () => deps.scheduleRefresh(),
            );

            return buildPlaceholder({ name, reservedHeight: deps.cache.sizeOf(key)?.height });
        };

        return md;
    };
}
