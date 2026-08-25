# Change Log

All notable changes to the kUML VS Code extension are documented in this file.

## [0.3.4] — 2026-08-25

Marketplace listing only — no code changes.

### Added
- **README screenshots**: five side-by-side source/live-preview screenshots
  (class, sequence, state, activity, deployment diagrams) so the Marketplace
  listing shows the extension in action instead of describing it in text
  alone. Images are hosted via `raw.githubusercontent.com` and excluded from
  the packaged VSIX (`.vscodeignore`) to keep it lean.

## [0.3.3] — 2026-08-01

Dependency security bumps — no user-facing functional changes.

### Security
- GitHub flagged 5 high-severity Dependabot alerts on `master` after the 0.3.2 push
  (`js-yaml`, `fast-uri` ×2, `linkify-it`, `brace-expansion`). All five were transitive
  dependencies of `@vscode/vsce` (the packaging CLI, a devDependency) — none reach the
  packaged VSIX. While tracing the `brace-expansion` chain, found a *separate*,
  previously unflagged advisory
  ([GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), DoS via
  unbounded expansion length) affecting `brace-expansion@2.1.2` under
  `vscode-languageclient`'s own `minimatch` — `vscode-languageclient` **is** a
  production dependency, so this instance does ship in the packaged extension. Also
  picked up two more `npm audit` findings not in the original Dependabot batch
  (`form-data`, `undici`), both dev-only via `@vscode/vsce`.
  Added scoped `overrides` in `package.json` pinning each to the first patched version
  satisfying its parent's declared semver range: `js-yaml@^4.3.0`, `fast-uri@^3.1.4`,
  `linkify-it@^5.0.2`, `form-data@^4.0.6`, `undici@^7.28.0`, and two path-scoped
  `brace-expansion` overrides (`^5.0.7` under `@vscode/vsce`'s `minimatch`, `^2.1.3`
  under `vscode-languageclient`'s `minimatch`, so the two unrelated major-version
  lineages aren't collapsed into one). `npm audit` now reports 0 vulnerabilities;
  `npm test` still 25/25 green.

## [0.3.2] — 2026-08-01

Marketplace listing icon and a test-isolation fix — no user-facing functional changes.

### Fixed
- Two `src/test/lspClient.test.ts` cases (local Gradle installDist walk-up,
  bare-launcher-name fallback) failed on any machine with a real `kuml-lsp`
  installed — they assumed it was installed nowhere, so `resolveLspLauncher`'s
  PATH probe and hardcoded common-install-location probe resolved first and the
  code paths under test were never reached. `LspLauncherConfig` gained an
  optional, test-only `probeSystem` flag (default `true`) that skips those two
  probe steps; the tests now pass `probeSystem: false`. Production resolution
  order and behavior are unchanged — the sole production caller never sets it —
  and a new test asserts the default still probes PATH.
- The Marketplace listing showed a generic "kU" script glyph instead of the
  kUML brand logo. `icons/kuml-marketplace.png` had been rasterized from
  `icons/kuml-script-dark.svg` — the 16×16 file-type icon meant solely for
  `contributes.languages[0].icon` — and that small monogram was reused for
  the large listing image by mistake back in 0.2.0. It is now generated from
  the real brand mark (navy #1d2b4f + gold #c49a2e "kUML" wordmark), vendored
  into this repo as `icons/kuml-brand-logo.svg` from the JetBrains plugin's
  `META-INF/pluginIcon.svg`, and rasterized to 256×256 (was 128×128) for a
  crisper Marketplace thumbnail. The `package.json` `"icon"` path was always
  correct and is unchanged; the misleading `_comment_icon` note that pointed
  at the script icon as the source has been corrected so the next regeneration
  cannot repeat the mistake. `icons/kuml-script-{light,dark}.svg` are untouched
  and remain the file-type icons.

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
