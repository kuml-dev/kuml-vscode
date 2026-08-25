/**
 * Unit tests for `src/render/kumlRenderer.ts`. The pure helper functions and
 * the `renderKuml({ source: '' })` short-circuit are covered without spawning
 * a real CLI; `renderViaServer` (the `kuml.serverUrl` HTTP path, including
 * both `MAX_SVG_BYTES` caps) is exercised directly against a real local HTTP
 * server below, rather than through `renderKuml`, because `renderKuml`'s CLI
 * fallback would otherwise swallow the specific server-side failure behind a
 * generic outcome once the (also-missing, in a test environment) CLI
 * fallback fails too. The CLI integration path itself is exercised
 * indirectly by `cli.test.ts` and by the pre-existing live-preview flow.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    MAX_SVG_BYTES,
    isValidServerUrl,
    readIntrinsicSize,
    renderKuml,
    renderViaServer,
    resolveTheme,
    sanitizeDiagramName,
} from '../render/kumlRenderer';

/** Starts a throwaway HTTP server for one test; caller must call the returned `close()`. */
async function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test('resolveTheme keeps a known requested theme', () => {
    assert.equal(resolveTheme('plain', 'kuml'), 'plain');
});

test('resolveTheme falls back to the fallback theme when requested is unknown', () => {
    assert.equal(resolveTheme('not-a-theme', 'plain'), 'plain');
});

test('resolveTheme falls back to undefined requested theme', () => {
    assert.equal(resolveTheme(undefined, 'elegant'), 'elegant');
});

test('resolveTheme falls back to "kuml" when even the fallback is unknown', () => {
    assert.equal(resolveTheme('nonsense', 'also-nonsense'), 'kuml');
});

test('sanitizeDiagramName strips characters outside [A-Za-z0-9._-]', () => {
    assert.equal(sanitizeDiagramName('../../etc/passwd; rm -rf'), '....etcpasswdrm-rf');
});

test('sanitizeDiagramName truncates to 64 chars', () => {
    const long = 'a'.repeat(100);
    assert.equal(sanitizeDiagramName(long).length, 64);
});

test('sanitizeDiagramName falls back to "diagram" for empty/undefined input', () => {
    assert.equal(sanitizeDiagramName(undefined), 'diagram');
    assert.equal(sanitizeDiagramName(''), 'diagram');
    assert.equal(sanitizeDiagramName('***'), 'diagram');
});

test('readIntrinsicSize reads width/height attributes', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120.5" height="80"><rect/></svg>';
    assert.deepEqual(readIntrinsicSize(svg), { width: 120.5, height: 80 });
});

test('readIntrinsicSize falls back to viewBox when width/height are absent', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"><rect/></svg>';
    assert.deepEqual(readIntrinsicSize(svg), { width: 300, height: 150 });
});

test('readIntrinsicSize returns undefined when neither is present', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    assert.equal(readIntrinsicSize(svg), undefined);
});

test('readIntrinsicSize returns undefined for a non-svg string', () => {
    assert.equal(readIntrinsicSize('not an svg at all'), undefined);
});

test('isValidServerUrl accepts http and https', () => {
    assert.equal(isValidServerUrl('http://127.0.0.1:8080'), true);
    assert.equal(isValidServerUrl('https://kuml.example.com'), true);
});

test('isValidServerUrl rejects non-http(s) schemes and malformed URLs', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'data:text/plain,hi', 'not a url', '']) {
        assert.equal(isValidServerUrl(url), false, `expected ${JSON.stringify(url)} to be rejected`);
    }
});

test('renderKuml falls back to the CLI when serverUrl is not a valid http(s) URL', async () => {
    const outcome = await renderKuml({
        source: 'classDiagram { }',
        theme: 'kuml',
        name: 'diagram',
        cliPath: '/definitely/not/a/real/path/kuml-does-not-exist',
        serverUrl: 'file:///etc/passwd',
    });
    assert.equal(outcome.kind, 'cli-missing');
});

test('renderKuml short-circuits on empty/whitespace-only source without spawning anything', async () => {
    const outcome = await renderKuml({
        source: '   \n\t  ',
        theme: 'kuml',
        name: 'diagram',
        cliPath: '/definitely/not/a/real/path/kuml',
        serverUrl: '',
    });
    assert.deepEqual(outcome, { kind: 'empty' });
});

test('renderKuml reports cli-missing for a nonexistent cliPath (no serverUrl)', async () => {
    const outcome = await renderKuml({
        source: 'classDiagram { }',
        theme: 'kuml',
        name: 'diagram',
        cliPath: '/definitely/not/a/real/path/kuml-does-not-exist',
        serverUrl: '',
    });
    assert.equal(outcome.kind, 'cli-missing');
});

test('renderKuml reports an error (not a crash) when serverUrl is unreachable and the CLI is also missing', async () => {
    const outcome = await renderKuml({
        source: 'classDiagram { }',
        theme: 'kuml',
        name: 'diagram',
        cliPath: '/definitely/not/a/real/path/kuml-does-not-exist',
        serverUrl: 'http://127.0.0.1:1', // port 1 — nothing listens there
    });
    // Server fails (connection refused) -> falls back to CLI -> CLI missing.
    assert.equal(outcome.kind, 'cli-missing');
});

test('renderViaServer resolves with the svg on a normal 2xx response', async () => {
    const server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, svg: '<svg><rect width="1"/></svg>' }));
    });
    try {
        const svg = await renderViaServer(server.url, 'classDiagram { }', 'kuml', undefined);
        assert.equal(svg, '<svg><rect width="1"/></svg>');
    } finally {
        await server.close();
    }
});

test('renderViaServer rejects on a non-2xx HTTP status', async () => {
    const server = await startServer((_req, res) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
    });
    try {
        await assert.rejects(
            renderViaServer(server.url, 'classDiagram { }', 'kuml', undefined),
            /HTTP 500/,
        );
    } finally {
        await server.close();
    }
});

test('renderViaServer rejects when the response body says ok:false', async () => {
    const server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'kotlin script did not compile' }));
    });
    try {
        await assert.rejects(
            renderViaServer(server.url, 'classDiagram { }', 'kuml', undefined),
            /kotlin script did not compile/,
        );
    } finally {
        await server.close();
    }
});

test('renderViaServer rejects when a truthful content-length header exceeds MAX_SVG_BYTES, without reading the body', async () => {
    const server = await startServer((_req, res) => {
        // Report an oversized content-length but never actually send that much —
        // if renderViaServer tried to read the whole declared length, this test
        // would hang/timeout instead of failing fast.
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MAX_SVG_BYTES + 1) });
        res.end(JSON.stringify({ ok: true, svg: '<svg/>' }));
    });
    try {
        await assert.rejects(
            renderViaServer(server.url, 'classDiagram { }', 'kuml', undefined),
            /exceeded the .*byte cap/,
        );
    } finally {
        await server.close();
    }
});

test('renderViaServer honours an externally-supplied AbortSignal combined with the HTTP timeout (no AbortSignal.any dependency)', async () => {
    let requestReachedServer = false;
    const server = await startServer((_req, res) => {
        requestReachedServer = true;
        // Never respond — the point is that the caller's own signal (already
        // aborted here) must cut the request short without waiting for
        // HTTP_TIMEOUT_MS, and without relying on `AbortSignal.any` (which
        // this extension's declared minimum Node/Electron host doesn't have).
        void res;
    });
    try {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(renderViaServer(server.url, 'classDiagram { }', 'kuml', controller.signal));
        assert.equal(requestReachedServer, false, 'fetch must never even dispatch on an already-aborted signal');
    } finally {
        await server.close();
    }
});

test('renderViaServer rejects when the actual decoded svg exceeds MAX_SVG_BYTES even without a content-length header', async () => {
    const oversizedSvg = `<svg>${'a'.repeat(MAX_SVG_BYTES)}</svg>`;
    const server = await startServer((_req, res) => {
        // Chunked transfer (no content-length) so only the post-decode
        // Buffer.byteLength check — not the content-length shortcut — can
        // catch this.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, svg: oversizedSvg }));
    });
    try {
        await assert.rejects(
            renderViaServer(server.url, 'classDiagram { }', 'kuml', undefined),
            /exceeded the .*byte cap/,
        );
    } finally {
        await server.close();
    }
});
