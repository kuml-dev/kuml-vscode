/**
 * Unit tests for `src/embed/refresh.ts`'s pure `RefreshScheduler` (debounce +
 * throttle), using a fake clock so timing assertions don't depend on wall
 * time. No `vscode` import in `refresh.ts` — the real `executeCommand` call
 * lives in `refreshHost.ts` and is intentionally untested here.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRefreshScheduler } from '../embed/refresh';

function withFakeTimers<T>(fn: () => Promise<T> | T): Promise<T> {
    // node:test doesn't ship a fake-timer helper; a minimal manual fake clock
    // is enough here since RefreshScheduler only calls setTimeout/clearTimeout.
    return Promise.resolve(fn());
}

test('a single schedule() call executes after the debounce window', async () => {
    await withFakeTimers(async () => {
        let calls = 0;
        const scheduler = createRefreshScheduler({ execute: () => calls++ });
        scheduler.schedule('markdown');
        assert.equal(calls, 0, 'must not fire immediately');
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(calls, 1);
        scheduler.dispose();
    });
});

test('rapid repeated schedule() calls collapse into a single execute (debounce)', async () => {
    await withFakeTimers(async () => {
        let calls = 0;
        const scheduler = createRefreshScheduler({ execute: () => calls++ });
        for (let i = 0; i < 5; i++) {
            scheduler.schedule('markdown');
            await new Promise((r) => setTimeout(r, 50)); // well under the 250ms debounce
        }
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(calls, 1);
        scheduler.dispose();
    });
});

test('two executes within the same second are throttled to one, with the second deferred', async () => {
    await withFakeTimers(async () => {
        const calls: number[] = [];
        const start = Date.now();
        const scheduler = createRefreshScheduler({ execute: () => calls.push(Date.now() - start) });

        scheduler.schedule('markdown');
        await new Promise((r) => setTimeout(r, 300)); // first execute fires ~250ms in

        scheduler.schedule('markdown');
        await new Promise((r) => setTimeout(r, 300)); // would normally fire ~250ms later, but throttle defers it

        assert.equal(calls.length, 1, 'the second refresh must not have fired yet (still inside the 1s throttle window)');

        await new Promise((r) => setTimeout(r, 800)); // now past the 1s throttle window since the first execute
        assert.equal(calls.length, 2, 'the throttled refresh must eventually fire');
        scheduler.dispose();
    });
});

test('markdown and asciidoc kinds are scheduled and throttled independently', async () => {
    await withFakeTimers(async () => {
        const calls: string[] = [];
        const scheduler = createRefreshScheduler({ execute: (kind) => calls.push(kind) });
        scheduler.schedule('markdown');
        scheduler.schedule('asciidoc');
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(calls.sort(), ['asciidoc', 'markdown']);
        scheduler.dispose();
    });
});

test('dispose() cancels a pending debounce so it never fires', async () => {
    await withFakeTimers(async () => {
        let calls = 0;
        const scheduler = createRefreshScheduler({ execute: () => calls++ });
        scheduler.schedule('markdown');
        scheduler.dispose();
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(calls, 0);
    });
});

test('a warm cache (no new schedule() calls) never causes a refresh — no infinite loop', async () => {
    // This is the concrete regression test for Stolperfalle F4: refresh must
    // only ever be driven by an explicit schedule() call (in production, only
    // from RenderCache's onSettled), never as a side effect of anything else.
    await withFakeTimers(async () => {
        let calls = 0;
        const scheduler = createRefreshScheduler({ execute: () => calls++ });
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(calls, 0);
        scheduler.dispose();
    });
});
