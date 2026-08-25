/**
 * Unit tests for `src/embed/pathGuard.ts`, including real symlinks under
 * `os.tmpdir()` to exercise the realpath-based containment check.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveEmbeddedPath, resolveIncludeTarget } from '../embed/pathGuard';

function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-pathguard-test-'));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('rejects an empty target', () => {
    const result = resolveEmbeddedPath({
        target: '',
        documentDir: '/tmp/doc',
        allowOutsideWorkspace: false,
    });
    assert.equal(result.ok, false);
});

test('rejects a target without the .kuml.kts extension', () => {
    const result = resolveEmbeddedPath({
        target: 'diagrams/login.txt',
        documentDir: '/tmp/doc',
        allowOutsideWorkspace: false,
    });
    assert.equal(result.ok, false);
});

test('rejects http(s)/file/ftp URL targets', () => {
    for (const target of ['http://evil.example/x.kuml.kts', 'https://evil.example/x.kuml.kts', 'file:///etc/passwd.kuml.kts', 'ftp://evil.example/x.kuml.kts']) {
        const result = resolveEmbeddedPath({ target, documentDir: '/tmp/doc', allowOutsideWorkspace: false });
        assert.equal(result.ok, false, `expected rejection for ${target}`);
    }
});

test('rejects ../../ traversal outside the workspace root', () => {
    withTempDir((root) => {
        const workspaceRoot = path.join(root, 'workspace');
        const docDir = path.join(workspaceRoot, 'docs');
        fs.mkdirSync(docDir, { recursive: true });

        const result = resolveEmbeddedPath({
            target: '../../../etc/passwd.kuml.kts',
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: false,
        });
        assert.equal(result.ok, false);
    });
});

test('accepts a target inside the workspace root', () => {
    withTempDir((root) => {
        const workspaceRoot = path.join(root, 'workspace');
        const docDir = path.join(workspaceRoot, 'docs');
        fs.mkdirSync(docDir, { recursive: true });

        const result = resolveEmbeddedPath({
            target: 'diagrams/login.kuml.kts',
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: false,
        });
        assert.ok(result.ok);
        if (result.ok) {
            assert.equal(result.resolved, path.join(docDir, 'diagrams', 'login.kuml.kts'));
        }
    });
});

test('rejects a sibling directory that merely shares a name prefix (/repo vs /repo-evil)', () => {
    withTempDir((root) => {
        const repo = path.join(root, 'repo');
        const repoEvil = path.join(root, 'repo-evil');
        fs.mkdirSync(repo, { recursive: true });
        fs.mkdirSync(repoEvil, { recursive: true });

        // A naive `candidate.startsWith(base)` string check would wrongly
        // accept "/repo-evil/x" as being "inside" "/repo" — this must reject.
        const result = resolveEmbeddedPath({
            target: path.join(repoEvil, 'x.kuml.kts'),
            documentDir: repo,
            workspaceRoot: repo,
            allowOutsideWorkspace: false,
        });
        assert.equal(result.ok, false);
    });
});

test('rejects a symlink inside the allowed tree that points outside it', () => {
    withTempDir((root) => {
        const allowed = path.join(root, 'allowed');
        const outside = path.join(root, 'outside');
        fs.mkdirSync(allowed, { recursive: true });
        fs.mkdirSync(outside, { recursive: true });
        const secretTarget = path.join(outside, 'secret.kuml.kts');
        fs.writeFileSync(secretTarget, 'classDiagram { }');

        const linkPath = path.join(allowed, 'link.kuml.kts');
        fs.symlinkSync(secretTarget, linkPath);

        const result = resolveEmbeddedPath({
            target: 'link.kuml.kts',
            documentDir: allowed,
            workspaceRoot: allowed,
            allowOutsideWorkspace: false,
        });
        assert.equal(result.ok, false, 'a symlink escaping the workspace root must be rejected');
    });
});

test('accepts a symlink that stays inside the allowed tree', () => {
    withTempDir((root) => {
        const allowed = path.join(root, 'allowed');
        const realDir = path.join(allowed, 'real');
        fs.mkdirSync(realDir, { recursive: true });
        const realTarget = path.join(realDir, 'diagram.kuml.kts');
        fs.writeFileSync(realTarget, 'classDiagram { }');

        const linkPath = path.join(allowed, 'link.kuml.kts');
        fs.symlinkSync(realTarget, linkPath);

        const result = resolveEmbeddedPath({
            target: 'link.kuml.kts',
            documentDir: allowed,
            workspaceRoot: allowed,
            allowOutsideWorkspace: false,
        });
        assert.ok(result.ok, 'a symlink that stays inside the allowed tree must be accepted');
    });
});

test('allowOutsideWorkspace removes the containment boundary entirely, it does not narrow it to documentDir', () => {
    // Regression test (2026-08 review finding): the setting exists so a
    // document CAN reach a kUML script outside its own workspace folder —
    // the previous implementation instead narrowed the base from
    // workspaceRoot down to documentDir when the flag was turned on, which
    // is BACKWARDS (documentDir nests inside workspaceRoot, so it's a
    // stricter boundary, not a looser one). That broke every
    // sibling-of-docDir reference elsewhere in the SAME workspace the moment
    // a user enabled the flag to reach a path genuinely outside the
    // workspace.
    withTempDir((root) => {
        const workspaceRoot = path.join(root, 'workspace');
        const docDir = path.join(workspaceRoot, 'docs');
        const shared = path.join(workspaceRoot, 'shared');
        fs.mkdirSync(docDir, { recursive: true });
        fs.mkdirSync(shared, { recursive: true });

        // Without the flag: base is the workspace root, so a sibling
        // directory of docDir (still inside the workspace) is accepted.
        const withoutFlag = resolveEmbeddedPath({
            target: '../shared/x.kuml.kts',
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: false,
        });
        assert.ok(withoutFlag.ok, 'a sibling of docDir inside the workspace must resolve without the flag');

        // With the flag: must not become MORE restrictive than the disabled
        // case — the exact sibling reference above must keep working.
        const withFlagSibling = resolveEmbeddedPath({
            target: '../shared/x.kuml.kts',
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: true,
        });
        assert.ok(withFlagSibling.ok, 'enabling the flag must not break a reference that already worked without it');

        // With the flag: a target genuinely OUTSIDE the workspace root is
        // now accepted too — that is the whole point of the setting.
        const outsideWorkspace = path.join(root, 'outside-workspace-doc-dir');
        fs.mkdirSync(outsideWorkspace, { recursive: true });
        const withFlagOutside = resolveEmbeddedPath({
            target: path.join(outsideWorkspace, 'x.kuml.kts'),
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: true,
        });
        assert.ok(withFlagOutside.ok, 'a target outside the workspace root must resolve once the flag is on');
    });
});

test('resolveIncludeTarget accepts a non-.kuml.kts extension (an ordinary AsciiDoc include target)', () => {
    withTempDir((root) => {
        const workspaceRoot = path.join(root, 'workspace');
        const docDir = path.join(workspaceRoot, 'docs');
        fs.mkdirSync(docDir, { recursive: true });

        const result = resolveIncludeTarget({
            target: 'chapters/intro.adoc',
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: false,
        });
        assert.ok(result.ok, 'include:: targets are not restricted to .kuml.kts');
        if (result.ok) {
            assert.equal(result.resolved, path.join(docDir, 'chapters', 'intro.adoc'));
        }
    });
});

test('resolveIncludeTarget rejects ../../ traversal outside the workspace root', () => {
    withTempDir((root) => {
        const workspaceRoot = path.join(root, 'workspace');
        const docDir = path.join(workspaceRoot, 'docs');
        fs.mkdirSync(docDir, { recursive: true });

        const result = resolveIncludeTarget({
            target: '../../../etc/passwd',
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: false,
        });
        assert.equal(result.ok, false);
    });
});

test('resolveIncludeTarget rejects a URL target', () => {
    const result = resolveIncludeTarget({
        target: 'https://evil.example/inject.adoc',
        documentDir: '/tmp/doc',
        allowOutsideWorkspace: false,
    });
    assert.equal(result.ok, false);
});

test('resolveIncludeTarget rejects an empty target', () => {
    const result = resolveIncludeTarget({ target: '', documentDir: '/tmp/doc', allowOutsideWorkspace: false });
    assert.equal(result.ok, false);
});

test('resolveIncludeTarget: allowOutsideWorkspace removes the containment boundary entirely (same fix as resolveEmbeddedPath)', () => {
    withTempDir((root) => {
        const workspaceRoot = path.join(root, 'workspace');
        const docDir = path.join(workspaceRoot, 'docs');
        const outsideWorkspace = path.join(root, 'outside-workspace');
        fs.mkdirSync(docDir, { recursive: true });
        fs.mkdirSync(outsideWorkspace, { recursive: true });

        const withoutFlag = resolveIncludeTarget({
            target: path.join(outsideWorkspace, 'chapter.adoc'),
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: false,
        });
        assert.equal(withoutFlag.ok, false);

        const withFlag = resolveIncludeTarget({
            target: path.join(outsideWorkspace, 'chapter.adoc'),
            documentDir: docDir,
            workspaceRoot,
            allowOutsideWorkspace: true,
        });
        assert.ok(withFlag.ok, 'a target outside the workspace root must resolve once the flag is on');
    });
});
