import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnCli } from './cli';
import { sanitizeSvg } from './svgSanitize';

/**
 * Live-preview webview for `*.kuml.kts` documents.
 *
 * Render strategy (dual, in `renderFor`):
 *  1. If `kuml.serverUrl` is set, POST to `{serverUrl}/api/render` (the
 *     `kuml serve` HTTP API — see `kuml-web`'s `RenderRequest`/`RenderResponse`).
 *  2. Otherwise (or on any failure of the above), fall back to shelling out to
 *     the `kuml` CLI, exactly like the existing `kuml.renderToSvg` command.
 *
 * Security posture: the webview has `enableScripts: true` — scripts are
 * needed for the in-panel zoom toolbar (Zoom In/Out/Fit), but the CSP locks
 * `script-src` to a single per-render nonce, so only the inline `<script>`
 * this class generates can run; no remote scripts, no `<img src>`, and no
 * message-passing back to the extension host. The rendered SVG is still
 * static, sanitized markup inlined into the page. `sanitizeSvg` remains
 * defense-in-depth on top of that.
 */
export class KumlPreviewPanel {
    private static current: KumlPreviewPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private disposed = false;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.panel = vscode.window.createWebviewPanel(
            'kuml.preview',
            'kUML Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );
        this.panel.webview.html = this.wrapHtml('<p>Open a *.kuml.kts file and save it to render a preview.</p>');
        this.panel.onDidDispose(() => {
            this.disposed = true;
            if (KumlPreviewPanel.current === this) {
                KumlPreviewPanel.current = undefined;
            }
        });
    }

    /** Create the panel if none exists, otherwise reveal the existing one, then render the active editor. */
    static async show(context: vscode.ExtensionContext): Promise<void> {
        if (!KumlPreviewPanel.current) {
            KumlPreviewPanel.current = new KumlPreviewPanel(context);
        } else {
            KumlPreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside);
        }

        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'kuml') {
            await KumlPreviewPanel.current.renderFor(editor.document);
        }
    }

    /** True if the panel is currently open (used by re-render triggers to skip work otherwise). */
    static isOpen(): boolean {
        return KumlPreviewPanel.current !== undefined && !KumlPreviewPanel.current.disposed;
    }

    static async renderIfOpen(document: vscode.TextDocument): Promise<void> {
        if (document.languageId !== 'kuml') {
            return;
        }
        if (KumlPreviewPanel.isOpen()) {
            await KumlPreviewPanel.current!.renderFor(document);
        }
    }

    static disposeAll(): void {
        KumlPreviewPanel.current?.panel.dispose();
        KumlPreviewPanel.current = undefined;
    }

    async renderFor(document: vscode.TextDocument): Promise<void> {
        const config = vscode.workspace.getConfiguration('kuml');
        const serverUrl = config.get<string>('serverUrl', '').trim();
        const theme = config.get<string>('theme', 'kuml');
        const cliPath = config.get<string>('cliPath', 'kuml');
        const script = document.getText();

        let svg: string | undefined;
        let fallbackNote: string | undefined;

        if (serverUrl) {
            try {
                svg = await this.renderViaServer(serverUrl, script, theme);
            } catch (err: unknown) {
                fallbackNote = err instanceof Error ? err.message : String(err);
            }
        }

        if (!svg) {
            try {
                svg = await this.renderViaCli(cliPath, theme, script, document.uri);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                this.panel.webview.html = this.wrapHtml(this.errorCard(message, fallbackNote));
                return;
            }
        }

        const sanitized = sanitizeSvg(svg);
        const note = fallbackNote
            ? `<p class="kuml-note">kuml.serverUrl render failed, used CLI fallback: ${escapeHtml(fallbackNote)}</p>`
            : '';
        this.panel.webview.html = this.wrapHtml(`${note}<div class="kuml-svg">${sanitized}</div>`);
    }

    private async renderViaServer(serverUrl: string, script: string, theme: string): Promise<string> {
        const url = `${serverUrl.replace(/\/+$/, '')}/api/render`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ script, format: 'svg', theme }),
        });
        if (!res.ok) {
            throw new Error(`kuml serve responded with HTTP ${res.status}`);
        }
        const body = (await res.json()) as { ok: boolean; svg?: string; error?: string };
        if (!body.ok || !body.svg) {
            throw new Error(body.error ?? 'kuml serve render returned ok=false with no error message');
        }
        return body.svg;
    }

    private async renderViaCli(
        cliPath: string,
        theme: string,
        script: string,
        sourceUri: vscode.Uri,
    ): Promise<string> {
        const baseName = path.basename(sourceUri.fsPath, '.kuml.kts') || 'diagram';
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuml-vscode-preview-'));
        const tmpSource = path.join(tmpDir, `${baseName}.kuml.kts`);
        const tmpOutput = path.join(tmpDir, `${baseName}.svg`);
        fs.writeFileSync(tmpSource, script, { encoding: 'utf8' });

        await spawnCli(cliPath, ['render', '--theme', theme, '--format', 'svg', '--output', tmpOutput, tmpSource]);

        if (!fs.existsSync(tmpOutput)) {
            throw new Error(`kuml render produced no output at ${tmpOutput}.`);
        }
        return fs.readFileSync(tmpOutput, { encoding: 'utf8' });
    }

    private errorCard(message: string, fallbackNote: string | undefined): string {
        const note = fallbackNote
            ? `<p class="kuml-note">kuml.serverUrl render also failed: ${escapeHtml(fallbackNote)}</p>`
            : '';
        return `${note}<div class="kuml-error"><p>kUML preview render failed:</p><pre>${escapeHtml(message)}</pre></div>`;
    }

    private wrapHtml(body: string): string {
        const nonce = getNonce();
        const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); margin: 0; padding: 0; display: flex; flex-direction: column; }
  .kuml-toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 2px; padding: 4px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-widget-border, transparent);
  }
  .kuml-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; padding: 0; border: none; border-radius: 3px;
    background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground));
    cursor: pointer;
  }
  .kuml-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2)); }
  .kuml-btn:active { background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.3)); }
  .kuml-btn svg { width: 16px; height: 16px; }
  .kuml-content { flex: 1 1 auto; overflow: auto; padding: 8px; }
  .kuml-zoom-target { transform-origin: top left; width: fit-content; }
  .kuml-svg svg { max-width: 100%; height: auto; }
  .kuml-error pre { white-space: pre-wrap; color: var(--vscode-errorForeground, #f48771); }
  .kuml-note { color: var(--vscode-descriptionForeground, #999); font-size: 0.9em; }
</style>
</head>
<body>
<div class="kuml-toolbar">
  <button id="kuml-zoom-in" class="kuml-btn" title="Zoom In" aria-label="Zoom In">${ICON_ZOOM_IN}</button>
  <button id="kuml-zoom-out" class="kuml-btn" title="Zoom Out" aria-label="Zoom Out">${ICON_ZOOM_OUT}</button>
  <button id="kuml-zoom-fit" class="kuml-btn" title="Zoom Fit" aria-label="Zoom Fit">${ICON_ZOOM_FIT}</button>
</div>
<div class="kuml-content">
  <div class="kuml-zoom-target" id="kuml-zoom-target">
${body}
  </div>
</div>
<script nonce="${nonce}">
(function () {
  const target = document.getElementById('kuml-zoom-target');
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const STEP = 1.2;
  let scale = 1;

  function apply() {
    target.style.transform = 'scale(' + scale + ')';
  }

  document.getElementById('kuml-zoom-in').addEventListener('click', function () {
    scale = Math.min(MAX_SCALE, scale * STEP);
    apply();
  });
  document.getElementById('kuml-zoom-out').addEventListener('click', function () {
    scale = Math.max(MIN_SCALE, scale / STEP);
    apply();
  });
  document.getElementById('kuml-zoom-fit').addEventListener('click', function () {
    scale = 1;
    apply();
  });
})();
</script>
</body>
</html>`;
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Random per-render nonce used to scope the CSP `script-src` to this panel's own inline `<script>`. */
function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// Small stroke-based icon set (codicon-like) drawn as inline SVG so the preview toolbar
// needs no bundled icon font/asset — they inherit color via `currentColor` and thus
// automatically match the active VS Code theme (light/dark/high-contrast).
const ICON_ZOOM_IN =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">' +
    '<circle cx="6.5" cy="6.5" r="4.5" /><line x1="9.8" y1="9.8" x2="14" y2="14" />' +
    '<line x1="6.5" y1="4.2" x2="6.5" y2="8.8" /><line x1="4.2" y1="6.5" x2="8.8" y2="6.5" /></svg>';
const ICON_ZOOM_OUT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">' +
    '<circle cx="6.5" cy="6.5" r="4.5" /><line x1="9.8" y1="9.8" x2="14" y2="14" />' +
    '<line x1="4.2" y1="6.5" x2="8.8" y2="6.5" /></svg>';
const ICON_ZOOM_FIT =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">' +
    '<path d="M1.5 5V1.5H5" /><path d="M11 1.5H14.5V5" /><path d="M14.5 11V14.5H11" /><path d="M5 14.5H1.5V11" /></svg>';
