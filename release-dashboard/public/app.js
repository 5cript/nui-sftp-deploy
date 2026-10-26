const laneNames = {
    mac: "macOS (Mac mini)",
    arch: "Arch package",
    flatpak: "Flatpak",
    appimage: "AppImage",
    windows: "Windows VM",
};
const phaseNotes = {
    Publish: "Your turn: push, open the PR, merge it",
    "After merge": "AUR and Flathub: prepared here, pushed by you",
};
const statusMarks = { passed: "✓", warning: "!", failed: "✕", waiting: "✋", skipped: "–", pending: "", running: "" };
const humanKinds = new Set(["manual", "gate", "review"]);

let snapshot = null;
const elements = new Map();
const logCache = new Map();

const storage = {
    get(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : JSON.parse(value);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // Remembering open steps is a convenience only.
        }
    },
};
const openSteps = new Set(storage.get("open-steps", []));

const post = async (path, body = {}) => {
    const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Release-Dashboard": "1" },
        body: JSON.stringify(body),
    });
    const result = await response.json();
    if (result.error) {
        alert(result.error);
    }
    return result;
};

const element = (tag, properties = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(properties)) {
        if (key === "class") {
            node.className = value;
        } else if (key.startsWith("on")) {
            node.addEventListener(key.slice(2), value);
        } else {
            node[key] = value;
        }
    }
    for (const child of [children].flat()) {
        if (child !== null && child !== undefined) {
            node.append(child);
        }
    }
    return node;
};

/**
 * DOM of 5cript-nui-components, as the C++ components render it.
 */
const components = {
    button: (label, { variant = "regular", title = "", onClick, icon = null } = {}) =>
        element("button", { class: "script-nui-button", type: "button", title, onclick: onClick }, [icon, label]).withVariant(variant),
    pill: (label, { selected = false } = {}) => {
        const pill = element("span", { class: "script-nui-pill" }, [element("span", { class: "script-nui-pill-label", textContent: label })]);
        pill.dataset.selected = String(selected);
        return pill;
    },
    badge: (label, variant = "regular") => element("span", { class: "script-nui-badge", textContent: label }).withVariant(variant),
    spinner: () => element("span", { class: "script-nui-spinner" }),
    messageStrip: (text, variant = "regular") => {
        const strip = element("div", { class: "script-nui-message-strip" }, [element("span", { textContent: text })]);
        strip.dataset.styleVariant = variant;
        return strip;
    },
    setChecked: (checkbox, checked) => checkbox.toggleAttribute("data-is-checked", checked),
};

HTMLElement.prototype.withVariant = function (variant) {
    if (variant !== "regular") {
        this.dataset.variant = variant;
    }
    return this;
};

const playIcon = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M8 5v14l11-7z");
    svg.append(path);
    return svg;
};

const formatDuration = (state) => {
    if (!state.startedAt) {
        return "";
    }
    const end = state.endedAt ? Date.parse(state.endedAt) : Date.now();
    const seconds = Math.max(0, Math.round((end - Date.parse(state.startedAt)) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const logLineClass = (line) => {
    if (/^\S+ OK {2}/.test(line)) return "ok";
    if (/^\S+ FAIL /.test(line) || /^\S+ ERROR /.test(line)) return "fail";
    if (/^\S+ WARN /.test(line)) return "warn";
    if (/^\S+ ----/.test(line)) return "marker";
    return "";
};

const appendLogLines = (pre, lines) => {
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
        fragment.append(element("span", { class: logLineClass(line), textContent: `${line}\n` }));
    }
    pre.append(fragment);
    while (pre.childNodes.length > 3000) {
        pre.firstChild.remove();
    }
    if (atBottom) {
        pre.scrollTop = pre.scrollHeight;
    }
};

const renderDiff = (text) => {
    const pre = element("pre", { class: "diff" });
    for (const line of text.split("\n")) {
        const kind = line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : "";
        pre.append(element("span", { class: kind, textContent: `${line}\n` }));
    }
    return pre;
};

const stepActions = (step) => {
    const state = step.state;
    const buttons = [];
    const action = (label, name, options = {}) =>
        components.button(label, {
            variant: options.variant,
            title: options.title,
            onClick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                post(`/api/steps/${step.id}/${name}`);
            },
        });
    if (state.status === "running") {
        buttons.push(action("Stop", "stop", { variant: "danger" }));
        return buttons;
    }
    if (step.kind === "auto") {
        buttons.push(action(state.status === "pending" ? "Run" : "Rerun", "run"));
    } else if (step.kind === "review") {
        if (state.status === "waiting") {
            buttons.push(action(step.actionLabel ?? "Approve", "approve", { variant: "primary" }));
        }
        buttons.push(action(state.status === "pending" ? "Show diff" : "Refresh", "run"));
    } else {
        buttons.push(action(step.actionLabel ?? "Check", "run", { variant: state.status === "waiting" ? "primary" : "regular" }));
    }
    if (state.status === "pending" || state.status === "failed" || state.status === "waiting") {
        buttons.push(action("Skip", "skip", { title: "Mark as skipped so dependent steps can run" }));
    }
    if (state.status !== "pending") {
        buttons.push(action("Reset", "reset", { title: "Back to pending" }));
    }
    return buttons;
};

const stepBody = (step) => {
    const state = step.state;
    const parts = [element("p", { class: "description", textContent: step.description })];
    if (step.command) {
        parts.push(
            element("div", { class: "command-box" }, [
                element("code", { textContent: step.command }),
                components.button("Run", {
                    variant: "primary",
                    icon: playIcon(),
                    title: "Open in a terminal; the check runs when you close it",
                    onClick: () => post(`/api/steps/${step.id}/terminal`),
                }),
                components.button("Copy", {
                    onClick: (event) => {
                        navigator.clipboard?.writeText(step.command);
                        event.currentTarget.textContent = "Copied";
                        const target = event.currentTarget;
                        setTimeout(() => (target.textContent = "Copy"), 1200);
                    },
                }),
            ]),
        );
    }
    const pullRequest = step.id === "deploy-merge" || step.id === "deploy-pr" ? snapshot.data.deployPr : step.id === "flathub-pr" ? snapshot.data.flathubPr : null;
    if (pullRequest) {
        parts.push(element("p", { class: "link" }, [element("a", { href: pullRequest.url, target: "_blank", rel: "noopener", textContent: `#${pullRequest.number} ${pullRequest.title}` })]));
    }
    if (state.checks.length > 0) {
        parts.push(
            element(
                "ul",
                { class: "checks" },
                state.checks.map((check) =>
                    element("li", { class: check.status }, [
                        element("span", { class: "mark", textContent: statusMarks[check.status] }),
                        element("span", { textContent: check.name }),
                        check.detail ? element("span", { class: "detail", textContent: check.detail }) : null,
                    ]),
                ),
            ),
        );
    }
    if (step.kind === "review" && snapshot.data.reviewDiff) {
        parts.push(renderDiff(snapshot.data.reviewDiff));
    }
    if (state.screenshots.length > 0) {
        parts.push(
            element(
                "div",
                { class: "screenshots" },
                state.screenshots.map((shot) =>
                    element("figure", {}, [
                        element("a", { href: `/screenshots/${shot.file}?t=${Date.parse(shot.takenAt)}`, target: "_blank" }, [
                            element("img", { src: `/screenshots/${shot.file}?t=${Date.parse(shot.takenAt)}`, alt: shot.name, loading: "lazy" }),
                        ]),
                        element("figcaption", { textContent: shot.name }),
                    ]),
                ),
            ),
        );
    }
    const log = element("pre", { class: "log" });
    parts.push(log);
    const cached = logCache.get(step.id);
    if (cached) {
        appendLogLines(log, cached);
        requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
    } else {
        fetch(`/api/logs/${step.id}`)
            .then((response) => response.json())
            .then(({ lines }) => {
                logCache.set(step.id, lines);
                appendLogLines(log, lines);
                log.scrollTop = log.scrollHeight;
            });
    }
    return parts;
};

const updateStep = (step) => {
    const entry = elements.get(step.id);
    if (!entry) {
        return;
    }
    const { root, head } = entry;
    const state = step.state;
    const isOpen = openSteps.has(step.id);
    root.className = `script-nui-collapsible step status-${state.status}${humanKinds.has(step.kind) ? " human" : ""}${step.visible ? "" : " hidden"}`;
    if (root.open !== isOpen) {
        root.open = isOpen;
    }
    const icon = head.querySelector(".status-icon");
    if (state.status === "running") {
        if (!icon.querySelector(".script-nui-spinner")) {
            icon.replaceChildren(components.spinner());
        }
    } else {
        icon.textContent = statusMarks[state.status] ?? "";
    }
    head.querySelector(".summary").textContent = state.summary || (state.status === "pending" ? "" : state.status);
    head.querySelector(".duration").textContent = formatDuration(state);
    head.querySelector(".actions").replaceChildren(...stepActions(step));
    if (isOpen) {
        const body = root.querySelector(".step-body");
        const oldLog = body.querySelector("pre.log");
        const scroll = oldLog ? { top: oldLog.scrollTop, atBottom: oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40 } : null;
        body.replaceChildren(...stepBody(step));
        const newLog = body.querySelector("pre.log");
        if (scroll && newLog && logCache.has(step.id)) {
            newLog.scrollTop = scroll.atBottom ? newLog.scrollHeight : scroll.top;
        }
    }
};

const buildStep = (step) => {
    const root = document.getElementById("step-template").content.firstElementChild.cloneNode(true);
    const head = root.querySelector(".step-head");
    head.querySelector(".step-title").textContent = step.title;
    const badges = head.querySelector(".badges");
    if (humanKinds.has(step.kind)) {
        badges.append(components.pill(step.kind === "gate" ? "you merge" : step.kind === "review" ? "you review" : "you run", { selected: true }));
    }
    if (step.heavy) {
        badges.append(components.pill("heavy"));
    }
    // Like the component's header end: clicks on the actions do not toggle the section.
    head.querySelector(".actions").addEventListener("click", (event) => event.preventDefault());
    root.addEventListener("toggle", () => {
        if (root.open === openSteps.has(step.id)) {
            return;
        }
        if (root.open) {
            openSteps.add(step.id);
        } else {
            openSteps.delete(step.id);
        }
        storage.set("open-steps", [...openSteps]);
        updateStep(snapshot.steps.find((candidate) => candidate.id === step.id));
    });
    elements.set(step.id, { root, head });
    updateStep(step);
    return root;
};

const renderAll = () => {
    document.getElementById("version").textContent = snapshot.version;
    document.title = `nui-sftp ${snapshot.version} release`;
    document.getElementById("deploy-root").textContent = snapshot.deployRoot;
    const container = document.getElementById("phases");
    elements.clear();
    const phases = [...new Set(snapshot.steps.map((step) => step.phase))];
    container.replaceChildren(
        ...phases.map((phase) => {
            const steps = snapshot.steps.filter((step) => step.phase === phase);
            const section = element("section", { class: "phase" }, [element("h2", { textContent: phase })]);
            if (phaseNotes[phase]) {
                section.append(element("div", { class: "handover" }, [components.messageStrip(phaseNotes[phase], "primary")]));
            }
            if (phase === "Test") {
                const lanes = [...new Set(steps.map((step) => step.lane.replace(/-lint$/, "")))];
                for (const lane of lanes) {
                    section.append(
                        element("div", { class: "lane" }, [
                            element("h3", { textContent: laneNames[lane] ?? lane }),
                            ...steps.filter((step) => step.lane.replace(/-lint$/, "") === lane).map(buildStep),
                        ]),
                    );
                }
            } else {
                section.append(...steps.map(buildStep));
            }
            return section;
        }),
    );
    renderHeader();
};

const renderHeader = () => {
    const counts = {};
    for (const step of snapshot.steps.filter((candidate) => candidate.visible)) {
        counts[step.state.status] = (counts[step.state.status] ?? 0) + 1;
    }
    const variants = { passed: "success", warning: "warning", running: "regular", waiting: "primary", failed: "danger", skipped: "regular", pending: "regular" };
    document.getElementById("counts").replaceChildren(
        ...Object.keys(variants)
            .filter((status) => counts[status])
            .map((status) => components.badge(`${counts[status]} ${status}`, variants[status])),
    );
    const runAll = document.getElementById("run-all");
    runAll.textContent = snapshot.autoAdvance ? "Running all…" : "Run all";
    runAll.disabled = snapshot.autoAdvance;
    document.getElementById("pause").disabled = !snapshot.autoAdvance;
    document.getElementById("setting-jobs").value = snapshot.settings.buildParallelLevel;
    components.setChecked(document.getElementById("setting-headless"), snapshot.settings.headless);
    components.setChecked(document.getElementById("setting-mac"), snapshot.settings.keepMacAwake);
};

const loadSnapshot = async () => {
    snapshot = await (await fetch("/api/state")).json();
    renderAll();
};

const connectEvents = () => {
    const events = new EventSource("/api/events");
    const indicator = document.getElementById("connection");
    events.onopen = async () => {
        indicator.classList.add("live");
        logCache.clear();
        await loadSnapshot();
    };
    events.onerror = () => indicator.classList.remove("live");
    events.onmessage = async (message) => {
        const event = JSON.parse(message.data);
        if (!snapshot) {
            return;
        }
        if (event.type === "step") {
            const step = snapshot.steps.find((candidate) => candidate.id === event.id);
            step.state = event.step;
            updateStep(step);
            renderHeader();
        } else if (event.type === "log") {
            const cached = logCache.get(event.id);
            if (cached) {
                cached.push(event.line);
                const log = elements.get(event.id)?.root.querySelector("pre.log");
                if (log && openSteps.has(event.id)) {
                    appendLogLines(log, [event.line]);
                }
            }
        } else if (event.type === "data" || event.type === "settings") {
            const fresh = await (await fetch("/api/state")).json();
            snapshot.data = fresh.data;
            snapshot.settings = fresh.settings;
            for (const step of fresh.steps) {
                const existing = snapshot.steps.find((candidate) => candidate.id === step.id);
                existing.command = step.command;
                existing.visible = step.visible;
                updateStep(existing);
            }
            renderHeader();
        } else if (event.type === "auto") {
            snapshot.autoAdvance = event.autoAdvance;
            renderHeader();
        } else if (event.type === "running") {
            snapshot.running = event.running;
        }
    };
};

document.getElementById("run-all").addEventListener("click", () => post("/api/run-all"));
document.getElementById("pause").addEventListener("click", () => post("/api/pause"));
document.getElementById("stop-all").addEventListener("click", () => post("/api/stop-all"));
document.getElementById("setting-jobs").addEventListener("change", (event) => post("/api/settings", { buildParallelLevel: Number(event.target.value) }));
const bindCheckbox = (id, setting) =>
    document.getElementById(id).addEventListener("click", (event) => {
        const checked = !event.currentTarget.hasAttribute("data-is-checked");
        components.setChecked(event.currentTarget, checked);
        post("/api/settings", { [setting]: checked });
    });
bindCheckbox("setting-headless", "headless");
bindCheckbox("setting-mac", "keepMacAwake");

// The components' light theme hangs off data-theme, follow the system setting like the app's "system" theme.
const lightScheme = window.matchMedia("(prefers-color-scheme: light)");
const applyScheme = () => document.documentElement.setAttribute("data-theme", lightScheme.matches ? "light" : "dark");
lightScheme.addEventListener("change", applyScheme);
applyScheme();

setInterval(() => {
    for (const step of snapshot?.steps ?? []) {
        if (step.state.status === "running") {
            elements.get(step.id).head.querySelector(".duration").textContent = formatDuration(step.state);
        }
    }
}, 1000);

connectEvents();
