/**
 * Unit tests for the pure `decideGate` function in `src/embed/gate.ts`.
 * No `vscode` import anywhere in `gate.ts`, so this runs in plain Node — the
 * `vscode`-aware wrapper (`gateHost.ts`) is intentionally untested here since
 * it would require a `vscode` module stub (see the module's own doc comment
 * for why the split exists).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { decideGate, type EmbedConfig } from '../embed/gate';

const CONFIG: EmbedConfig = {
    cliPath: 'kuml',
    serverUrl: '',
    defaultTheme: 'kuml',
    allowPathsOutsideWorkspace: false,
};

test('disabled setting wins over everything else', () => {
    const result = decideGate({
        enabled: false,
        isTrusted: true,
        documentPath: '/ws/doc.md',
        isSupportedScheme: true,
        config: CONFIG,
    });
    assert.deepEqual(result, { allowed: false, reason: 'disabled' });
});

test('untrusted workspace is rejected even when enabled', () => {
    const result = decideGate({
        enabled: true,
        isTrusted: false,
        documentPath: '/ws/doc.md',
        isSupportedScheme: true,
        config: CONFIG,
    });
    assert.deepEqual(result, { allowed: false, reason: 'untrusted' });
});

test('a document with no path is rejected as unknown-document', () => {
    const result = decideGate({
        enabled: true,
        isTrusted: true,
        documentPath: undefined,
        isSupportedScheme: true,
        config: CONFIG,
    });
    assert.deepEqual(result, { allowed: false, reason: 'unknown-document' });
});

test('an unsupported scheme (e.g. a git diff view) is rejected as unknown-document', () => {
    const result = decideGate({
        enabled: true,
        isTrusted: true,
        documentPath: '/ws/doc.md',
        isSupportedScheme: false,
        config: CONFIG,
    });
    assert.deepEqual(result, { allowed: false, reason: 'unknown-document' });
});

test('allows and derives documentDir from documentPath when everything checks out', () => {
    const result = decideGate({
        enabled: true,
        isTrusted: true,
        documentPath: '/ws/sub/doc.md',
        isSupportedScheme: true,
        config: CONFIG,
        workspaceRoot: '/ws',
    });
    assert.equal(result.allowed, true);
    if (result.allowed) {
        assert.equal(result.documentDir, '/ws/sub');
        assert.equal(result.workspaceRoot, '/ws');
        assert.deepEqual(result.config, CONFIG);
    }
});

test('allows a document with no workspace folder (single-file mode)', () => {
    const result = decideGate({
        enabled: true,
        isTrusted: true,
        documentPath: '/tmp/scratch.md',
        isSupportedScheme: true,
        config: CONFIG,
    });
    assert.equal(result.allowed, true);
    if (result.allowed) {
        assert.equal(result.workspaceRoot, undefined);
        assert.equal(result.documentDir, '/tmp');
    }
});
