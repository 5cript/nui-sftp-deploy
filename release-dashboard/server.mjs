import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { parseConfig } from "./lib/config.mjs";
import { StateStore } from "./lib/state.mjs";
import { Runner } from "./lib/runner.mjs";
import { buildPipeline } from "./lib/pipeline.mjs";
import { shellQuote } from "./lib/process.mjs";

const config = parseConfig();
const steps = buildPipeline();
const store = new StateStore(config, steps.map((step) => step.id));
const runner = new Runner(config, store, steps);

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

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
    if (config.openBrowser) {
        spawn("xdg-open", [address], { detached: true, stdio: "ignore" }).unref();
    }
});

const shutdown = () => {
    runner.stopAll();
    setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
