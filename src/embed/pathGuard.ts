import * as fs from 'fs';
import * as path from 'path';

/**
 * Path-traversal guard for the `kuml::path[]` AsciiDoc block macro. Port of
 * the JetBrains plugin's `KumlAsciidocPathGuard.kt`, with two deliberate
 * hardenings beyond that guard:
 *  - only a `.kuml.kts` target extension is accepted (the JetBrains guard
 *    accepts anything readable, which lets a macro exfiltrate an arbitrary
 *    file's contents into a Kotlin-compiler error message);
 *  - containment is re-checked against the *resolved* (symlink-following)
 *    path, not just the lexical one, so a symlink planted inside an allowed
 *    directory can't point an attacker-controlled path back outside it.
 *
 * `path.resolve`/`path.relative` are always native-OS-aware (Windows drive
 * letters and UNC paths are absolute under `path.win32`, which is what `path`
 * aliases to when running on Windows), so no separate Windows-specific
 * absolute-path detection is needed here — the containment check below is
 * what actually enforces the boundary, on every OS.
 *
 * No `vscode` import here — kept pure so it's unit-testable in plain Node,
 * including with real symlinks under `os.tmpdir()`.
 */

export type PathGuardResult = { ok: true; resolved: string } | { ok: false; reason: string };

export interface PathGuardInput {
    target: string; // raw macro target, e.g. 'diagrams/login.kuml.kts'
    documentDir: string; // absolute dir of the .adoc
    workspaceRoot?: string; // absolute workspace folder of the .adoc, if any
    allowOutsideWorkspace: boolean; // kuml.embed.allowPathsOutsideWorkspace
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** True if `candidate` is inside (or equal to) `base`, using `path.relative` — never a naked string prefix check. */
function isContained(base: string, candidate: string): boolean {
    const rel = path.relative(base, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves symlinks for containment purposes. `p` itself very often does not
 * exist yet (a `kuml::[]` target is usually a `.kuml.kts` file that hasn't
 * been rendered from, and `base` — the workspace root — always exists), so
 * this walks up to the nearest existing ancestor, resolves *that* through
 * `realpath`, and rejoins the non-existent remainder lexically.
 *
 * Resolving only the full path and falling back to the lexical path on
 * ENOENT (a naive `realpathSync` + catch) is NOT equivalent: if `base` exists
 * and gets resolved through a symlink (e.g. macOS's `/tmp` -> `/private/tmp`)
 * but a non-existent `candidate` under it does not, the two ends up on
 * different sides of that symlink and containment fails for a perfectly
 * legitimate path. Walking up to a shared existing ancestor keeps both sides
 * consistent regardless of which of them (if either) exists on disk.
 */
function realOrNearestExisting(p: string): string {
    let dir = path.resolve(p);
    const trailing: string[] = [];
    // MAX_WALK_UP_DEPTH-style bound: a filesystem root is reached in well
    // under 64 hops on any real path.
    for (let i = 0; i < 64; i++) {
        try {
            const real = fs.realpathSync.native(dir);
            return trailing.length > 0 ? path.join(real, ...trailing.reverse()) : real;
        } catch {
            const parent = path.dirname(dir);
            if (parent === dir) {
                // Reached the filesystem root without finding anything that
                // exists — give up and return the original, lexical path.
                return p;
            }
            trailing.push(path.basename(dir));
            dir = parent;
        }
    }
    return p;
}

export function resolveEmbeddedPath(input: PathGuardInput): PathGuardResult {
    const target = input.target.trim();

    if (target.length === 0) {
        return { ok: false, reason: 'empty kuml::[] macro target' };
    }
    if (URL_SCHEME.test(target)) {
        return { ok: false, reason: `kuml::[] target must be a local file path, not a URL: "${target}"` };
    }
    if (!target.endsWith('.kuml.kts')) {
        return { ok: false, reason: `kuml::[] target must end in ".kuml.kts": "${target}"` };
    }

    // Absolute paths are not rejected outright — `path.resolve(documentDir, target)`
    // returns them unchanged, and the containment check below still catches
    // anything actually outside `base` (when a containment boundary applies at all).
    const resolved = path.normalize(path.resolve(input.documentDir, target));

    if (input.allowOutsideWorkspace) {
        // `kuml.embed.allowPathsOutsideWorkspace` exists specifically so a
        // document CAN reference a kUML script outside its own workspace
        // folder — enforcing a boundary here when the setting is ON, let
        // alone a NARROWER one (`documentDir`, which nests inside
        // `workspaceRoot`) than the disabled case uses, is backwards: turning
        // the setting on to reach a path genuinely outside the workspace
        // used to also break every sibling reference elsewhere in the SAME
        // workspace the document previously resolved fine (2026-08 review
        // finding). With the flag on there is no containment boundary here
        // beyond the checks already applied above (URL scheme, `.kuml.kts`
        // extension whitelist).
        return { ok: true, resolved };
    }

    const base = input.workspaceRoot ?? input.documentDir;
    const realBase = realOrNearestExisting(path.resolve(base));
    const realResolved = realOrNearestExisting(resolved);

    if (!isContained(realBase, realResolved)) {
        return {
            ok: false,
            reason: `kuml::[] target "${target}" resolves outside the allowed directory (${base})`,
        };
    }

    return { ok: true, resolved };
}

export interface IncludeGuardInput {
    target: string; // raw include:: directive target, e.g. 'chapters/intro.adoc'
    documentDir: string; // absolute dir of the document doing the including
    workspaceRoot?: string; // absolute workspace folder of the document, if any
    allowOutsideWorkspace: boolean; // kuml.embed.allowPathsOutsideWorkspace
}

/**
 * Path-traversal guard for AsciiDoc `include::target[]` directives, used by
 * the export pre-render pass (`preRenderForExport` in `asciidoc.ts`) so it
 * can follow includes the way Asciidoctor's real converter does (2026-08
 * review finding — without this, a kUML block reachable only via `include::`
 * was invisible to the pre-render pass and hit a guaranteed cache miss during
 * export, even though the live preview renders it fine).
 *
 * Same containment guarantee as `resolveEmbeddedPath` above (symlink-aware,
 * `path.relative`-based, never a naked string-prefix check) but WITHOUT its
 * `.kuml.kts`-only extension whitelist — an `include::` target is an ordinary
 * AsciiDoc/text source file (`.adoc`, `.txt`, a partial, …), not a kUML
 * script, so there is no fixed extension to demand.
 */
export function resolveIncludeTarget(input: IncludeGuardInput): PathGuardResult {
    const target = input.target.trim();

    if (target.length === 0) {
        return { ok: false, reason: 'empty include:: target' };
    }
    if (URL_SCHEME.test(target)) {
        return { ok: false, reason: `include:: target must be a local file path, not a URL: "${target}"` };
    }

    const resolved = path.normalize(path.resolve(input.documentDir, target));

    if (input.allowOutsideWorkspace) {
        // Same fix, same reasoning as `resolveEmbeddedPath` above (2026-08
        // review finding): the flag exists to WIDEN what's reachable, so it
        // must never narrow the boundary to `documentDir` — with it on,
        // there is no containment boundary here at all.
        return { ok: true, resolved };
    }

    const base = input.workspaceRoot ?? input.documentDir;
    const realBase = realOrNearestExisting(path.resolve(base));
    const realResolved = realOrNearestExisting(resolved);

    if (!isContained(realBase, realResolved)) {
        return {
            ok: false,
            reason: `include:: target "${target}" resolves outside the allowed directory (${base})`,
        };
    }

    return { ok: true, resolved };
}
