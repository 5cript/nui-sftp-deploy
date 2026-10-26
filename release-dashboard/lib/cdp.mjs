import { sleep } from "./process.mjs";

/**
 * Minimal Chrome DevTools Protocol client for the app's page target (CEF on Linux/macOS, WebView2 on Windows).
 */
class CdpPage {
    static async connect(port, { timeoutMs = 60000, signal } = {}) {
        const deadline = Date.now() + timeoutMs;
        let lastError = "no answer";
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
                const targets = await response.json();
                const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
                if (page) {
                    const instance = new CdpPage(page.webSocketDebuggerUrl);
                    await instance.open();
                    return instance;
                }
                lastError = "no page target yet";
            } catch (error) {
                lastError = error.message;
            }
            await sleep(500, signal);
        }
        throw new Error(`no DevTools page on port ${port}: ${lastError}`);
    }

    constructor(url) {
        this.url = url;
        this.nextId = 1;
        this.pending = new Map();
    }

    open() {
        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.url);
            this.socket.onopen = () => resolve();
            this.socket.onerror = () => reject(new Error(`cannot open ${this.url}`));
            this.socket.onclose = () => {
                for (const { reject: rejectPending } of this.pending.values()) {
                    rejectPending(new Error("DevTools connection closed"));
                }
                this.pending.clear();
            };
            this.socket.onmessage = (event) => {
                const message = JSON.parse(event.data);
                const entry = message.id && this.pending.get(message.id);
                if (entry) {
                    this.pending.delete(message.id);
                    if (message.error) {
                        entry.reject(new Error(`${entry.method}: ${message.error.message}`));
                    } else {
                        entry.resolve(message.result);
                    }
                }
            };
        });
    }

    send(method, params = {}, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    /**
     * Evaluates an expression in the page, awaits promises and returns the value; page exceptions reject.
     */
    async evaluate(expression, timeoutMs = 30000) {
        const reply = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
        if (reply.exceptionDetails) {
            const description = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text;
            throw new Error(`page exception: ${description}`);
        }
        return reply.result?.value;
    }

    async screenshot() {
        const reply = await this.send("Page.captureScreenshot", { format: "png" });
        return Buffer.from(reply.data, "base64");
    }

    close() {
        this.socket?.close();
    }
}

export { CdpPage };
