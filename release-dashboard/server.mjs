import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { parseConfig } from "./lib/config.mjs";
import { StateStore } from "./lib/state.mjs";
import { Runner } from "./lib/runner.mjs";
import { buildPipeline } from "./lib/pipeline.mjs";
import { shellQuote } from "./lib/process.mjs";
import { availableSounds } from "./lib/sounds.mjs";

const config = parseConfig();
const steps = buildPipeline();
const store = new StateStore(config, steps.map((step) => step.id));
const runner = new Runner(config, store, steps);

// The CSS of 5cript-nui-components (submodule), so the page matches the app's controls.
const componentStyles = join(config.dashboardRoot, "vendor", "5cript-nui-components", "styles");
const componentStaticStyles = join(config.dashboardRoot, "vendor", "5cript-nui-components", "static", "styles");

const sounds = availableSounds();

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".oga": "audio/ogg" };

const sendJson = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
};

const sendFile = (response, path) => {
    if (!existsSync(path)) {
        sendJson(response, 404, { error: "not found" });
        return;
    }
    response.writeHead(200, { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(path).pipe(response);
};

const readBody = (request) =>
    new Promise((resolve) => {
        let body = "";
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                resolve({});
            }
        });
    });

/**
 * Opens the step's command in a terminal window; when the window closes, the step's check runs.
 */
const openTerminal = (step) => {
    const command = step.command(runner.makeContext(step, null));
    const script = `cd ${shellQuote(config.deployRoot)}
printf '\\e[1m%s\\e[0m\\n\\n' ${shellQuote(`$ ${command}`)}
${command}
status=$?
printf '\\nexit code %s. Press Enter to close this window and run the check.' "$status"
read -r _`;
    const [terminal, ...terminalArguments] = config.terminal.split(" ");
    const child = spawn(terminal, [...terminalArguments, "bash", "-lc", script], { detached: true, stdio: "ignore" });
    store.log(step.id, `opened ${terminal}: ${command}`);
    child.on("error", (error) => store.log(step.id, `cannot open the terminal: ${error.message}`));
    child.on("exit", () => {
        store.log(step.id, "terminal closed, checking");
        runner.start(step.id);
    });
    child.unref();
};

const stepAction = async (id, action, response) => {
    const step = runner.stepById.get(id);
    if (!step) {
        sendJson(response, 404, { error: `no step ${id}` });
        return;
    }
    switch (action) {
        case "run":
            sendJson(response, 200, runner.start(id));
            return;
        case "approve":
            sendJson(response, 200, step.approve ? runner.start(id, "approve") : { error: "not a review step" });
            return;
        case "stop":
            runner.stop(id);
            break;
        case "skip":
            runner.skip(id);
            break;
        case "reset":
            runner.reset(id);
            break;
        case "terminal":
            if (!step.command) {
                sendJson(response, 400, { error: "no command" });
                return;
            }
            if (!runner.isRunnable(step)) {
                sendJson(response, 409, { error: "this step cannot run now (locked until the tests ran, or dependencies not met)" });
                return;
            }
            openTerminal(step);
            break;
        default:
            sendJson(response, 404, { error: `unknown action ${action}` });
            return;
    }
    sendJson(response, 200, { ok: true });
};

const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    if (request.method === "POST") {
        // Cross-site pages cannot send this header without a preflight, which is never answered.
        if (request.headers["x-release-dashboard"] !== "1") {
            sendJson(response, 403, { error: "missing header" });
            return;
        }
        const body = await readBody(request);
        const stepMatch = path.match(/^\/api\/steps\/([\w-]+)\/(\w+)$/);
        if (stepMatch) {
            await stepAction(stepMatch[1], stepMatch[2], response);
        } else if (path.match(/^\/api\/groups\/[\w-]+\/(start|reset|stop)$/)) {
            const [, , , group, action] = path.split("/");
            sendJson(response, 200, action === "start" ? runner.startGroup(group) : action === "reset" ? runner.resetGroup(group) : (runner.stopGroup(group), { ok: true }));
        } else if (path === "/api/reset-all") {
            sendJson(response, 200, runner.resetAll());
        } else if (path === "/api/run-all") {
            runner.runAll();
            sendJson(response, 200, { ok: true });
        } else if (path === "/api/pause") {
            runner.pause();
            sendJson(response, 200, { ok: true });
        } else if (path === "/api/stop-all") {
            runner.stopAll();
            sendJson(response, 200, { ok: true });
        } else if (path === "/api/settings") {
            store.setSettings(body);
            sendJson(response, 200, store.state.settings);
        } else {
            sendJson(response, 404, { error: "not found" });
        }
        return;
    }
    if (path === "/api/state") {
        sendJson(response, 200, runner.snapshot());
    } else if (path.startsWith("/api/logs/")) {
        const id = path.slice("/api/logs/".length);
        sendJson(response, 200, { lines: store.logs.get(id) ?? [] });
    } else if (path === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        response.write("retry: 2000\n\n");
        const listener = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20000);
        store.listeners.add(listener);
        request.on("close", () => {
            clearInterval(keepAlive);
            store.listeners.delete(listener);
        });
    } else if (path.startsWith("/components/")) {
        const file = normalize(path.slice("/components/".length));
        const valid = file.endsWith(".css") && !file.includes("..") && !file.startsWith("/");
        // The slider stylesheet only ships in the component repo's static/styles.
        const directory = file === "slider.css" ? componentStaticStyles : componentStyles;
        sendFile(response, valid ? join(directory, file) : "");
    } else if (path === "/api/sounds") {
        sendJson(response, 200, sounds.map(({ id, label }) => ({ id, label, url: id === "chime" ? null : `/sounds/${id}` })));
    } else if (path.startsWith("/sounds/")) {
        const sound = sounds.find((entry) => entry.id === path.slice("/sounds/".length) && entry.path);
        sendFile(response, sound ? sound.path : "");
    } else if (path.startsWith("/screenshots/")) {
        const file = normalize(path.slice("/screenshots/".length));
        sendFile(response, file.includes("/") || file.startsWith(".") ? "" : join(config.screenshotDirectory, file));
    } else {
        const file = path === "/" ? "index.html" : normalize(path.slice(1));
        sendFile(response, file.includes("..") ? "" : join(config.dashboardRoot, "public", file));
    }
});

server.listen(config.port, "127.0.0.1", () => {
    const address = `http://127.0.0.1:${config.port}/`;
    console.log(`nui-sftp ${config.version} release dashboard on ${address}`);
    console.log(`deploy repo ${config.deployRoot}, state ${config.statePath}`);
    // Open pages reconnect within a few seconds after a restart; only open a new one when none did, so restarts do not
    // pile up tabs (each holds a live connection and browsers allow only six per host).
    if (config.openBrowser) {
        setTimeout(() => {
            if (store.listeners.size === 0) {
                spawn("xdg-open", [address], { detached: true, stdio: "ignore" }).unref();
            } else {
                console.log(`${store.listeners.size} open page(s) reconnected, not opening another`);
            }
        }, 4000);
    }
});

const shutdown = () => {
    runner.stopAll();
    setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
