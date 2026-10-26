import { execFileSync, spawn } from "node:child_process";

/**
 * Error of a command that exited with a non-zero code or was stopped.
 */
class CommandError extends Error {
    constructor(message, { code = null, output = "" } = {}) {
        super(message);
        this.code = code;
        this.output = output;
    }
}

/**
 * Every process in the session the child leads (detached spawns get their own) and all their descendants: sandboxes
 * like flatpak-builder's bwrap re-parent to the user's systemd but stay in the session.
 */
const sessionProcesses = (sessionId) => {
    let table;
    try {
        table = execFileSync("ps", ["-eo", "pid=,ppid=,sid="], { encoding: "utf8" })
            .trim()
            .split("\n")
            .map((line) => line.trim().split(/\s+/).map(Number));
    } catch {
        return [];
    }
    const members = new Set(table.filter(([, , session]) => session === sessionId).map(([pid]) => pid));
    members.add(sessionId);
    for (let grown = true; grown; ) {
        grown = false;
        for (const [pid, parent] of table) {
            if (members.has(parent) && !members.has(pid)) {
                members.add(pid);
                grown = true;
            }
        }
    }
    return [...members];
};

const killGroup = (child, signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    for (const pid of sessionProcesses(child.pid)) {
        try {
            process.kill(pid, signal);
        } catch {
            // Already gone.
        }
    }
};

/**
 * Runs a command in its own process group and streams every output line to onLine.
 * Options: cwd, env (merged into process.env), input, signal (AbortSignal), timeoutMs, allowFailure,
 * watchers ([{ pattern, limit, message }], fails the command once a line matched limit times), quiet.
 * Resolves { code, output }; rejects with CommandError unless allowFailure.
 */
const runCommand = (command, args, options = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
        const { cwd, env, input, signal, timeoutMs, allowFailure = false, watchers = [], onLine, quiet = false } = options;
        const display = [command, ...args].join(" ");
        if (!quiet) {
            onLine?.(`$ ${display}`);
        }
        const child = spawn(command, args, {
            cwd,
            env: { ...process.env, ...env },
            detached: true,
            stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        let output = "";
        let failure = null;
        const counts = watchers.map(() => 0);
        const fail = (message) => {
            if (!failure) {
                failure = message;
                killGroup(child);
                setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
            }
        };
        const handleLine = (line) => {
            output += `${line}\n`;
            if (!quiet) {
                onLine?.(line);
            }
            watchers.forEach((watcher, index) => {
                if (watcher.pattern.test(line) && ++counts[index] >= watcher.limit) {
                    fail(watcher.message);
                }
            });
        };
        const lineReader = () => {
            let pending = "";
            const read = (chunk) => {
                pending += chunk.toString();
                const lines = pending.split(/\r?\n|\r(?!\n)/);
                pending = lines.pop();
                lines.forEach(handleLine);
            };
            read.flush = () => {
                if (pending !== "") {
                    handleLine(pending);
                    pending = "";
                }
            };
            return read;
        };
        const readStdout = lineReader();
        const readStderr = lineReader();
        child.stdout.on("data", readStdout);
        child.stderr.on("data", readStderr);
        if (input !== undefined) {
            child.stdin.end(input);
        }
        const onAbort = () => fail("stopped");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
        }
        const timer = timeoutMs ? setTimeout(() => fail(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs) : null;
        child.on("error", (error) => {
            failure ??= error.message;
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            readStdout.flush();
            readStderr.flush();
            output = output.replace(/\n+$/, "\n");
            if (failure) {
                rejectPromise(new CommandError(`${display}: ${failure}`, { code, output }));
            } else if (code !== 0 && !allowFailure) {
                rejectPromise(new CommandError(`${display} exited with ${code}`, { code, output }));
            } else {
                resolvePromise({ code, output });
            }
        });
    });

/**
 * Starts a long running process (an app under test) without waiting for it. Returns { child, exited } where exited
 * resolves the exit code. Output lines go to onLine and are kept in lines.
 */
const startProcess = (command, args, { cwd, env, onLine } = {}) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const lines = [];
    const forward = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
            if (line.length > 0) {
                lines.push(line);
                onLine?.(line);
            }
        }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    const exited = new Promise((resolvePromise) => {
        child.on("error", (error) => {
            onLine?.(`failed to start: ${error.message}`);
            resolvePromise(-1);
        });
        child.on("close", (code, signal) => resolvePromise(code ?? (signal ? `signal ${signal}` : -1)));
    });
    return { child, exited, lines, kill: (signal) => killGroup(child, signal) };
};

const sleep = (milliseconds, signal) =>
    new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(resolvePromise, milliseconds);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                rejectPromise(new CommandError("stopped"));
            },
            { once: true },
        );
    });

/**
 * Polls probe until it returns a truthy value, fails after timeoutMs with message.
 */
const waitFor = async (probe, { timeoutMs, intervalMs = 1000, message, signal }) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(message);
        }
        await sleep(intervalMs, signal);
    }
};

const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

export { CommandError, runCommand, startProcess, sleep, waitFor, shellQuote, killGroup };
