# Change Log

All notable changes to the kUML VS Code extension are documented in this file.

## [0.4.0] — 2026-08-25

### Added
- **Live kUML diagrams embedded in Markdown and AsciiDoc previews.** A
  ` ```kuml ` fenced code block now renders as a live diagram in VS Code's
  built-in Markdown preview; a `[source,kuml]` listing block or a
  `kuml::path[]` block macro does the same in the AsciiDoc preview (requires
  [asciidoctor.asciidoctor-vscode](https://marketplace.visualstudio.com/items?itemName=asciidoctor.asciidoctor-vscode)
  ≥ 4.0.0). See the README's new "Diagrams in Markdown and AsciiDoc" section.
- Three new settings: `kuml.embed.markdown.enable`, `kuml.embed.asciidoc.enable`
  (both default `true`), `kuml.embed.allowPathsOutsideWorkspace` (default `false`).
- Diagrams are rendered off a shared, size-capped LRU cache (50 entries,
  matching the JetBrains plugin's `KumlDocPreviewCache`) with at most 2
  concurrent renders; a document with more than 20 kUML blocks shows a budget
  notice for the rest instead of rendering all of them.
- Embedded diagrams do not render in restricted (untrusted) workspaces — a
  notice explains why (kUML compiles and executes Kotlin script), and
  rendering resumes automatically once the workspace is trusted.

### Changed
- **`kuml.cliPath`, `kuml.lspPath`, and `kuml.serverUrl` are now
  `"scope": "machine"`** — a workspace's own `.vscode/settings.json` can no
  longer override them. See Security below for why.
- `src/cli.ts`'s `spawnCli`/`spawnCliCapture` gained a timeout (30s default,
  SIGTERM then SIGKILL after a 2s grace period), `AbortSignal` support, and
  stdout/stderr byte caps. Both existing call sites (`kuml.renderToSvg`, the
  live-preview panel) keep working unchanged; the new caps only matter for
  the embed processors and pathologically slow/verbose CLI runs.
- The live-preview panel's render logic (dual `kuml.serverUrl` HTTP / CLI
  strategy) was extracted into `src/render/kumlRenderer.ts` so the Markdown
  and AsciiDoc embed processors share it instead of re-implementing it. Also
  fixed a real resource leak while extracting it: the CLI-fallback path now
  always cleans up its temp directory (`fs.promises.rm` in a `finally`) —
  previously it never was.

### Security
- **`kuml.cliPath` / `kuml.lspPath` / `kuml.serverUrl` are machine-scoped**
  (see Changed above). Before this release, a cloned repository's own
  `.vscode/settings.json` could silently redirect what command the extension
  executes, or what HTTP endpoint it renders through — low-severity while
  rendering required an explicit user action (opening a `.kuml.kts` file and
  running a command), but embedded Markdown/AsciiDoc rendering now means a
  repository can trigger a render just by having its README previewed, so a
  workspace-writable command path became an actual code-execution /
  SSRF-adjacent risk. If you relied on a workspace-level override for these
  three settings, set them at the User/machine level instead.
- **Path-traversal guard for `kuml::path[]`** (`src/embed/pathGuard.ts`, a
  TypeScript port of `KumlAsciidocPathGuard.kt` with two hardenings beyond
  it): only a `.kuml.kts` target extension is accepted; containment is
  re-checked against the realpath (symlink-resolved) target, not just the
  lexical one, so a symlink planted inside an allowed directory can't point
  back outside it; containment uses `path.relative`, never a naked string
  prefix check (which would wrongly treat `/repo-evil/x` as "inside" `/repo`).
- The HTTP render path (`kuml.serverUrl`) now has a 15s timeout and a
  50 MiB response cap (checked against `content-length` and, since that
  header can be absent or wrong, against the actual decoded size too).
- Every user-controlled string that ends up in the Markdown/AsciiDoc preview
  HTML (diagram name, theme, error text, CLI stderr tail) is escaped. This
  matters more than it would elsewhere: VS Code's built-in Markdown preview
  runs with `html: true` and **no output sanitizer of its own** — the
  existing `sanitizeSvg` (previously commented as "defense in depth") is
  therefore the *only* defense against a malicious SVG in these two preview
  surfaces, not an extra layer on top of something else. The comment on
  `svgSanitize.ts` was corrected to say so explicitly.
- `mode: 'load'` in the AsciiDoc processor (fires on every diagnostics pass,
  i.e. potentially every keystroke, even with no preview open) never renders
  — only ever a placeholder — so opening/editing an AsciiDoc file can't spawn
  a `kuml` CLI process per keystroke.

### Fixed
- **Lazy language-server startup.** Activating this extension previously
  always started the `kuml-lsp` JVM. Because the new Markdown/AsciiDoc embed
  hooks mean this extension can now activate from opening *any* Markdown or
  AsciiDoc file (VS Code collects `markdown.markdownItPlugins` /
  `asciidoc.asciidoctorExtensions` contributors from every installed
  extension), that would have meant a JVM process launching for users who
  have never touched kUML. The LSP client now only starts once an actual
  `*.kuml.kts` document is open.
- **HTML injection via a disabled `kuml::path[]` macro's passthrough text**
  (`src/embed/asciidoc.ts`). With `kuml.embed.asciidoc.enable: false` (or the
  `unknown-document` gate reason), the macro's raw target text was re-emitted
  as literal document text through a `pass` block with Asciidoctor's own
  `specialcharacters` substitution disabled and without being escaped by us
  — an attacker-controlled target such as `kuml::<img src=x onerror=...>...[]`
  landed unescaped in the AsciiDoc preview HTML. The target is now escaped
  before being re-emitted.
- **Positional AsciiDoc attributes (`kuml::name[]`'s bare `name`, or
  `[source,kuml,name,svg]`) were silently ignored.** `parseAsciidocAttributes`
  read them off `attrs['1']`/`attrs['2']`, but a real `@asciidoctor/core`
  conversion hands positional attributes as an array under `$positional`
  instead — verified directly against the library. The name always fell back
  to the file's basename or the literal string `"diagram"`.
- **An empty ` ```kuml ``` `/`[source,kuml]` block showed the pulsing
  "rendering…" placeholder forever** instead of a static notice, because the
  `{ kind: 'empty' }` render outcome was mapped to the same placeholder used
  for genuinely in-flight renders.
- **A cached diagram past the per-document render budget (20 blocks) could be
  wrongly replaced by the budget notice**, because the budget counter was
  incremented for every kUML block encountered — including cache hits, which
  cost nothing to display — rather than only for blocks that actually
  triggered new render work. This also fixed an export-only ordering bug: the
  export pre-render pass walks blocks in true document order, but the live
  AsciiDoc conversion processes all block macros before any listing block, so
  the two could disagree about which block was "past the budget."
- **`RenderCache.request()`'s `onSettled` callback was dropped for every
  caller after the first** when two previews (e.g. a `.md` and an `.adoc`
  file) requested the same still-in-flight diagram — only the first caller's
  preview got told to refresh once the render finished.
- **A render already in flight when `kuml.cliPath`/`kuml.serverUrl` changed
  could repopulate the freshly cleared cache with a result produced under the
  old configuration.** `RenderCache` now tracks a generation counter bumped
  by `clear()`; a render whose generation is stale when it settles is
  discarded instead of being cached.
- **A document reaching a kUML block only through a `tag=`/`tags=`/`lines=`-
  restricted `include::` directive showed a "more than 20 diagrams" budget
  notice for as few as a single diagram**, instead of the honest "not
  pre-rendered before export" error every other unresolvable-scan case
  already produced. The export pre-render pass correctly leaves such
  restricted includes unexpanded (see the include-over-render fix above), so
  the block's cache key was never in `attemptedKeys` — indistinguishable, to
  the classifier, from a genuine `BLOCK_BUDGET` overflow. The include-
  expansion pass now reports whether it had to leave anything unresolved, so
  the classifier only blames the budget when the scan actually saw every
  block in the document.
- **`AbortSignal.any`, used to combine a caller's abort signal with the HTTP
  render timeout, is not available on this extension's declared minimum host**
  (`engines.vscode: ^1.85.0` → Electron 25 / Node 18.15; `AbortSignal.any`
  landed in Node 20.3). Replaced with a manual combinator that works on the
  declared minimum.

### Notes — Gate 0 AsciiDoc smoke-test results
Before implementing AsciiDoc support, the riskiest assumptions were verified
directly against `@asciidoctor/core` (the library `asciidoctor-vscode` bundles)
in plain Node, since spinning up a full Extension Development Host session
wasn't available in the environment this change was authored in:

| # | Check | Result |
|---|---|---|
| S1 | `registry.treeProcessor` / `registry.block` / `registry.blockMacro` are functions | 🟢 confirmed directly |
| S3 | `process()` callbacks must be synchronous | 🟢 confirmed — a Promise-returning callback doesn't degrade gracefully, it hard-throws (`lhs.$!= is not a function`) |
| S4 | A `pass` block (`{ subs: [] }`) inlines raw HTML/SVG completely unescaped | 🟢 confirmed directly |
| S2, S5, S6, S7 | `context.mode`/`documentUri` per call site, `previewStyles` loading, `asciidoc.preview.refresh` behavior, and Restricted Mode behavior of `asciidoctor-vscode` itself | ⚪ not independently live-verified in an Extension Development Host — relied on `asciidoctor-vscode` 4.2.2's own source (three distinct call sites passing three distinct `mode` strings; a documented, contributed `previewStyles` mechanism and `asciidoc.preview.refresh` command). Our own trust gate does not depend on `asciidoctor-vscode`'s Restricted Mode behavior — it enforces `vscode.workspace.isTrusted` independently, so S7 failing upstream would not itself be a security gap here. **Recommendation:** do a manual F5 Extension-Development-Host smoke pass against a real asciidoctor-vscode ≥ 4.0.0 install before the next release tag, confirming S2/S5/S6 behave as documented.

None of S1/S2/S4 (the abort criteria) came back red, so AsciiDoc support
shipped in this release rather than being descoped behind
`kuml.embed.asciidoc.enable: false`.

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
