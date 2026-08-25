import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type MarkdownIt from 'markdown-it';
import type { Extensions } from '@asciidoctor/core';
import { LanguageClient } from 'vscode-languageclient/node';
import { createClient, startClient, stopClient } from './lspClient';
import { KumlPreviewPanel } from './previewPanel';
import { spawnCli } from './cli';
import { renderKuml } from './render/kumlRenderer';
import { renderCache } from './render/renderCache';
import { evaluateGate } from './embed/gateHost';
import { scheduleRefresh, disposeRefresh } from './embed/refreshHost';
import { createMarkdownItPlugin, type MarkdownItDeps } from './embed/markdownIt';
import { createAsciidoctorRegistrar, type AsciidocDeps, type AsciidoctorExtensionContext } from './embed/asciidoc';

/**
 * VS Code extension entry point for kUML.
 *
 * Activation contract:
 *  - The extension activates on `onLanguage:kuml` (opening a `*.kuml.kts`
 *    file) — that remains unchanged (see Stolperfalle F2 in the v0.4.0 plan:
 *    do NOT add `onLanguage:markdown` here).
 *  - BUT: `activate()` is now also invoked whenever VS Code's built-in
 *    Markdown preview or asciidoctor-vscode collect
 *    `markdown.markdownItPlugins` / `asciidoc.asciidoctorExtensions`
 *    contributors — i.e. potentially on opening ANY Markdown/AsciiDoc file,
 *    regardless of whether a `*.kuml.kts` file was ever opened. The LSP
 *    client (a JVM process) must NOT start in that case — see
 *    `ensureLspStarted` below, the single most important change in this
 *    release (Stolperfalle F1).
 *  - Runtime commands: `kuml.renderToSvg`, `kuml.showPreview`,
 *    `kuml.exportPng`, `kuml.restartServer` — unchanged.
 *  - The exported `extendMarkdownIt` / `registerAsciidoctorExtensions`
 *    functions are how VS Code's Markdown preview and asciidoctor-vscode
 *    (>= 4.0.0) pick up live kUML diagram rendering.
 */

let client: LanguageClient | undefined;
let lspStarted = false;

export interface KumlExtensionApi {
    extendMarkdownIt(md: MarkdownIt): MarkdownIt;
    registerAsciidoctorExtensions(registry: Extensions.Registry, context: AsciidoctorExtensionContext): Promise<void>;
}

// IMPORTANT: VS Code's built-in Markdown extension reads `extendMarkdownIt`
// directly off this module's exports (`module.exports.extendMarkdownIt`)
// AFTER awaiting `activate()`, not off `activate()`'s return value — verified
// against the built-in `markdown-language-features` extension's source
// (`M.activate().then(() => M.exports?.extendMarkdownIt ? ... )`). Same
// pattern for asciidoctor-vscode's `registerAsciidoctorExtensions`. These two
// MUST therefore be plain top-level exports, built from the real `vscode`-
// backed dependencies at module load time — not something `activate()`
// assembles and returns.
const markdownDeps: MarkdownItDeps = {
    evaluateGate: (uri) => evaluateGate('markdown', uri as vscode.Uri | undefined),
    scheduleRefresh: () => scheduleRefresh('markdown'),
    cache: renderCache,
    render: renderKuml,
};

const asciidocDeps: AsciidocDeps = {
    evaluateGate: (uri) => evaluateGate('asciidoc', uri as vscode.Uri | undefined),
    scheduleRefresh: () => scheduleRefresh('asciidoc'),
    cache: renderCache,
    render: renderKuml,
    readDocumentText: async (uri) => readDocumentTextLive(uri as vscode.Uri),
};

export const extendMarkdownIt = createMarkdownItPlugin(markdownDeps);
export const registerAsciidoctorExtensions = createAsciidoctorRegistrar(asciidocDeps);

export async function activate(context: vscode.ExtensionContext): Promise<KumlExtensionApi> {
    // Lazy LSP: only start the kuml-lsp JVM if a kUML document is already
    // open at activation time, or gets opened later. Activating this
    // extension no longer implies "the user is working with kUML" — it also
    // happens for anyone with a Markdown or AsciiDoc file open (F1).
    if (vscode.workspace.textDocuments.some((d) => d.languageId === 'kuml')) {
        ensureLspStarted(context);
    }
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.languageId === 'kuml') {
                ensureLspStarted(context);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kuml.renderToSvg', () => renderActiveDocument()),
        vscode.commands.registerCommand('kuml.showPreview', () => KumlPreviewPanel.show(context)),
        vscode.commands.registerCommand('kuml.exportPng', () => renderActiveDocument('png')),
        vscode.commands.registerCommand('kuml.restartServer', () => restartServer(context)),
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            void KumlPreviewPanel.renderIfOpen(doc);
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                void KumlPreviewPanel.renderIfOpen(editor.document);
            }
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            renderCache.clear();
            scheduleRefresh('markdown');
            scheduleRefresh('asciidoc');
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration('kuml.theme') ||
                e.affectsConfiguration('kuml.cliPath') ||
                e.affectsConfiguration('kuml.serverUrl') ||
                e.affectsConfiguration('kuml.embed')
            ) {
                renderCache.clear();
                scheduleRefresh('markdown');
                scheduleRefresh('asciidoc');
            }
        }),
    );

    return { extendMarkdownIt, registerAsciidoctorExtensions };
}

export async function deactivate(): Promise<void> {
    disposeRefresh();
    KumlPreviewPanel.disposeAll();
    await stopClient(client);
}

/**
 * Reads a document's live (possibly-dirty) text for the AsciiDoc export
 * pre-render pass. Checks already-open `TextDocument`s first — an unsaved
 * buffer must win over the on-disk copy (Stolperfalle F11) — falling back to
 * `workspace.fs.readFile` for a document that isn't open in any editor.
 */
async function readDocumentTextLive(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
        return open.getText();
    }
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return undefined;
    }
}

/** Idempotent: starts the LSP client at most once per extension host lifetime. */
function ensureLspStarted(context: vscode.ExtensionContext): void {
    if (lspStarted) {
        return;
    }
    lspStarted = true;
    client = createClient(context);
    void startClient(client);
    context.subscriptions.push({ dispose: () => void stopClient(client) });
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
    await stopClient(client);
    lspStarted = true;
    client = createClient(context);
    await startClient(client);
    await vscode.window.showInformationMessage('kUML language server restarted.');
}

/**
 * Renders the active editor's kUML script via the `kuml` CLI.
 *  - `format === 'svg'`: delegate to the live-preview panel (replaces the old
 *    open-in-tab flow).
 *  - `format === 'png'`: keep the original temp-file spawn + OS-viewer open.
 *
 * @param forcedFormat When set, overrides the `kuml.format` setting — used by
 *   the dedicated `kuml.exportPng` command so it always exports PNG
 *   regardless of the configured default format.
 */
async function renderActiveDocument(forcedFormat?: 'svg' | 'png'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kuml') {
        await vscode.window.showWarningMessage('Open a *.kuml.kts file before running this command.');
        return;
    }

    const config = vscode.workspace.getConfiguration('kuml');
    const format = forcedFormat ?? config.get<string>('format', 'svg');

    if (format === 'svg') {
        await vscode.commands.executeCommand('kuml.showPreview');
        return;
    }

    const cliPath = config.get<string>('cliPath', 'kuml');
    const theme = config.get<string>('theme', 'kuml');

    const sourceUri = editor.document.uri;
    const sourceName = path.basename(sourceUri.fsPath, '.kuml.kts');
    const baseName = sourceName || 'diagram';

    // Always write a snapshot to a temp file — this works even for dirty
    // buffers (unsaved changes) and for untitled documents.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-vscode-'));
    const tmpSource = path.join(tmpDir, `${baseName}.kuml.kts`);
    const tmpOutput = path.join(tmpDir, `${baseName}.${format}`);
    fs.writeFileSync(tmpSource, editor.document.getText(), { encoding: 'utf8' });

    const args = ['render', '--theme', theme, '--format', format, '--output', tmpOutput, tmpSource];

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `kUML: rendering ${baseName}.${format}…`,
            cancellable: false,
        },
        async () => {
            try {
                await spawnCli(cliPath, args);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                await vscode.window.showErrorMessage(`kUML render failed: ${message}`);
                return;
            }

            if (!fs.existsSync(tmpOutput)) {
                await vscode.window.showErrorMessage(`kUML render produced no output at ${tmpOutput}.`);
                return;
            }

            // PNG → hand off to OS viewer.
            await vscode.env.openExternal(vscode.Uri.file(tmpOutput));
        },
    );
}
