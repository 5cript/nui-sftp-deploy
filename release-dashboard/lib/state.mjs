import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const maximumLogLines = 3000;
const defaultSettings = { buildParallelLevel: 4, headless: false, keepMacAwake: false, alarmEnabled: true, alarmVolume: 20, alarmSound: "chime" };

const emptyStep = () => ({ status: "pending", startedAt: null, endedAt: null, summary: "", checks: [], screenshots: [], runs: 0 });

/**
 * Release state persisted to state.json, step logs kept in memory and in one file per step. Every change is
 * broadcast to the listeners (the SSE clients). The header settings are preferences, not release state: they live in
 * one settings.json next to the release directories and apply to every release.
 */
class StateStore {
    constructor(config, stepIds) {
        this.config = config;
        this.listeners = new Set();
        this.logs = new Map();
        mkdirSync(config.logDirectory, { recursive: true });
        mkdirSync(config.screenshotDirectory, { recursive: true });
        const loaded = existsSync(config.statePath) ? JSON.parse(readFileSync(config.statePath, "utf8")) : {};
        this.state = {
            version: config.version,
            // A release state from before the shared file seeds it once.
            settings: { ...defaultSettings, ...(this.readSettings() ?? loaded.settings) },
            data: loaded.data ?? {},
            steps: {},
        };
        for (const id of stepIds) {
            const step = { ...emptyStep(), ...loaded.steps?.[id] };
            if (step.status === "running") {
                step.status = "failed";
                step.summary = "interrupted (dashboard restarted while it ran)";
            }
            this.state.steps[id] = step;
            this.logs.set(id, this.readLogTail(id));
        }
        this.save();
        this.saveSettings();
    }

    logPath(id) {
        return join(this.config.logDirectory, `${id}.log`);
    }

    readLogTail(id) {
        const path = this.logPath(id);
        return existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(-maximumLogLines) : [];
    }

    save() {
        const temporary = `${this.config.statePath}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...this.state, settings: undefined }, null, 2));
        renameSync(temporary, this.config.statePath);
    }

    readSettings() {
        try {
            return JSON.parse(readFileSync(this.config.settingsPath, "utf8"));
        } catch {
            return null;
        }
    }

    saveSettings() {
        const temporary = `${this.config.settingsPath}.tmp`;
        writeFileSync(temporary, JSON.stringify(this.state.settings, null, 2));
        renameSync(temporary, this.config.settingsPath);
    }

    broadcast(event) {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    step(id) {
        return this.state.steps[id];
    }

    updateStep(id, changes) {
        Object.assign(this.state.steps[id], changes);
        this.save();
        this.broadcast({ type: "step", id, step: this.state.steps[id] });
    }

    resetStep(id) {
        const runs = this.state.steps[id].runs;
        this.state.steps[id] = { ...emptyStep(), runs };
        this.save();
        this.broadcast({ type: "step", id, step: this.state.steps[id] });
    }

    addCheck(id, check) {
        const checks = this.state.steps[id].checks;
        const existing = checks.findIndex((entry) => entry.name === check.name);
        if (existing >= 0) {
            checks[existing] = check;
        } else {
            checks.push(check);
        }
        this.updateStep(id, { checks });
    }

    log(id, line) {
        const stamped = `${new Date().toISOString().slice(11, 19)} ${line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")}`;
        const lines = this.logs.get(id);
        lines.push(stamped);
        if (lines.length > maximumLogLines) {
            lines.splice(0, lines.length - maximumLogLines);
        }
        appendFileSync(this.logPath(id), `${stamped}\n`);
        this.broadcast({ type: "log", id, line: stamped });
    }

    setData(changes) {
        Object.assign(this.state.data, changes);
        this.save();
        this.broadcast({ type: "data", data: this.state.data });
    }

    setSettings(changes) {
        // Another dashboard (another release) may have changed the file meanwhile.
        Object.assign(this.state.settings, this.readSettings());
        for (const [key, value] of Object.entries(changes)) {
            if (key in defaultSettings && typeof value === typeof defaultSettings[key]) {
                this.state.settings[key] = key === "alarmVolume" ? Math.max(0, Math.min(100, value)) : key === "buildParallelLevel" ? Math.max(1, value) : value;
            }
        }
        this.saveSettings();
        this.broadcast({ type: "settings", settings: this.state.settings });
    }
}

export { StateStore };
