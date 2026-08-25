import * as cp from 'child_process';

/**
 * Shared `kuml` CLI subprocess helpers. Split out of `extension.ts` so both
 * the one-shot `kuml.renderToSvg` command and the live-preview panel's CLI
 * fallback share a single implementation — no drift between the two call
 * sites.
 */

/** How long to wait after SIGTERM before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 2_000;

/** Default hard timeout for a `kuml` CLI invocation, used when the caller doesn't override it. */
export const DEFAULT_CLI_TIMEOUT_MS = 30_000;

export interface SpawnCliOptions {
    /** Hard kill after this many ms (SIGTERM, then SIGKILL after 2s). Default: DEFAULT_CLI_TIMEOUT_MS. */
    timeoutMs?: number;
    /** Abort the child when this signal fires (preview closed, document changed, etc). */
    signal?: AbortSignal;
    /** Cap on captured stdout (spawnCliCapture only). Undefined = uncapped. */
    maxStdoutBytes?: number;
    /** Cap on captured stderr, so a runaway CLI cannot balloon the host. Default: 64 KiB. */
    maxStderrBytes?: number;
}

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

const ENOENT_HINT = ' (is the kUML CLI installed and on PATH? See setting "kuml.cliPath".)';

/**
 * Wires timeout escalation (SIGTERM → SIGKILL) and an optional `AbortSignal`
 * onto a spawned child. Returns a cleanup function the caller MUST invoke
 * exactly once (in a `finally`) to clear the timer and detach the abort
 * listener — otherwise a long-lived `AbortSignal` (e.g. one shared across a
 * whole document's lifetime) would accumulate listeners across every render.
 */
function armTimeoutAndAbort(child: cp.ChildProcess, opts: SpawnCliOptions | undefined): () => void {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            hardTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                }
            }, SIGKILL_GRACE_MS);
        }
    };

    killTimer = setTimeout(kill, timeoutMs);

    const onAbort = () => kill();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    return () => {
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
        opts?.signal?.removeEventListener('abort', onAbort);
    };
}

/**
 * Spawn the `kuml` CLI and resolve once it exits cleanly. Rejects with a
 * trimmed stderr message if the CLI exits non-zero or can't be spawned at all
 * (e.g. CLI not on PATH), on timeout, or on abort.
 */
export function spawnCli(cliPath: string, args: string[], opts?: SpawnCliOptions): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(cliPath, args, { shell: false });
        const maxStderrBytes = opts?.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
        let stderr = '';
        let stderrBytes = 0;
        let settled = false;

        const disarm = armTimeoutAndAbort(child, opts);

        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderrBytes >= maxStderrBytes) {
                return;
            }
            stderrBytes += chunk.length;
            stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
            if (settled) {
                return;
            }
            settled = true;
            disarm();
            const hint = err.message.includes('ENOENT') ? ENOENT_HINT : '';
            reject(new Error(err.message + hint));
        });
        child.on('exit', (code, signal) => {
            if (settled) {
                return;
            }
            settled = true;
            disarm();
            if (code === 0) {
                resolve();
            } else if (signal) {
                reject(new Error(`kuml CLI was terminated (${signal}) — likely timed out or was cancelled`));
            } else {
                const tail = stderr.trim().split('\n').slice(-5).join('\n');
                reject(new Error(`kuml CLI exited with code ${code}\n${tail}`));
            }
        });
    });
}

/**
 * Spawn the `kuml` CLI and capture its stdout on success. Used by the preview
 * panel's CLI fallback path when it needs the rendered SVG text directly
 * rather than a file the caller writes.
 */
export function spawnCliCapture(cliPath: string, args: string[], opts?: SpawnCliOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(cliPath, args, { shell: false });
        const maxStderrBytes = opts?.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
        let stdout = '';
        let stdoutBytes = 0;
        let stderr = '';
        let stderrBytes = 0;
        let settled = false;

        const disarm = armTimeoutAndAbort(child, opts);

        const fail = (err: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            disarm();
            child.kill('SIGTERM');
            reject(err);
        };

        child.stdout?.on('data', (chunk: Buffer) => {
            if (settled) {
                return;
            }
            stdoutBytes += chunk.length;
            if (opts?.maxStdoutBytes !== undefined && stdoutBytes > opts.maxStdoutBytes) {
                fail(new Error(`kuml CLI output exceeded the ${opts.maxStdoutBytes}-byte cap`));
                return;
            }
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderrBytes >= maxStderrBytes) {
                return;
            }
            stderrBytes += chunk.length;
            stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
            if (settled) {
                return;
            }
            settled = true;
            disarm();
            const hint = err.message.includes('ENOENT') ? ENOENT_HINT : '';
            reject(new Error(err.message + hint));
        });
        child.on('exit', (code, signal) => {
            if (settled) {
                return;
            }
            settled = true;
            disarm();
            if (code === 0) {
                resolve(stdout);
            } else if (signal) {
                reject(new Error(`kuml CLI was terminated (${signal}) — likely timed out or was cancelled`));
            } else {
                const tail = stderr.trim().split('\n').slice(-5).join('\n');
                reject(new Error(`kuml CLI exited with code ${code}\n${tail}`));
            }
        });
    });
}
