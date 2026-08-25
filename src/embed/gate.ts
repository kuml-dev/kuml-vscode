import * as path from 'path';

/**
 * Trust/enablement gate for the Markdown and AsciiDoc embed processors.
 *
 * Pure decision logic only — no `vscode` import (not even type-only), so this
 * file is unit-testable in plain Node without a `vscode` module stub. The
 * `vscode`-aware wrapper that calls `decideGate` lives in `gateHost.ts` and is
 * deliberately kept out of this file, since a top-level `import 'vscode'`
 * anywhere in a module poisons the whole module for `node --test` (the
 * `vscode` package only exists inside a running extension host).
 */

export type PreviewKind = 'markdown' | 'asciidoc';

export interface EmbedConfig {
    cliPath: string;
    serverUrl: string;
    defaultTheme: string;
    allowPathsOutsideWorkspace: boolean;
}

export type GateResult =
    | { allowed: true; config: EmbedConfig; workspaceRoot?: string; documentDir?: string }
    | { allowed: false; reason: 'disabled' | 'untrusted' | 'unknown-document' };

export interface DecideGateInput {
    enabled: boolean;
    isTrusted: boolean;
    /** Absolute fs path of the document, or undefined if it has none (e.g. an in-memory buffer). */
    documentPath: string | undefined;
    /** true for `file`/`untitled` scheme documents; false for anything else (git diff views, etc). */
    isSupportedScheme: boolean;
    config: EmbedConfig;
    workspaceRoot?: string;
}

/** Pure decision function — no `vscode` import, fully unit-testable. */
export function decideGate(input: DecideGateInput): GateResult {
    if (!input.enabled) {
        return { allowed: false, reason: 'disabled' };
    }
    if (!input.isTrusted) {
        return { allowed: false, reason: 'untrusted' };
    }
    if (!input.documentPath || !input.isSupportedScheme) {
        return { allowed: false, reason: 'unknown-document' };
    }

    return {
        allowed: true,
        config: input.config,
        workspaceRoot: input.workspaceRoot,
        documentDir: path.dirname(input.documentPath),
    };
}
