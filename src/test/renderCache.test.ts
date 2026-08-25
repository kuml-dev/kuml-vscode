/**
 * Unit tests for `src/render/renderCache.ts`.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeKey, MAX_CONCURRENT_RENDERS, MAX_ENTRIES, RenderCache } from '../render/renderCache';
import type { RenderOutcome } from '../render/kumlRenderer';

function svgOutcome(svg: string): RenderOutcome {
    return { kind: 'svg', svg };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

test('computeKey is stable for identical inputs', () => {
    assert.equal(computeKey('src', 'kuml', 'diagram'), computeKey('src', 'kuml', 'diagram'));
});

test('computeKey differs when fields are shuffled across the NUL separator', () => {
    // "a\0b\0c" must differ from "a\0bc\0" — exactly why NUL separation matters.
    assert.notEqual(computeKey('a', 'b', 'c'), computeKey('a', 'bc', ''));
});

test('computeKey is sensitive to each of its three inputs independently', () => {
    const base = computeKey('source', 'kuml', 'diagram');
    assert.notEqual(computeKey('source2', 'kuml', 'diagram'), base);
    assert.notEqual(computeKey('source', 'plain', 'diagram'), base);
    assert.notEqual(computeKey('source', 'kuml', 'diagram2'), base);
});

test('peek returns undefined before any request, and the result after one settles', async () => {
    const cache = new RenderCache();
    const key = computeKey('s', 'kuml', 'n');
    assert.equal(cache.peek(key), undefined);
    await cache.request(key, async () => svgOutcome('<svg/>'));
    assert.deepEqual(cache.peek(key), svgOutcome('<svg/>'));
});

test('a 51st entry evicts the least-recently-used one', async () => {
    const cache = new RenderCache();
    for (let i = 0; i < MAX_ENTRIES; i++) {
        await cache.request(computeKey(`s${i}`, 'kuml', 'n'), async () => svgOutcome(`<svg id="${i}"/>`));
    }
    assert.equal(cache.size, MAX_ENTRIES);
    // Touch entry 0 so it becomes most-recently-used, protecting it from eviction.
    cache.peek(computeKey('s0', 'kuml', 'n'));

    await cache.request(computeKey('s-new', 'kuml', 'n'), async () => svgOutcome('<svg id="new"/>'));

    assert.equal(cache.size, MAX_ENTRIES, 'size stays capped at MAX_ENTRIES');
    assert.notEqual(cache.peek(computeKey('s0', 'kuml', 'n')), undefined, 'recently-touched entry must survive');
    assert.equal(cache.peek(computeKey('s1', 'kuml', 'n')), undefined, 'the actual LRU entry must be evicted');
});

test('request dedupes concurrent calls for the same key (run executes exactly once)', async () => {
    const cache = new RenderCache();
    let runCount = 0;
    const key = computeKey('s', 'kuml', 'n');
    const run = async () => {
        runCount++;
        return svgOutcome('<svg/>');
    };

    const [a, b] = await Promise.all([cache.request(key, run), cache.request(key, run)]);
    assert.equal(runCount, 1);
    assert.deepEqual(a, b);
});

test('at most MAX_CONCURRENT_RENDERS run() calls execute at once', async () => {
    const cache = new RenderCache();
    let concurrent = 0;
    let maxObserved = 0;
    const gates = Array.from({ length: MAX_CONCURRENT_RENDERS + 1 }, () => deferred<void>());

    const runs = gates.map((gate, i) =>
        cache.request(computeKey(`k${i}`, 'kuml', 'n'), async () => {
            concurrent++;
            maxObserved = Math.max(maxObserved, concurrent);
            await gate.promise;
            concurrent--;
            return svgOutcome(`<svg id="${i}"/>`);
        }),
    );

    // Give the first MAX_CONCURRENT_RENDERS a tick to actually start.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(maxObserved, MAX_CONCURRENT_RENDERS, 'concurrency must be capped');

    // Release them all; the queued one(s) should then run too.
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    assert.equal(maxObserved, MAX_CONCURRENT_RENDERS);
});

test('onSettled fires exactly once per pending -> settled transition', async () => {
    const cache = new RenderCache();
    let settledCount = 0;
    const key = computeKey('s', 'kuml', 'n');

    await cache.request(key, async () => svgOutcome('<svg/>'), () => settledCount++);
    assert.equal(settledCount, 1);

    // A second, independent request for a *different* key must fire its own onSettled once.
    const key2 = computeKey('s2', 'kuml', 'n');
    await cache.request(key2, async () => svgOutcome('<svg/>'), () => settledCount++);
    assert.equal(settledCount, 2);
});

test('isPending reflects an in-flight request and clears after settling', async () => {
    const cache = new RenderCache();
    const key = computeKey('s', 'kuml', 'n');
    const gate = deferred<void>();

    const promise = cache.request(key, async () => {
        await gate.promise;
        return svgOutcome('<svg/>');
    });

    assert.equal(cache.isPending(key), true);
    gate.resolve();
    await promise;
    assert.equal(cache.isPending(key), false);
});

test('sizeOf remembers the intrinsic size of an svg outcome', async () => {
    const cache = new RenderCache();
    const key = computeKey('s', 'kuml', 'n');
    await cache.request(key, async () => ({ kind: 'svg', svg: '<svg/>', intrinsic: { width: 100, height: 50 } }));
    assert.deepEqual(cache.sizeOf(key), { width: 100, height: 50 });
});

test('clear() empties the result/size caches', async () => {
    const cache = new RenderCache();
    const key = computeKey('s', 'kuml', 'n');
    await cache.request(key, async () => svgOutcome('<svg/>'));
    assert.equal(cache.size, 1);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.peek(key), undefined);
});

test('a second request() call for an already-pending key gets its own onSettled invoked too', async () => {
    // Regression test: two previews (e.g. a Markdown and an AsciiDoc preview
    // of the same diagram) that dedupe onto the same in-flight promise must
    // BOTH be told to refresh once it settles — not just the first caller.
    const cache = new RenderCache();
    const key = computeKey('s', 'kuml', 'n');
    const gate = deferred<void>();
    let firstSettled = 0;
    let secondSettled = 0;

    const first = cache.request(
        key,
        async () => {
            await gate.promise;
            return svgOutcome('<svg/>');
        },
        () => firstSettled++,
    );
    // Second caller arrives while the first is still pending — dedupes onto
    // the same promise, but must still register its own onSettled.
    const second = cache.request(key, () => Promise.reject(new Error('must not run — deduped')), () => secondSettled++);
    assert.equal(first, second, 'both calls must dedupe onto the same in-flight promise');

    gate.resolve();
    await first;
    assert.equal(firstSettled, 1);
    assert.equal(secondSettled, 1);
});

test('a render still in flight when clear() runs does not repopulate the cache with a stale result', async () => {
    // Regression test: changing kuml.cliPath/kuml.serverUrl calls clear();
    // a render already in flight under the OLD config must not silently
    // write its result into the freshly-cleared cache once it settles.
    const cache = new RenderCache();
    const key = computeKey('s', 'kuml', 'n');
    const gate = deferred<void>();

    const pending = cache.request(key, async () => {
        await gate.promise;
        return svgOutcome('<svg id="stale-config-result"/>');
    });

    cache.clear(); // simulates a kuml.cliPath/kuml.serverUrl config change mid-render
    gate.resolve();
    await pending;

    assert.equal(cache.peek(key), undefined, 'the stale-generation result must be discarded, not cached');
});

test('a render started AFTER clear() still populates the cache normally', async () => {
    const cache = new RenderCache();
    const key = computeKey('s', 'kuml', 'n');
    cache.clear();
    await cache.request(key, async () => svgOutcome('<svg/>'));
    assert.deepEqual(cache.peek(key), svgOutcome('<svg/>'));
});
