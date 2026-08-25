# kuml-vscode — Repo Context

VS Code extension for kUML (`*.kuml.kts`): syntax highlighting, snippets, LSP
diagnostics/completion, live-preview rendering, and (since v0.4.0) live
diagram embedding in the built-in Markdown preview and the AsciiDoc preview
(`asciidoctor.asciidoctor-vscode` ≥ 4.0.0).

This file exists so a future agent working in this repo finds the repo-wide
conventions here rather than having to reconstruct them from the vault's
`CLAUDE.md`. The authoritative, repo-family-spanning versions of these rules
live in the Obsidian vault's `CLAUDE.md` (kUML-Repo-Konventionen section) —
if the two ever disagree, the vault is the source of truth and this file
should be corrected to match it, not the other way around.

## Branch and release workflow

- Default branch is **`master`**, never `main`.
- Never develop directly on `master`. Every change (feature, fix, refactor)
  gets a local feature branch (`feature/<...>`, `fix/<...>`), with as many
  small WIP commits as needed.
- Feature branches stay **local** — never pushed to `origin`.
- When a change is ready: `git merge --squash <branch>` onto `master`, one
  commit with a message describing the whole change, then delete the local
  branch. No GitHub PR / "squash and merge" — the squash happens locally
  before any push.
- Tag releases as `vX.Y.Z` (with the `v` prefix — this repo follows the main
  kUML-Core convention, unlike `obsidian-kuml`'s bare `X.Y.Z` tags). Use an
  **annotated** tag (`git tag -a vX.Y.Z -m "..."`) — `git push --follow-tags`
  silently skips lightweight tags.
- Release automation: `.github/workflows/release.yml` triggers on a pushed
  `v*.*.*` tag, builds/tests/packages the extension, publishes to the VS Code
  Marketplace via `vsce publish --pat $VSCE_PAT` (idempotent — skips the
  Marketplace publish if `vsce show` already reports that version), and
  create-or-updates the GitHub release with the VSIX attached. The
  `VSCE_PAT` secret is set up manually, out of band — an agent has no access
  to the token value itself.
- Never `--force` push, never rewrite `master` history, without an explicit
  instruction to do so.

## Build / test — what "green" means here

This is a plain TypeScript/npm project — no Gradle, no ktlint, no separate
lint step.

```bash
npm run compile   # tsc -p .
npm test          # node --test --enable-source-maps out/test/*.test.js
```

Both must run clean before any commit is considered done. There is no
`@vscode/test-electron` integration test (no Extension Development Host test)
— tests either avoid importing `vscode` entirely (see below) or, for the
handful of things that genuinely need a live VS Code host (asciidoctor-vscode
/ built-in Markdown preview wiring), rely on a manual smoke-test pass
documented in the relevant CHANGELOG entry instead.

Before packaging or releasing, also run:

```bash
npx vsce ls      # confirms exactly what ships in the VSIX
npm audit        # must report 0 vulnerabilities
```

## The "no `vscode` import" convention

`vscode` only resolves inside a running Extension Development Host — a
top-level `import 'vscode'` anywhere in a module (even if the import is never
actually used at runtime in a given code path) makes that module un-`require`-able
under plain `node --test`. Every module this repo wants to unit-test directly
therefore keeps `vscode` out of its import graph entirely:

- `svgSanitize.ts`, `lspLocator.ts`, `embed/attributes.ts`,
  `embed/embedHtml.ts`, `embed/pathGuard.ts`, `embed/asciidocScan.ts`,
  `embed/gate.ts`, `embed/refresh.ts`, `embed/markdownIt.ts`,
  `embed/asciidoc.ts`, `render/kumlRenderer.ts`, `render/renderCache.ts` —
  none of these import `vscode`.
- Where real `vscode` API access is unavoidable (reading configuration,
  checking workspace trust, executing a command), the logic is split: a pure
  module holds the decision/rendering logic and takes its `vscode`-shaped
  inputs as plain parameters or an injected `deps` object; a thin,
  deliberately *un*-tested "host" module (`gateHost.ts`, `refreshHost.ts`,
  or the wiring in `extension.ts` itself) is the only place that actually
  imports `vscode` and calls the pure module with real values.
- When adding a new pure module, use `import type` for anything from
  `@asciidoctor/core` or `markdown-it` that's only needed for type
  annotations — a plain `import` would emit a `require()` at the top of the
  compiled file even if the import is a devDependency never meant to ship
  (see the `asciidoc.ts` doc comment / CHANGELOG "Stolperfalle F7" for what
  goes wrong if this slips: `require("@asciidoctor/core")` at the top of
  `out/embed/asciidoc.js` would throw at runtime, since `vsce` prunes
  devDependencies out of the packaged `node_modules`).

## Activation cost discipline

`activationEvents` is `["onLanguage:kuml"]` and should stay that way — do not
add `onLanguage:markdown` / `onLanguage:asciidoc`. VS Code already invokes
this extension's `activate()` (and reads `extendMarkdownIt` /
`registerAsciidoctorExtensions` off `module.exports`) whenever it collects
`markdown.markdownItPlugins` / `asciidoc.asciidoctorExtensions` contributors
— i.e. potentially for *any* Markdown/AsciiDoc file, regardless of whether
the user has ever opened a `*.kuml.kts` file. Anything `activate()` does
unconditionally therefore now runs for users who have never touched kUML.
Concretely: the `kuml-lsp` language server (a JVM process) is started lazily,
only once an actual `*.kuml.kts` document is open or gets opened
(`ensureLspStarted` in `extension.ts`) — never unconditionally in
`activate()`. Keep this invariant when touching `extension.ts`; the
regression check is: open a plain Markdown file in a fresh Extension
Development Host and confirm no `kuml-lsp` process appears.

## Security posture for the embed processors

`kuml render` compiles and executes Kotlin script. Before v0.4.0 that only
ever happened on an explicit user action. Since v0.4.0, a diagram embedded in
someone else's Markdown/AsciiDoc file can render just by the user opening
that file's preview — treat any change to `embed/gate.ts`, `embed/pathGuard.ts`,
or the `kuml.cliPath`/`kuml.lspPath`/`kuml.serverUrl` settings' `scope` as
security-relevant, not routine:

- Restricted (untrusted) workspaces never render embedded diagrams — no
  escape hatch. If that policy ever needs softening, that's a product
  decision to make explicitly, not a refactor side effect.
- `kuml::path[]` targets go through `pathGuard.ts`'s containment check
  (symlink-aware, `.kuml.kts`-extension-locked) before anything reads them.
- `kuml.cliPath` / `kuml.lspPath` / `kuml.serverUrl` are `scope: "machine"` —
  a workspace cannot redirect what command/URL this extension talks to.

## 4-agent pipeline

For any real implementation wave in this repo (new feature, bugfix with real
scope, refactor — not a one-line fix or pure research), follow the standard
kUML-family pipeline documented in the vault's `CLAUDE.md`: Plan → Implement
(own feature branch, real `npm run compile && npm test`, own commit) →
Review loop (max 4 rounds) → Security-audit loop (max 4 rounds) → Commit
(local squash-merge onto `master`, delete the feature branch). No step is
optional, even for small waves.
