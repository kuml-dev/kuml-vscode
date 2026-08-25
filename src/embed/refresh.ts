import type { PreviewKind } from './gate';

/**
 * Debounce + throttle state machine for "please refresh the preview" signals.
 * Pure logic, no `vscode` import — the actual `vscode.commands.executeCommand`
 * call is injected via `RefreshDeps.execute` (real wiring lives in
 * `refreshHost.ts`), so this is unit-testable in plain Node with a fake clock.
 *
 * Rules (see plan Stolperfalle F4):
 *  - 250ms debounce after the last `schedule(kind)` call.
 *  - After that, at most one `execute(kind)` per second, per kind.
 *  - MUST be called only from a cache's `onSettled` callback (pending -> settled
 *    transition) by callers — never unconditionally at the end of every
 *    render — otherwise a warm-cache hit would still trigger a refresh, which
 *    would trigger another render pass, forever. This module does not enforce
 *    that invariant itself (it has no notion of "settled"); it is enforced by
 *    construction in `markdownIt.ts` / `asciidoc.ts`, which only ever call
 *    `scheduleRefresh` from a `RenderCache.request` `onSettled` callback.
 */

const DEBOUNCE_MS = 250;
const MIN_INTERVAL_MS = 1_000;

export interface RefreshDeps {
    execute: (kind: PreviewKind) => void;
}

interface KindState {
    debounceTimer?: ReturnType<typeof setTimeout>;
    throttleTimer?: ReturnType<typeof setTimeout>;
    lastRun: number;
}

export class RefreshScheduler {
    private readonly state = new Map<PreviewKind, KindState>();

    constructor(
        private readonly deps: RefreshDeps,
        private readonly now: () => number = () => Date.now(),
    ) {}

    schedule(kind: PreviewKind): void {
        const s = this.stateFor(kind);
        if (s.debounceTimer) {
            clearTimeout(s.debounceTimer);
        }
        s.debounceTimer = setTimeout(() => this.fire(kind), DEBOUNCE_MS);
    }

    private fire(kind: PreviewKind): void {
        const s = this.stateFor(kind);
        s.debounceTimer = undefined;
        const elapsed = this.now() - s.lastRun;
        if (elapsed >= MIN_INTERVAL_MS) {
            s.lastRun = this.now();
            this.deps.execute(kind);
            return;
        }
        if (!s.throttleTimer) {
            s.throttleTimer = setTimeout(() => {
                s.throttleTimer = undefined;
                s.lastRun = this.now();
                this.deps.execute(kind);
            }, MIN_INTERVAL_MS - elapsed);
        }
    }

    private stateFor(kind: PreviewKind): KindState {
        let s = this.state.get(kind);
        if (!s) {
            s = { lastRun: -Infinity };
            this.state.set(kind, s);
        }
        return s;
    }

    dispose(): void {
        for (const s of this.state.values()) {
            if (s.debounceTimer) {
                clearTimeout(s.debounceTimer);
            }
            if (s.throttleTimer) {
                clearTimeout(s.throttleTimer);
            }
        }
        this.state.clear();
    }
}

export function createRefreshScheduler(deps: RefreshDeps, now?: () => number): RefreshScheduler {
    return new RefreshScheduler(deps, now);
}
