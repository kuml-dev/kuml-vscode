/**
 * Unit tests for `src/cli.ts`'s timeout/abort/byte-cap behavior. Uses
 * `process.execPath -e "<script>"` as a portable test "child" — no `sh`,
 * so this runs identically on Windows CI.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnCli, spawnCliCapture } from '../cli';

const NODE = process.execPath;

test('spawnCli resolves on a clean exit', async () => {
    await assert.doesNotReject(spawnCli(NODE, ['-e', 'process.exit(0)']));
});

test('spawnCli rejects with a trimmed stderr tail on non-zero exit', async () => {
    await assert.rejects(
        spawnCli(NODE, ['-e', 'console.error("boom"); process.exit(1)']),
        /kuml CLI exited with code 1[\s\S]*boom/,
    );
});

test('spawnCli rejects with an ENOENT hint when the binary does not exist', async () => {
    await assert.rejects(
        spawnCli('/definitely/not/a/real/binary/kuml-xyz', []),
        /kuml\.cliPath/,
    );
});

test('spawnCli times out and kills a long-running child', async () => {
    const start = Date.now();
    await assert.rejects(
        spawnCli(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
        /terminated/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `expected the timeout to fire quickly, took ${elapsed}ms`);
});

test('spawnCli honors an AbortSignal', async () => {
    const controller = new AbortController();
    const promise = spawnCli(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(promise, /terminated/);
});

test('spawnCliCapture resolves with stdout on a clean exit', async () => {
    const out = await spawnCliCapture(NODE, ['-e', 'process.stdout.write("hello")']);
    assert.equal(out, 'hello');
});

test('spawnCliCapture enforces maxStdoutBytes and kills the child', async () => {
    await assert.rejects(
        spawnCliCapture(NODE, ['-e', 'process.stdout.write("x".repeat(1000)); setTimeout(()=>{}, 5000)'], {
            maxStdoutBytes: 10,
        }),
        /byte cap/,
    );
});

test('spawnCliCapture times out a long-running child', async () => {
    await assert.rejects(
        spawnCliCapture(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
        /terminated/,
    );
});
