import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, startProcess, shellQuote } from "./process.mjs";

const satisfiedStatuses = new Set(["passed", "warning", "skipped"]);
const finishedStatuses = new Set(["passed", "warning", "skipped", "failed"]);

/**
 * Thrown by ctx.require: ends the step as failed with a readable reason instead of a stack trace.
 */
class StepFailure extends Error {}

/**
 * Executes steps, alone or as "run all", which keeps advancing whenever a step finishes or a human gate passes.
 * Steps on the same lane never overlap, heavy steps (local builds, the VM build) never overlap each other.
 */
class Runner {
    constructor(config, store, steps) {
        this.config = config;
        this.store = store;
        this.steps = steps;
        this.stepById = new Map(steps.map((step) => [step.id, step]));
        this.running = new Map();
        this.autoAdvance = false;
    }

    status(id) {
        return this.store.step(id).status;
    }

    isVisible(step) {
        return step.visible ? step.visible(this.store.state.data) : true;
    }

    isReady(step) {
        const needsMet = this.needsMet(step);
        const afterMet = (step.after ?? []).every((id) => this.isSettled(id));
        return needsMet && afterMet;
    }

    /**
     * Every need passed with its own needs met, so a step run out of order by hand does not unlock its dependents.
     * Skipped steps count as met without looking further, that is what skipping is for.
     */
    needsMet(step, seen = new Set()) {
        return (step.needs ?? []).every((id) => {
            const need = this.stepById.get(id);
            const status = this.status(id);
            if (!this.isVisible(need) || status === "skipped") {
                return true;
            }
            if (!satisfiedStatuses.has(status)) {
                return false;
            }
            if (seen.has(id)) {
                return true;
            }
            seen.add(id);
            return this.needsMet(need, seen);
        });
    }

    /**
     * Finished, or pending behind a failed step, so "after" ordering never waits forever on a broken chain.
     */
    isSettled(id, seen = new Set()) {
        const status = this.status(id);
        if (finishedStatuses.has(status)) {
            return true;
        }
        if (status !== "pending" || seen.has(id)) {
            return false;
        }
        seen.add(id);
        const step = this.stepById.get(id);
        return !this.isVisible(step) || (step.needs ?? []).some((need) => this.status(need) === "failed" || (this.status(need) === "pending" && this.isSettled(need, seen)));
    }

    isBlockedByResources(step) {
        for (const [id] of this.running) {
            const other = this.stepById.get(id);
            if (other.lane === step.lane || (other.heavy && step.heavy)) {
                return true;
            }
        }
        return false;
    }

    snapshot() {
        const data = this.store.state.data;
        return {
            version: this.config.version,
            deployRoot: this.config.deployRoot,
            autoAdvance: this.autoAdvance,
            running: [...this.running.keys()],
            settings: this.store.state.settings,
            data,
            steps: this.steps.map((step) => ({
                id: step.id,
                phase: step.phase,
                lane: step.lane,
                title: step.title,
                description: step.description ?? "",
                kind: step.kind,
                heavy: Boolean(step.heavy),
                needs: step.needs ?? [],
                visible: this.isVisible(step),
                command: step.command ? step.command(this.makeContext(step, null)) : null,
                actionLabel: step.actionLabel ?? null,
                state: this.store.step(step.id),
            })),
        };
    }

    makeContext(step, controller) {
        const config = this.config;
        const store = this.store;
        const id = step.id;
        const log = (line) => store.log(id, line);
        const context = {
            config,
            step,
            signal: controller?.signal,
            get settings() {
                return store.state.settings;
            },
            get data() {
                return store.state.data;
            },
            setData: (changes) => store.setData(changes),
            log,
            run: (command, args = [], options = {}) =>
                runCommand(command, args, { cwd: config.deployRoot, ...options, onLine: options.quiet ? undefined : log, signal: controller?.signal }),
            bash: (script, options = {}) =>
                runCommand("bash", ["-c", script], { cwd: config.deployRoot, ...options, onLine: options.quiet ? undefined : log, signal: controller?.signal }),
            capture: async (command, args = [], options = {}) =>
                (await runCommand(command, args, { cwd: config.deployRoot, quiet: true, ...options, signal: controller?.signal })).output.trim(),
            start: (command, args, options = {}) => startProcess(command, args, { cwd: config.deployRoot, ...options, onLine: (line) => log(`[app] ${line}`) }),
            check: (name, ok, detail = "", { warn = false } = {}) => {
                const status = ok ? "passed" : warn ? "warning" : "failed";
                store.addCheck(id, { name, status, detail: String(detail ?? "") });
                log(`${ok ? "OK  " : warn ? "WARN" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
                return ok;
            },
            require: (name, ok, detail = "") => {
                context.check(name, ok, detail);
                if (!ok) {
                    throw new StepFailure(`${name}${detail ? `: ${detail}` : ""}`);
                }
            },
            screenshot: (name, buffer) => {
                const file = `${id}-${name}.png`;
                writeFileSync(join(config.screenshotDirectory, file), buffer);
                const screenshots = store.step(id).screenshots.filter((entry) => entry.file !== file);
                screenshots.push({ name, file, takenAt: new Date().toISOString() });
                store.updateStep(id, { screenshots });
            },
            otherStep: (otherId) => store.step(otherId),
            quote: shellQuote,
        };
        return context;
    }

    /**
     * mode "run" runs an auto step or a manual/gate step's check, "approve" runs a review step's approve.
     */
    async execute(id, mode = "run") {
        const step = this.stepById.get(id);
        if (!step || this.running.has(id)) {
            return;
        }
        const controller = new AbortController();
        this.running.set(id, controller);
        const previous = this.store.step(id);
        this.store.updateStep(id, {
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            summary: "",
            checks: mode === "approve" ? previous.checks : [],
            runs: previous.runs + 1,
        });
        this.store.log(id, `---- ${mode === "approve" ? "approve" : step.kind === "auto" ? "run" : "check"} #${previous.runs + 1} ----`);
        const context = this.makeContext(step, controller);
        let status;
        let summary = "";
        try {
            const action = mode === "approve" ? step.approve : step.kind === "auto" || step.kind === "review" ? step.run : step.check;
            const result = (await action(context)) ?? {};
            summary = result.summary ?? "";
            const checks = this.store.step(id).checks;
            if (result.waiting) {
                status = "waiting";
            } else if (checks.some((check) => check.status === "failed") || result.passed === false) {
                status = step.kind === "auto" ? "failed" : "waiting";
            } else if (checks.some((check) => check.status === "warning") || result.warning) {
                status = "warning";
            } else {
                status = "passed";
            }
        } catch (error) {
            const stopped = controller.signal.aborted;
            status = step.kind === "auto" || stopped ? "failed" : "waiting";
            summary = stopped ? "stopped" : error instanceof StepFailure ? error.message : error.message.split("\n")[0];
            if (!(error instanceof StepFailure)) {
                this.store.log(id, `ERROR ${error.stack ?? error.message}`);
                if (error.output && !error.output.trim().endsWith(error.message)) {
                    this.store.log(id, error.output.trim().split("\n").slice(-15).join("\n"));
                }
            }
        }
        this.running.delete(id);
        this.store.updateStep(id, { status, summary, endedAt: new Date().toISOString() });
        this.store.log(id, `---- ${status}${summary ? `: ${summary}` : ""} ----`);
        this.store.broadcast({ type: "running", running: [...this.running.keys()] });
        this.tick();
    }

    start(id, mode = "run") {
        const step = this.stepById.get(id);
        if (!step || this.running.has(id)) {
            return { error: "unknown or already running" };
        }
        if (this.isBlockedByResources(step)) {
            return { error: `waits for ${[...this.running.keys()].join(", ")} (same lane or both heavy)` };
        }
        this.execute(id, mode);
        this.store.broadcast({ type: "running", running: [...this.running.keys()] });
        return { ok: true };
    }

    stop(id) {
        this.running.get(id)?.abort();
    }

    stopAll() {
        this.autoAdvance = false;
        for (const controller of this.running.values()) {
            controller.abort();
        }
        this.store.broadcast({ type: "auto", autoAdvance: false });
    }

    skip(id) {
        if (!this.running.has(id)) {
            this.store.updateStep(id, { status: "skipped", summary: "skipped by hand", endedAt: new Date().toISOString() });
            this.tick();
        }
    }

    reset(id) {
        if (!this.running.has(id)) {
            this.store.resetStep(id);
            this.store.log(id, "---- reset ----");
        }
    }

    runAll() {
        this.autoAdvance = true;
        this.store.broadcast({ type: "auto", autoAdvance: true });
        this.tick();
    }

    tick() {
        if (!this.autoAdvance) {
            return;
        }
        for (const step of this.steps) {
            if (!this.isVisible(step) || this.status(step.id) !== "pending" || this.running.has(step.id)) {
                continue;
            }
            if (this.isReady(step) && !this.isBlockedByResources(step)) {
                this.execute(step.id);
            }
        }
        this.store.broadcast({ type: "running", running: [...this.running.keys()] });
    }
}

export { Runner, StepFailure };
