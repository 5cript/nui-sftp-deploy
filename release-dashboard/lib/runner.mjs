import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, startProcess, shellQuote } from "./process.mjs";

const satisfiedStatuses = new Set(["passed", "warning", "skipped"]);
const finishedStatuses = new Set(["passed", "warning", "skipped", "failed"]);
const completedStatuses = new Set(["passed", "warning"]);
// Steps of these phases wait until every test ran (any result) or was skipped.
const lockedPhases = new Set(["Publish", "After merge"]);

/**
 * Thrown by ctx.require: ends the step as failed with a readable reason instead of a stack trace.
 */
class StepFailure extends Error {}

/**
 * Executes steps, alone or as "run all", which keeps advancing whenever a step finishes or a human gate passes.
 * Steps on the same lane never overlap, heavy steps (local builds, the VM build) never overlap each other. A test
 * target (group) started on its own runs in parallel: its steps advance by themselves and ignore the heavy lock and
 * the "after" ordering, but still follow each other and still need their dependencies.
 */
class Runner {
    constructor(config, store, steps) {
        this.config = config;
        this.store = store;
        this.steps = steps;
        this.stepById = new Map(steps.map((step) => [step.id, step]));
        this.running = new Map();
        this.autoAdvance = false;
        this.parallelGroups = new Set();
        this.groups = [...new Set(steps.map((step) => this.groupOf(step)).filter(Boolean))];
    }

    /**
     * The test target a step belongs to (its lane, flatpak lint counts to the flatpak target), null outside the tests.
     */
    groupOf(step) {
        return step.phase === "Test" ? step.lane.replace(/-lint$/, "") : null;
    }

    isParallel(step) {
        const group = this.groupOf(step);
        return group !== null && this.parallelGroups.has(group);
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
            if (other.lane === step.lane) {
                return true;
            }
            if (step.heavy && other.heavy && !this.isParallel(step) && !this.isParallel(other)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether a step's own button may start it now: dependencies met and nothing it has to wait for running.
     */
    isRunnable(step) {
        return (
            this.isVisible(step) &&
            !this.running.has(step.id) &&
            this.needsMet(step) &&
            !this.isBlockedByResources(step) &&
            !this.isLocked(step)
        );
    }

    /**
     * Every visible test step ran (passed, warning or failed) or was skipped.
     */
    testsDone() {
        return this.steps.every((step) => step.phase !== "Test" || !this.isVisible(step) || finishedStatuses.has(this.status(step.id)));
    }

    isLocked(step) {
        return lockedPhases.has(step.phase) && !this.testsDone();
    }

    /**
     * What "reset all" keeps: completed irreversible steps (pushed, PR opened, merged) with everything they were based
     * on, their dependencies and, once anything left the machine, the prepare and test phases.
     */
    resetAllKeeps() {
        const keep = new Set();
        const addWithNeeds = (id) => {
            if (keep.has(id)) {
                return;
            }
            keep.add(id);
            for (const need of this.stepById.get(id).needs ?? []) {
                addWithNeeds(need);
            }
        };
        const completed = this.steps.filter((step) => step.irreversible && completedStatuses.has(this.status(step.id)));
        completed.forEach((step) => addWithNeeds(step.id));
        if (completed.length > 0) {
            this.steps.filter((step) => step.phase === "Prepare" || step.phase === "Test").forEach((step) => keep.add(step.id));
        }
        return keep;
    }

    resetAll() {
        if (this.running.size > 0) {
            return { error: "stop the running steps first" };
        }
        this.autoAdvance = false;
        this.parallelGroups.clear();
        const keep = this.resetAllKeeps();
        for (const step of this.steps) {
            if (!keep.has(step.id) && this.status(step.id) !== "pending") {
                this.store.resetStep(step.id);
                this.store.log(step.id, "---- reset all ----");
            }
        }
        this.store.broadcast({ type: "auto", autoAdvance: false });
        this.broadcastRunnable();
        return { ok: true, kept: [...keep] };
    }

    groupSteps(group) {
        return this.steps.filter((step) => this.groupOf(step) === group && this.isVisible(step));
    }

    groupInfo() {
        return this.groups.map((group) => {
            const steps = this.groupSteps(group);
            const running = steps.some((step) => this.running.has(step.id));
            return {
                id: group,
                parallel: this.parallelGroups.has(group),
                running,
                startable:
                    !this.parallelGroups.has(group) &&
                    !running &&
                    steps.some((step) => this.status(step.id) === "pending" && this.needsMet(step)),
                resettable: !running && steps.some((step) => this.status(step.id) !== "pending"),
            };
        });
    }

    broadcastRunnable() {
        const runnable = Object.fromEntries(this.steps.map((step) => [step.id, this.isRunnable(step)]));
        this.store.broadcast({
            type: "runnable",
            runnable,
            groups: this.groupInfo(),
            running: [...this.running.keys()],
            testsDone: this.testsDone(),
            resetAllKeeps: [...this.resetAllKeeps()],
        });
    }

    snapshot() {
        const data = this.store.state.data;
        return {
            version: this.config.version,
            deployRoot: this.config.deployRoot,
            autoAdvance: this.autoAdvance,
            running: [...this.running.keys()],
            groups: this.groupInfo(),
            testsDone: this.testsDone(),
            resetAllKeeps: [...this.resetAllKeeps()],
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
                group: this.groupOf(step),
                runnable: this.isRunnable(step),
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
            if (/gpg failed to sign|signing failed/.test(error.output ?? "")) {
                summary = "signing failed (pinentry timed out?), run it again while you are at the machine";
            }
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
        this.tick();
    }

    start(id, mode = "run") {
        const step = this.stepById.get(id);
        if (!step || this.running.has(id)) {
            return { error: "unknown or already running" };
        }
        if (mode === "approve" ? this.status(id) !== "waiting" : !this.isRunnable(step)) {
            return { error: "this step cannot run now (dependencies not met, or it waits for a running step)" };
        }
        this.execute(id, mode);
        this.broadcastRunnable();
        return { ok: true };
    }

    /**
     * Runs a test target next to everything else, its steps one after another.
     */
    startGroup(group) {
        const info = this.groupInfo().find((entry) => entry.id === group);
        if (!info?.startable) {
            return { error: `${group} cannot start now` };
        }
        this.parallelGroups.add(group);
        this.tick();
        return { ok: true };
    }

    resetGroup(group) {
        const info = this.groupInfo().find((entry) => entry.id === group);
        if (!info?.resettable) {
            return { error: `${group} has a running step or nothing to reset` };
        }
        this.parallelGroups.delete(group);
        for (const step of this.steps.filter((candidate) => this.groupOf(candidate) === group)) {
            this.store.resetStep(step.id);
            this.store.log(step.id, "---- reset with its target ----");
        }
        this.tick();
        return { ok: true };
    }

    stop(id) {
        this.running.get(id)?.abort();
    }

    stopGroup(group) {
        this.parallelGroups.delete(group);
        for (const step of this.groupSteps(group)) {
            this.running.get(step.id)?.abort();
        }
        this.broadcastRunnable();
    }

    stopAll() {
        this.autoAdvance = false;
        this.parallelGroups.clear();
        for (const controller of this.running.values()) {
            controller.abort();
        }
        this.store.broadcast({ type: "auto", autoAdvance: false });
        this.broadcastRunnable();
    }

    pause() {
        this.autoAdvance = false;
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
            this.broadcastRunnable();
        }
    }

    runAll() {
        this.autoAdvance = true;
        this.store.broadcast({ type: "auto", autoAdvance: true });
        this.tick();
    }

    tick() {
        for (const step of this.steps) {
            if (!this.isVisible(step) || this.status(step.id) !== "pending" || this.running.has(step.id)) {
                continue;
            }
            const parallel = this.isParallel(step);
            if (!this.autoAdvance && !parallel) {
                continue;
            }
            const ready = parallel ? this.needsMet(step) : this.isReady(step);
            if (ready && !this.isBlockedByResources(step) && !this.isLocked(step)) {
                this.execute(step.id);
            }
        }
        for (const group of this.parallelGroups) {
            if (this.groupSteps(group).every((step) => this.isSettled(step.id))) {
                this.parallelGroups.delete(group);
            }
        }
        this.broadcastRunnable();
    }
}

export { Runner, StepFailure };
