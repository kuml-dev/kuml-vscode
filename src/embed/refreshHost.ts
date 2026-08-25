import * as vscode from 'vscode';
import { createRefreshScheduler } from './refresh';
import type { PreviewKind } from './gate';

/**
 * `vscode`-aware wiring around `RefreshScheduler` (see `refresh.ts` for why
 * the debounce/throttle logic and this host shell live in separate files).
 *
 * `markdown.preview.refresh` / `asciidoc.preview.refresh` take no argument
 * and refresh every open preview of their kind (verified against the
 * built-in Markdown preview and asciidoctor-vscode 4.2.2's source) — so there
 * is no per-document targeting to do here, just a debounced+throttled kick.
 */

const COMMAND: Record<PreviewKind, string> = {
    markdown: 'markdown.preview.refresh',
    asciidoc: 'asciidoc.preview.refresh',
};

const scheduler = createRefreshScheduler({
    execute: (kind) => {
        void vscode.commands.executeCommand(COMMAND[kind]);
    },
});

export function scheduleRefresh(kind: PreviewKind): void {
    scheduler.schedule(kind);
}

export function disposeRefresh(): void {
    scheduler.dispose();
}
