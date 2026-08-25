import * as vscode from 'vscode';
import { decideGate, type EmbedConfig, type GateResult, type PreviewKind } from './gate';

/**
 * `vscode`-aware wrapper around `decideGate` (see `gate.ts` for why the pure
 * logic and this host shell live in separate files).
 */

function readEmbedConfig(): EmbedConfig {
    const config = vscode.workspace.getConfiguration('kuml');
    return {
        cliPath: config.get<string>('cliPath', 'kuml'),
        serverUrl: config.get<string>('serverUrl', '').trim(),
        defaultTheme: config.get<string>('theme', 'kuml'),
        allowPathsOutsideWorkspace: config.get<boolean>('embed.allowPathsOutsideWorkspace', false),
    };
}

export function evaluateGate(kind: PreviewKind, documentUri: vscode.Uri | undefined): GateResult {
    const enabledKey = kind === 'markdown' ? 'embed.markdown.enable' : 'embed.asciidoc.enable';
    const config = vscode.workspace.getConfiguration('kuml');
    const enabled = config.get<boolean>(enabledKey, true);

    const isSupportedScheme = documentUri?.scheme === 'file' || documentUri?.scheme === 'untitled';
    const workspaceFolder = documentUri ? vscode.workspace.getWorkspaceFolder(documentUri) : undefined;

    return decideGate({
        enabled,
        isTrusted: vscode.workspace.isTrusted,
        documentPath: documentUri?.fsPath,
        isSupportedScheme,
        config: readEmbedConfig(),
        workspaceRoot: workspaceFolder?.uri.fsPath,
    });
}
