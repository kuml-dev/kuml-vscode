import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnCli, DEFAULT_CLI_TIMEOUT_MS } from '../cli';

/**
 * Shared kUML render pipeline: the same dual server/CLI strategy the
 * live-preview panel already used (see `previewPanel.ts` history), extracted
 * so the Markdown/AsciiDoc embed processors (`src/embed/*`) can call it too,
 * without duplicating the HTTP/CLI/temp-file dance three times.
 *
 * No `vscode` import here — kept pure so it's unit-testable in plain Node,
 * same convention as `svgSanitize.ts` / `lspLocator.ts`.
 */

export type RenderOutcome =
    | { kind: 'svg'; svg: string; intrinsic?: { width: number; height: number } }
    | { kind: 'empty' }
    | { kind: 'cli-missing'; message: string }
    | { kind: 'error'; summary: string; detail?: string };

export interface RenderRequest {
    /** Raw kUML DSL text. Never logged. */
    source: string;
    /** Already validated against KNOWN_THEMES by the caller. */
    theme: string;
    /** Base name used for the temp file and the aria-label. Sanitized by the caller. */
    name: string;
    cliPath: string;
    /** Empty string = CLI-only. */
    serverUrl: string;
    signal?: AbortSignal;
}

/** Hard timeout for the `kuml.serverUrl` HTTP render path. */
export const HTTP_TIMEOUT_MS = 15_000;

/** Refuse to hold onto (or inline) an SVG bigger than this. */
export const MAX_SVG_BYTES = 50 * 1024 * 1024;

/** Themes registered via kUML's ThemeRegistry — anything else falls back. */
export const KNOWN_THEMES: ReadonlySet<string> = new Set(['kuml', 'plain', 'elegant', 'playful']);

/** Falls back to `fallback` when `requested` is undefined or not in KNOWN_THEMES. */
export function resolveTheme(requested: string | undefined, fallback: string): string {
    if (requested && KNOWN_THEMES.has(requested)) {
        return requested;
    }
    return KNOWN_THEMES.has(fallback) ? fallback : 'kuml';
}

/** Strips anything that is not [A-Za-z0-9._-], truncates to 64 chars, '' -> 'diagram'. */
export function sanitizeDiagramName(raw: string | undefined): string {
    const cleaned = (raw ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    return cleaned.length > 0 ? cleaned : 'diagram';
}

/** Reads width/height (or viewBox) off the SVG root for placeholder-height memoization. */
export function readIntrinsicSize(svg: string): { width: number; height: number } | undefined {
    const rootMatch = svg.match(/<svg\b[^>]*>/i);
    if (!rootMatch) {
        return undefined;
    }
    const root = rootMatch[0];

    const widthMatch = root.match(/\bwidth\s*=\s*"([\d.]+)/i);
    const heightMatch = root.match(/\bheight\s*=\s*"([\d.]+)/i);
    if (widthMatch && heightMatch) {
        const width = parseFloat(widthMatch[1]);
        const height = parseFloat(heightMatch[1]);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return { width, height };
        }
    }

    const viewBoxMatch = root.match(/\bviewBox\s*=\s*"([^"]+)"/i);
    if (viewBoxMatch) {
        const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
            return { width: parts[2], height: parts[3] };
        }
    }

    return undefined;
}

function isEnoent(err: unknown): boolean {
    return err instanceof Error && /ENOENT/.test(err.message);
}

/**
 * `kuml.serverUrl` must be `http://` or `https://` — this is the only guard
 * against an SSRF-style redirect through `fetch` (e.g. `file://`, `data:`,
 * or an exotic custom scheme a future Node version might dispatch
 * differently). `kuml.serverUrl` is machine-scoped (not workspace-writable),
 * so this is defense-in-depth rather than the primary control, but it's
 * cheap and catches a plain misconfiguration too.
 */
export function isValidServerUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * `AbortSignal.any` was only added in Node 20.3 — this extension's declared
 * minimum host (`engines.vscode: ^1.85.0`, i.e. Electron 25 / Node 18.15)
 * predates it, so calling it directly would throw `TypeError: AbortSignal.any
 * is not a function` on that host as soon as any caller passes a `signal`.
 * Manual combinator: aborts as soon as either input signal aborts, and
 * removes its listeners once settled so it never leaks past the fetch call.
 */
function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    const controller = new AbortController();
    if (a.aborted || b.aborted) {
        controller.abort();
        return controller.signal;
    }
    const onAbort = (): void => controller.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    controller.signal.addEventListener(
        'abort',
        () => {
            a.removeEventListener('abort', onAbort);
            b.removeEventListener('abort', onAbort);
        },
        { once: true },
    );
    return controller.signal;
}

/** Exported for direct unit testing (see `kumlRenderer.test.ts`) — `renderKuml`'s
 *  CLI fallback otherwise swallows the specific server-side failure reason
 *  behind a generic `cli-missing`/`error` outcome once the (also-missing in
 *  most test environments) CLI fallback fails too. */
export async function renderViaServer(
    serverUrl: string,
    source: string,
    theme: string,
    signal: AbortSignal | undefined,
): Promise<string> {
    if (!isValidServerUrl(serverUrl)) {
        throw new Error(`kuml.serverUrl is not a valid http(s) URL: "${serverUrl}"`);
    }
    const url = `${serverUrl.replace(/\/+$/, '')}/api/render`;
    const timeoutSignal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const combinedSignal = signal ? combineAbortSignals(signal, timeoutSignal) : timeoutSignal;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: source, format: 'svg', theme }),
        signal: combinedSignal,
    });
    if (!res.ok) {
        throw new Error(`kuml serve responded with HTTP ${res.status}`);
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_SVG_BYTES) {
        throw new Error(`kuml serve response exceeded the ${MAX_SVG_BYTES}-byte cap`);
    }

    // Stream-count bytes rather than trusting content-length (which may be absent or wrong).
    const body = (await res.json()) as { ok: boolean; svg?: string; error?: string };
    if (!body.ok || !body.svg) {
        throw new Error(body.error ?? 'kuml serve render returned ok=false with no error message');
    }
    if (Buffer.byteLength(body.svg, 'utf8') > MAX_SVG_BYTES) {
        throw new Error(`kuml serve response exceeded the ${MAX_SVG_BYTES}-byte cap`);
    }
    return body.svg;
}

async function renderViaCli(
    cliPath: string,
    theme: string,
    source: string,
    name: string,
    signal: AbortSignal | undefined,
): Promise<string> {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kuml-vscode-embed-'));
    try {
        const tmpSource = path.join(tmpDir, `${name}.kuml.kts`);
        const tmpOutput = path.join(tmpDir, `${name}.svg`);
        await fs.promises.writeFile(tmpSource, source, { encoding: 'utf8' });

        await spawnCli(cliPath, ['render', '--theme', theme, '--format', 'svg', '--output', tmpOutput, tmpSource], {
            timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
            signal,
        });

        const stat = await fs.promises.stat(tmpOutput).catch(() => undefined);
        if (!stat) {
            throw new Error(`kuml render produced no output at ${tmpOutput}.`);
        }
        if (stat.size > MAX_SVG_BYTES) {
            throw new Error(`kuml render output exceeded the ${MAX_SVG_BYTES}-byte cap`);
        }
        return await fs.promises.readFile(tmpOutput, { encoding: 'utf8' });
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/**
 * Renders one kUML diagram, trying `serverUrl` first (if set) and falling
 * back to the CLI. Never throws — every failure mode is a `RenderOutcome`
 * variant so callers (markdown-it fence renderer, asciidoctor processors)
 * can synchronously decide what placeholder/card to show.
 */
export async function renderKuml(req: RenderRequest): Promise<RenderOutcome> {
    if (req.source.trim().length === 0) {
        return { kind: 'empty' };
    }

    const theme = resolveTheme(req.theme, 'kuml');
    const name = sanitizeDiagramName(req.name);

    let fallbackNote: string | undefined;

    if (req.serverUrl) {
        try {
            const svg = await renderViaServer(req.serverUrl, req.source, theme, req.signal);
            return { kind: 'svg', svg, intrinsic: readIntrinsicSize(svg) };
        } catch (err: unknown) {
            fallbackNote = err instanceof Error ? err.message : String(err);
        }
    }

    try {
        const svg = await renderViaCli(req.cliPath, theme, req.source, name, req.signal);
        return { kind: 'svg', svg, intrinsic: readIntrinsicSize(svg) };
    } catch (err: unknown) {
        if (isEnoent(err)) {
            return {
                kind: 'cli-missing',
                message: `kUML CLI not found at "${req.cliPath}". Install it (see kuml.dev) or set "kuml.cliPath".`,
            };
        }
        const detailParts = [fallbackNote, err instanceof Error ? err.message : String(err)].filter(
            (p): p is string => !!p,
        );
        return {
            kind: 'error',
            summary: 'kUML render failed',
            detail: detailParts.join('\n\n'),
        };
    }
}
