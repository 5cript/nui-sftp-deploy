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
const groupHeaders = new Map();
const lockNotes = [];

/**
 * A soft two-note bell made with Web Audio (no sound file): sine partials, short attack, long decay, played twice.
 */
const chime = {
    context: null,
    unlock() {
        this.context ??= new AudioContext();
        if (this.context.state === "suspended") {
            this.context.resume().then(updateSoundHint, () => {});
        }
        updateSoundHint();
    },
    buffers: new Map(),
    sounds: [],
    /**
     * Plays the chosen alarm: the synthesized chime, or a system sound file (decoded once, same volume control).
     */
    async play(volumePercent, soundId = "chime") {
        this.context ??= new AudioContext();
        this.context.resume().catch(() => {});
        const audio = this.context;
        const master = audio.createGain();
        master.gain.value = Math.max(0, Math.min(1, volumePercent / 100));
        master.connect(audio.destination);
        const sound = this.sounds.find((entry) => entry.id === soundId);
        if (sound?.url) {
            try {
                if (!this.buffers.has(sound.id)) {
                    const data = await (await fetch(sound.url)).arrayBuffer();
                    this.buffers.set(sound.id, await audio.decodeAudioData(data));
                }
                const source = audio.createBufferSource();
                source.buffer = this.buffers.get(sound.id);
                source.connect(master);
                source.start();
                return;
            } catch {
                // Fall back to the chime when the file cannot be played.
            }
        }
        const notes = [
            [659.25, 0],
            [987.77, 0.22],
            [659.25, 2.2],
            [987.77, 2.42],
        ];
        for (const [frequency, offset] of notes) {
            for (const [ratio, level] of [
                [1, 0.6],
                [2, 0.15],
                [3, 0.05],
            ]) {
                const oscillator = audio.createOscillator();
                oscillator.type = "sine";
                oscillator.frequency.value = frequency * ratio;
                const envelope = audio.createGain();
                const start = audio.currentTime + offset;
                envelope.gain.setValueAtTime(0.0001, start);
                envelope.gain.exponentialRampToValueAtTime(level, start + 0.02);
                envelope.gain.exponentialRampToValueAtTime(0.0001, start + 1.9);
                oscillator.connect(envelope).connect(master);
                oscillator.start(start);
                oscillator.stop(start + 2);
            }
        }
    },
};

const updateSoundHint = () => {
    const hint = document.getElementById("sound-hint");
    hint.hidden = !snapshot?.settings.alarmEnabled || chime.context?.state === "running";
};

// Statuses before the latest run of each step, so the alarm rings on arrival, not on every recheck.
const settledStatus = new Map();
const lastStatus = new Map();
let lastRing = 0;

/**
 * Rings when the run arrives at the push step, when the merge is seen, and when a test step fails or starts waiting
 * for you (each time a run of it ends that way; steps you stopped yourself stay quiet).
 */
const ringFor = (step, state) => {
    const status = state.status;
    const before = settledStatus.get(step.id);
    const previous = lastStatus.get(step.id);
    lastStatus.set(step.id, status);
    if (status !== "running") {
        settledStatus.set(step.id, status);
    }
    if (!snapshot.settings.alarmEnabled) {
        return;
    }
    const runEnded = previous === "running" && status !== "running";
    const testFailed = step.phase === "Test" && runEnded && status === "failed" && state.summary !== "stopped";
    const testNeedsYou = step.phase === "Test" && runEnded && status === "waiting" && before !== "waiting";
    const changed = before !== undefined && before !== status;
    const arrivedAtPush = changed && step.id === "push-branch" && status === "waiting";
    const merged = changed && step.id === "deploy-merge" && status === "passed";
    if ((testFailed || testNeedsYou || arrivedAtPush || merged) && Date.now() - lastRing > 5000) {
        lastRing = Date.now();
        chime.play(snapshot.settings.alarmVolume, snapshot.settings.alarmSound);
    }
};
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
        } else if (key === "dataset") {
            Object.assign(node.dataset, value);
        } else if (key === "ariaLabel") {
            node.setAttribute("aria-label", value);
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
    button: (label, { variant = "regular", title = "", onClick, icon = null, disabled = false } = {}) =>
        element("button", { class: "script-nui-button", type: "button", title, disabled, onclick: onClick }, [icon, label]).withVariant(variant),
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
    /**
     * script-nui-select: a button showing the active option, the options in a native popover placed under it.
     */
    select: ({ label, options, value, onChange }) => {
        const svgNamespace = "http://www.w3.org/2000/svg";
        const chevron = document.createElementNS(svgNamespace, "svg");
        chevron.setAttribute("viewBox", "0 0 24 24");
        const chevronPath = document.createElementNS(svgNamespace, "path");
        chevronPath.setAttribute("d", "m6 9 6 6 6-6");
        chevron.append(chevronPath);
        const active = element("span");
        const popover = element("div", { class: "script-nui-select-popover" });
        popover.setAttribute("popover", "auto");
        const root = element("button", { class: "script-nui-select", type: "button" }, [
            element("span", { class: "script-nui-select-prefix" }, [element("span", { class: "script-nui-select-label", textContent: label })]),
            active,
            chevron,
            element("span", { class: "script-nui-select-spinner" }),
            popover,
        ]);
        const setValue = (next) => {
            root.dataset.value = next;
            active.textContent = options.find((option) => option.value === next)?.label ?? next;
        };
        options.forEach((option, index) => {
            const item = element("div", { textContent: option.label, tabIndex: 0 });
            item.dataset.index = index;
            const choose = (event) => {
                event.stopPropagation();
                event.preventDefault();
                popover.hidePopover();
                setValue(option.value);
                onChange(option.value);
            };
            item.addEventListener("click", choose);
            item.addEventListener("keydown", (event) => event.key === "Enter" && choose(event));
            popover.append(item);
        });
        root.addEventListener("click", (event) => {
            if (event.target !== root && !root.contains(event.target)) {
                return;
            }
            if (popover.matches(":popover-open")) {
                popover.hidePopover();
                return;
            }
            const rect = root.getBoundingClientRect();
            const maxHeight = Math.min(320, window.innerHeight - rect.bottom - 8);
            Object.assign(popover.style, { top: `${rect.bottom}px`, left: `${rect.left}px`, width: `${rect.width}px`, maxHeight: `${maxHeight}px` });
            popover.showPopover();
            popover.querySelector(`div[data-index="${options.findIndex((option) => option.value === root.dataset.value)}"]`)?.focus();
        });
        setValue(value);
        return { root, setValue };
    },
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
            title: options.disabled ? "Waits for its dependencies or a running step" : options.title,
            disabled: options.disabled ?? false,
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
    const blocked = step.runnable === false;
    if (step.kind === "auto") {
        buttons.push(action(state.status === "pending" ? "Run" : "Rerun", "run", { disabled: blocked }));
    } else if (step.kind === "review") {
        if (state.status === "waiting") {
            buttons.push(action(step.actionLabel ?? "Approve", "approve", { variant: "primary" }));
        }
        buttons.push(action(state.status === "pending" ? "Show diff" : "Refresh", "run", { disabled: blocked }));
    } else {
        buttons.push(action(step.actionLabel ?? "Check", "run", { variant: state.status === "waiting" ? "primary" : "regular", disabled: blocked }));
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
                    disabled: step.runnable === false,
                    title: step.runnable === false ? "Locked until the tests ran, or its dependencies are not met" : "Open in a terminal; the check runs when you close it",
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
        if (step.group) {
            layoutLanes(root.open ? step.group : null);
        }
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
    lockNotes.length = 0;
    const phases = [...new Set(snapshot.steps.map((step) => step.phase))];
    container.replaceChildren(
        ...phases.map((phase) => {
            const steps = snapshot.steps.filter((step) => step.phase === phase);
            const section = element("section", { class: "phase" }, [element("h2", { textContent: phase })]);
            if (phaseNotes[phase]) {
                section.append(element("div", { class: "handover" }, [components.messageStrip(phaseNotes[phase], "primary")]));
            }
            if (phase === "Publish" || phase === "After merge") {
                const note = element("div", { class: "handover lock-note" }, [
                    components.messageStrip("Locked until every test ran or was skipped (any result counts).", "warning"),
                ]);
                lockNotes.push(note);
                section.append(note);
            }
            if (phase === "Test") {
                groupHeaders.clear();
                lanes.groups = [...new Set(steps.map((step) => step.group))];
                lanes.elements = lanes.groups.map((group) => {
                    const header = element("div", { class: "lane-header" });
                    groupHeaders.set(group, header);
                    return element("div", { class: "lane" }, [header, ...steps.filter((step) => step.group === group).map(buildStep)]);
                });
                lanes.host = element("div", { class: "lanes-host" });
                lanes.mode = null;
                section.append(lanes.host);
                layoutLanes();
                updateGroups();
            } else {
                section.append(...steps.map(buildStep));
            }
            return section;
        }),
    );
    renderHeader();
    updateLock();
};

/**
 * The test targets side by side, or, while a step of them is expanded, a 5cript-nui-components carousel with one
 * target per page so the expanded step gets the full width.
 */
const lanes = { groups: [], elements: [], host: null, mode: null, page: 0, track: null, dots: [], previous: null, next: null, counter: null };

const arrowIcon = (path) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 512 512");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
};
const leftArrowPath = "M326 416q-10 0-17-7L168 274q-8-6-8-18 0-11 8-19l141-134q7-7 17-7 11 0 18.5 7.5T352 122q0 10-8 18L223 256l121 116q8 8 8 18 0 11-7.5 18.5T326 416z";
const rightArrowPath = "M186 416q-11 0-18.5-7.5T160 390q0-10 8-18l121-116-121-116q-8-8-8-18 0-11 7.5-18.5T186 96q10 0 17 7l141 134q8 8 8 19 0 12-8 18L203 409q-7 7-17 7z";

const setLanePage = (page) => {
    lanes.page = Math.max(0, Math.min(lanes.groups.length - 1, page));
    if (lanes.mode !== "carousel") {
        return;
    }
    lanes.track.style.transform = `translateX(-${lanes.page * 100}%)`;
    lanes.track.querySelectorAll(".script-nui-carousel__card").forEach((card, index) => card.classList.toggle("script-nui-carousel__card--active", index === lanes.page));
    lanes.dots.forEach((dot, index) => dot.classList.toggle("script-nui-carousel__dot--active", index === lanes.page));
    lanes.previous.classList.toggle("script-nui-carousel__prev--disabled", lanes.page === 0);
    lanes.next.classList.toggle("script-nui-carousel__next--disabled", lanes.page === lanes.groups.length - 1);
    const pad = (value) => String(value).padStart(2, "0");
    lanes.counter.textContent = `${laneNames[lanes.groups[lanes.page]] ?? lanes.groups[lanes.page]}  ${pad(lanes.page + 1)} / ${pad(lanes.groups.length)}`;
};

const layoutLanes = (openedGroup = null) => {
    if (!lanes.host) {
        return;
    }
    const anyOpen = snapshot.steps.some((step) => step.group && step.visible && openSteps.has(step.id));
    if (!anyOpen) {
        if (lanes.mode !== "grid") {
            lanes.mode = "grid";
            lanes.host.replaceChildren(element("div", { class: "lanes" }, lanes.elements));
        }
        return;
    }
    if (lanes.mode !== "carousel") {
        lanes.mode = "carousel";
        lanes.dots = lanes.groups.map((group, index) =>
            element("button", { class: "script-nui-carousel__dot", type: "button", title: laneNames[group] ?? group, ariaLabel: `Go to ${laneNames[group] ?? group}`, onclick: () => setLanePage(index) }),
        );
        lanes.previous = element("button", { class: "script-nui-carousel__prev", type: "button", ariaLabel: "Previous target", onclick: () => setLanePage(lanes.page - 1) }, [arrowIcon(leftArrowPath)]);
        lanes.next = element("button", { class: "script-nui-carousel__next", type: "button", ariaLabel: "Next target", onclick: () => setLanePage(lanes.page + 1) }, [arrowIcon(rightArrowPath)]);
        lanes.counter = element("span", { class: "script-nui-carousel__counter" });
        lanes.track = element(
            "div",
            { class: "script-nui-carousel__track script-nui-carousel__track--animated" },
            lanes.elements.map((lane, index) => element("div", { class: "script-nui-carousel__card", dataset: { carouselIndex: index } }, [lane])),
        );
        lanes.host.replaceChildren(
            element("div", { class: "script-nui-carousel script-nui-carousel--controls-top lanes-carousel" }, [
                element("div", { class: "script-nui-carousel__controls" }, [
                    element("div", { class: "script-nui-carousel__dots" }, lanes.dots),
                    element("div", { class: "script-nui-carousel__arrows" }, [lanes.previous, lanes.counter, lanes.next]),
                ]),
                element("div", { class: "script-nui-carousel__frame" }, [lanes.track]),
            ]),
        );
        const firstOpen = snapshot.steps.find((step) => step.group && step.visible && openSteps.has(step.id));
        openedGroup ??= firstOpen.group;
    }
    setLanePage(openedGroup ? lanes.groups.indexOf(openedGroup) : lanes.page);
};

/**
 * Column headers of the test targets: Start runs the target next to everything else, Reset puts it back to pending.
 */
const updateGroups = () => {
    for (const info of snapshot.groups ?? []) {
        const header = groupHeaders.get(info.id);
        if (!header) {
            continue;
        }
        const groupAction = (label, action, options) =>
            components.button(label, { ...options, onClick: () => post(`/api/groups/${info.id}/${action}`) });
        header.replaceChildren(
            ...[element("h3", { textContent: laneNames[info.id] ?? info.id }), info.parallel ? components.pill("parallel", { selected: true }) : null].filter(Boolean),
            element("span", { class: "lane-actions" }, [
                groupAction("Start", "start", {
                    variant: "primary",
                    disabled: !info.startable,
                    title: info.startable ? "Run this target now, next to the others; its steps still run one after another" : "Running, done, or waiting for its dependencies",
                }),
                info.running && info.parallel ? groupAction("Stop", "stop", { variant: "danger", title: "Stop this target's running step" }) : null,
                groupAction("Reset", "reset", {
                    disabled: !info.resettable,
                    title: info.resettable ? "Put every step of this target back to pending to run it again" : "Running, or nothing to reset",
                }),
            ]),
        );
    }
};

const updateLock = () => {
    for (const note of lockNotes) {
        note.hidden = snapshot.testsDone !== false;
    }
    document.getElementById("reset-all").disabled = (snapshot.running ?? []).length > 0;
};

const resetAll = () => {
    const kept = (snapshot.resetAllKeeps ?? []).map((id) => snapshot.steps.find((step) => step.id === id)?.title ?? id);
    const message = kept.length
        ? `Reset every step to pending?\n\nKept, because they already left this machine or are what that was based on:\n${kept.join(", ")}`
        : "Reset every step of this release to pending?";
    if (confirm(message)) {
        post("/api/reset-all");
    }
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
    components.setChecked(document.getElementById("setting-alarm"), snapshot.settings.alarmEnabled);
    components.setChecked(document.getElementById("setting-swap"), snapshot.settings.swapFlathubCopy);
    const volume = document.getElementById("setting-volume");
    if (document.activeElement !== volume) {
        volume.value = snapshot.settings.alarmVolume;
    }
    volume.disabled = !snapshot.settings.alarmEnabled;
    soundSelect?.setValue(snapshot.settings.alarmSound);
    soundSelect?.root.toggleAttribute("disabled", !snapshot.settings.alarmEnabled);
    volume.style.setProperty("--fill", `${volume.value}%`);
    document.getElementById("volume-label").textContent = `${volume.value}%`;
    updateSoundHint();
};

const loadSnapshot = async () => {
    snapshot = await (await fetch("/api/state")).json();
    for (const step of snapshot.steps) {
        if (step.state.status !== "running") {
            settledStatus.set(step.id, step.state.status);
        }
    }
    renderAll();
};

const setLive = (live) => {
    document.getElementById("connection").classList.toggle("live", live);
    document.getElementById("offline").hidden = live;
};

const connectEvents = () => {
    const events = new EventSource("/api/events");
    events.onopen = async () => {
        setLive(true);
        logCache.clear();
        await loadSnapshot();
    };
    events.onerror = () => {
        setLive(false);
        // The browser retries by itself unless it gave up (CLOSED), then start over.
        if (events.readyState === EventSource.CLOSED) {
            setTimeout(connectEvents, 3000);
        }
    };
    events.onmessage = async (message) => {
        const event = JSON.parse(message.data);
        if (!snapshot) {
            return;
        }
        if (event.type === "step") {
            const step = snapshot.steps.find((candidate) => candidate.id === event.id);
            step.state = event.step;
            ringFor(step, event.step);
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
            snapshot.groups = fresh.groups;
            snapshot.testsDone = fresh.testsDone;
            snapshot.resetAllKeeps = fresh.resetAllKeeps;
            for (const step of fresh.steps) {
                const existing = snapshot.steps.find((candidate) => candidate.id === step.id);
                existing.command = step.command;
                existing.visible = step.visible;
                existing.runnable = step.runnable;
                updateStep(existing);
            }
            updateGroups();
            updateLock();
            renderHeader();
        } else if (event.type === "auto") {
            snapshot.autoAdvance = event.autoAdvance;
            renderHeader();
        } else if (event.type === "runnable") {
            snapshot.running = event.running;
            snapshot.groups = event.groups;
            snapshot.testsDone = event.testsDone;
            snapshot.resetAllKeeps = event.resetAllKeeps;
            for (const step of snapshot.steps) {
                const runnable = event.runnable[step.id];
                if (step.runnable !== runnable) {
                    step.runnable = runnable;
                    updateStep(step);
                }
            }
            updateGroups();
            updateLock();
        }
    };
};

document.getElementById("run-all").addEventListener("click", () => post("/api/run-all"));
document.getElementById("pause").addEventListener("click", () => post("/api/pause"));
document.getElementById("reset-all").addEventListener("click", resetAll);
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
bindCheckbox("setting-alarm", "alarmEnabled");
bindCheckbox("setting-swap", "swapFlathubCopy");

const volumeSlider = document.getElementById("setting-volume");
volumeSlider.addEventListener("input", () => {
    volumeSlider.style.setProperty("--fill", `${volumeSlider.value}%`);
    document.getElementById("volume-label").textContent = `${volumeSlider.value}%`;
});
volumeSlider.addEventListener("change", () => {
    const volume = Number(volumeSlider.value);
    post("/api/settings", { alarmVolume: volume });
    chime.play(volume, snapshot?.settings.alarmSound);
});

let soundSelect = null;
fetch("/api/sounds")
    .then((response) => response.json())
    .then((sounds) => {
        chime.sounds = sounds;
        soundSelect = components.select({
            label: "sound",
            options: sounds.map((sound) => ({ value: sound.id, label: sound.label })),
            value: snapshot?.settings.alarmSound ?? "chime",
            onChange: (soundId) => {
                post("/api/settings", { alarmSound: soundId });
                chime.play(snapshot?.settings.alarmVolume ?? 20, soundId);
            },
        });
        document.getElementById("sound-select").replaceChildren(soundSelect.root);
        if (snapshot) {
            renderHeader();
        }
    });
for (const type of ["pointerdown", "keydown"]) {
    document.addEventListener(type, () => chime.unlock(), { once: true, capture: true });
}

// The components' light theme hangs off data-theme, follow the system setting like the app's "system" theme.
const lightScheme = window.matchMedia("(prefers-color-scheme: light)");
const applyScheme = () => document.documentElement.setAttribute("data-theme", lightScheme.matches ? "light" : "dark");
lightScheme.addEventListener("change", applyScheme);
applyScheme();

// Safety net for missed events: pull the whole state now and then and redraw what changed.
setInterval(async () => {
    if (!snapshot || document.getElementById("offline").hidden === false) {
        return;
    }
    try {
        const fresh = await (await fetch("/api/state")).json();
        for (const step of fresh.steps) {
            const existing = snapshot.steps.find((candidate) => candidate.id === step.id);
            if (existing && JSON.stringify(existing.state) !== JSON.stringify(step.state)) {
                Object.assign(existing, { state: step.state, runnable: step.runnable, visible: step.visible, command: step.command });
                updateStep(existing);
            }
        }
        Object.assign(snapshot, { data: fresh.data, settings: fresh.settings, groups: fresh.groups, testsDone: fresh.testsDone, resetAllKeeps: fresh.resetAllKeeps, running: fresh.running, autoAdvance: fresh.autoAdvance });
        updateGroups();
        updateLock();
        renderHeader();
    } catch {
        setLive(false);
    }
}, 30000);

setInterval(() => {
    for (const step of snapshot?.steps ?? []) {
        if (step.state.status === "running") {
            elements.get(step.id).head.querySelector(".duration").textContent = formatDuration(step.state);
        }
    }
}, 1000);

connectEvents();
