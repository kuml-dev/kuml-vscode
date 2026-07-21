# Change Log

All notable changes to the kUML VS Code extension are documented in this file.

## [0.3.1] — 2026-07-21

Internal/tooling only — no user-facing changes.

### Changed
- Verifies the new `.github/workflows/release.yml` (added after the v0.3.0
  tag, so it never actually ran) — this release is the first tag pushed
  since the workflow existed on `master`, confirming that a `v*.*.*` tag
  push builds, tests, packages, publishes to the Marketplace via the
  `VSCE_PAT` repo secret, and creates the GitHub Release automatically.

### Fixed
- `src/test/manifest.test.ts` had a hardcoded `assert.equal(version, '0.2.0')`
  left over from the 0.2.0 wave — broke `npm test` on every subsequent
  version bump (silently missed at the 0.3.0 release since the failing test
  scrolled past a truncated terminal check). Replaced with a semver-shape
  assertion that stays valid across releases.

## [0.3.0] — 2026-07-20

Toolbar icons, PNG export, and live-preview zoom controls.

### Added
- New command **kUML: Export to PNG** (`kuml.exportPng`) — always exports PNG
  regardless of the `kuml.format` setting; joins **Open Live Preview** and
  **Render to SVG** as a dedicated editor-title icon button, editor-context
  menu entry, and command-palette entry.
- Live-preview panel gained a **Zoom In / Zoom Out / Zoom Fit** toolbar
  (inline stroke-based SVG icons, no bundled icon font). Zoom is a simple
  CSS `transform: scale(...)` on the rendered SVG (clamped 0.1×–8×, 1.2×
  per step); Zoom Fit resets to the default responsive fit.

### Changed
- The **Open Live Preview**, **Render to SVG**, and **Export to PNG** editor
  commands now render as icon buttons (VS Code's `$(codicon-id)` command
  icon syntax) instead of text labels in the editor title bar.

### Security
- The live-preview webview now runs with `enableScripts: true` (previously
  `false`), required for the new zoom toolbar. The CSP now scopes
  `script-src` to a single per-render nonce (`script-src 'nonce-<random>'`),
  so only the panel's own inline zoom script can execute — no remote scripts,
  no `postMessage`/`acquireVsCodeApi` channel back to the extension host.
  `sanitizeSvg` (unconditionally strips `<script>`, event handler attributes,
  and non-`data:`/non-`#` `href`s from rendered SVG) remains as
  defense-in-depth on top of the CSP, independently of the scripting change.

## [0.2.0] — 2026-07-10

Wave 5: thin LSP client + live-preview webview.

### Added
- LSP client wired to `kuml-lsp` (the `kuml-language-server` module) via
  `vscode-languageclient`: push diagnostics and completion (with resolve) now
  appear directly in the editor for `*.kuml.kts` files, over stdio.
- Launcher discovery for `kuml-lsp` mirrors the `kuml` CLI's resolution order:
  `KUML_LSP` env var → `kuml.lspPath` setting → PATH → Homebrew/common
  locations → local Gradle `installDist` build (walked up from the workspace).
- Command **kUML: Open Live Preview** — a persistent webview panel that
  renders the active `*.kuml.kts` document as sanitized inline SVG, using a
  dual strategy: `kuml.serverUrl` (`kuml serve`'s `/api/render` HTTP endpoint)
  first, falling back to the `kuml` CLI subprocess. Re-renders on save and on
  active-editor change.
- Command **kUML: Restart Language Server**.
- Configuration: `kuml.lspPath`, `kuml.serverUrl`, `kuml.diagnostics.enable`,
  `kuml.diagnostics.debounceMs`.
- 128×128 PNG marketplace icon (`icons/kuml-marketplace.png`), required by
  `vsce` (SVG icons are rejected).

### Notes
- `kuml.renderToSvg` now delegates SVG output to the live-preview panel; PNG
  output still opens in the OS's default viewer.
- The LSP server stays render-agnostic (diagnostics + completion only) — the
  live preview's rendering logic lives entirely in the client.

## [0.1.0] — 2026-06-06

Initial release. V1.1.11 of the kUML toolchain.

### Added
- TextMate grammar (`source.kuml`) covering the kUML DSL on top of Kotlin
  script basics (strings, numbers, comments, types, identifiers).
- File-type registration for `*.kuml.kts` with a custom file icon
  (light + dark variants).
- Snippets: `diagram`, `umlModel`, `classOf`, `interfaceOf`, `enumOf`,
  `c4Model`, `association`, `generalization`, `realization`, `stateMachine`,
  `applyProfile`.
- Command **kUML: Render to SVG** — invokes the `kuml` CLI on the active
  document and opens the resulting SVG/PNG.
- Configuration: `kuml.cliPath`, `kuml.theme`, `kuml.format`.
