import * as crypto from 'crypto';
import type { RenderOutcome } from './kumlRenderer';

/**
 * In-memory cache + concurrency limiter for `renderKuml` results, shared by
 * the Markdown and AsciiDoc embed processors. Mirrors the JetBrains plugin's
 * `KumlDocPreviewCache` (SHA-256 over `source \0 theme \0 name`, LRU capped at
 * 50 entries) so the two ecosystems agree on cache semantics even though they
 * don't share code.
 *
 * No `vscode` import here — kept pure so it's unit-testable in plain Node.
 */

export const MAX_ENTRIES = 50;
export const MAX_CONCURRENT_RENDERS = 2;

/** SHA-256 hex over `source \0 theme \0 name` — identical scheme to KumlDocPreviewCache.
 *  `width` is deliberately NOT part of the key: it's a pure display option and
 *  must not force a re-render (see plan Stolperfalle F10). */
export function computeKey(source: string, theme: string, name: string): string {
    return crypto.createHash('sha256').update(`${source}\0${theme}\0${name}`, 'utf8').digest('hex');
}

/** Minimal insertion-ordered LRU: `Map` preserves insertion order, and a
 *  delete+re-set on access moves a key to the "most recently used" end. */
class Lru<V> {
    private readonly map = new Map<string, V>();

    constructor(private readonly maxEntries: number) {}

    get size(): number {
        return this.map.size;
    }

    get(key: string): V | undefined {
        const value = this.map.get(key);
        if (value === undefined) {
            return undefined;
        }
        // Touch: move to the back (most-recently-used).
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    /** Like `get`, but does not affect recency — used for cheap existence checks. */
    peek(key: string): V | undefined {
        return this.map.get(key);
    }

    set(key: string, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next();
            if (oldest.done) {
                break;
            }
            this.map.delete(oldest.value);
        }
    }

    delete(key: string): void {
        this.map.delete(key);
    }

    clear(): void {
        this.map.clear();
    }
}

export class RenderCache {
    private readonly results = new Lru<RenderOutcome>(MAX_ENTRIES);
    private readonly sizes = new Lru<{ width: number; height: number }>(MAX_ENTRIES);
    private readonly pending = new Map<string, Promise<RenderOutcome>>();
    /** All `onSettled` callbacks registered for a still-in-flight key (one entry per caller). */
    private readonly listeners = new Map<string, Set<() => void>>();
    private running = 0;
    private readonly queue: Array<() => void> = [];
    /**
     * Bumped by `clear()`. A render that was already in flight when `clear()`
     * ran belongs to a stale generation and must not repopulate the fresh
     * cache once it finishes — see the `clear()` doc comment.
     */
    private generation = 0;

    /** Cache lookup only — never starts work. Used by the synchronous render callbacks. */
    peek(key: string): RenderOutcome | undefined {
        return this.results.get(key);
    }

    isPending(key: string): boolean {
        return this.pending.has(key);
    }

    /** Remembered intrinsic size, so a re-render reserves the right placeholder height. */
    sizeOf(key: string): { width: number; height: number } | undefined {
        return this.sizes.peek(key);
    }

    get size(): number {
        return this.results.size;
    }

    /**
     * Returns the in-flight promise for `key` if one exists (dedupe), otherwise queues
     * `run` behind at most MAX_CONCURRENT_RENDERS concurrent executions.
     * `onSettled` fires exactly once per *caller* when the key transitions
     * pending -> settled — every caller that calls `request()` for the same
     * still-pending key gets its own `onSettled` invoked, not just the first
     * (a Markdown preview and an AsciiDoc preview open on the same diagram
     * would otherwise dedupe onto the same promise and only the first
     * caller's preview would ever be told to refresh).
     */
    request(key: string, run: () => Promise<RenderOutcome>, onSettled?: () => void): Promise<RenderOutcome> {
        const existing = this.pending.get(key);
        if (existing) {
            if (onSettled) {
                this.listenersFor(key).add(onSettled);
            }
            return existing;
        }

        if (onSettled) {
            this.listenersFor(key).add(onSettled);
        }
        const generationAtStart = this.generation;
        const promise = this.runQueued(key, run, generationAtStart);
        this.pending.set(key, promise);
        return promise;
    }

    private listenersFor(key: string): Set<() => void> {
        let set = this.listeners.get(key);
        if (!set) {
            set = new Set();
            this.listeners.set(key, set);
        }
        return set;
    }

    private async runQueued(key: string, run: () => Promise<RenderOutcome>, generationAtStart: number): Promise<RenderOutcome> {
        await this.acquireSlot();
        try {
            const outcome = await run();
            // Discard the result if a `clear()` (e.g. `kuml.cliPath`/`kuml.serverUrl`
            // changed) happened while this render was in flight: it was
            // produced with the old config and must not silently repopulate
            // the fresh cache — see the `clear()` doc comment.
            if (generationAtStart === this.generation) {
                this.results.set(key, outcome);
                if (outcome.kind === 'svg' && outcome.intrinsic) {
                    this.sizes.set(key, outcome.intrinsic);
                }
            }
            return outcome;
        } finally {
            this.releaseSlot();
            this.pending.delete(key);
            const listeners = this.listeners.get(key);
            this.listeners.delete(key);
            listeners?.forEach((fn) => fn());
        }
    }

    private acquireSlot(): Promise<void> {
        if (this.running < MAX_CONCURRENT_RENDERS) {
            this.running++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(() => {
                this.running++;
                resolve();
            });
        });
    }

    private releaseSlot(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) {
            next();
        }
    }

    /**
     * Clears cached results/sizes and bumps the generation counter so that
     * any render still in flight from before this call (started under
     * whatever `kuml.cliPath`/`kuml.serverUrl` was active at the time) will
     * discard its result instead of writing it into the fresh cache once it
     * completes (see `runQueued`).
     *
     * Deliberately NOT clearing `pending`/`queue`/`listeners` — in-flight
     * renders keep running and their callers are still owed an `onSettled`
     * callback; abandoning them would leak the underlying CLI/HTTP call with
     * no observer.
     */
    clear(): void {
        this.results.clear();
        this.sizes.clear();
        this.generation++;
    }
}

/** Module singleton — one shared cache across all Markdown/AsciiDoc documents. */
export const renderCache = new RenderCache();
