import { CdpPage } from "./cdp.mjs";
import { sleep, waitFor } from "./process.mjs";

const aboutExpression = `(async () => {
    const wait = async (probe) => {
        for (let attempt = 0; attempt < 50; ++attempt) {
            const value = probe();
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
    };
    document.querySelector('button[title="About & Licenses"]')?.click();
    const tab = await wait(() => [...document.querySelectorAll('[data-class="licenses-page-tabs"] .lm-TabBar-tab')]
        .find((element) => element.textContent.trim() === "About"));
    if (!tab) return { error: "About tab not found" };
    tab.click();
    const page = await wait(() => document.querySelector(".licenses-about-page"));
    if (!page) return { error: "About page not found" };
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { version: document.querySelector(".licenses-about-version")?.innerText ?? "", text: page.innerText };
})()`;

const closeAboutExpression = `(() => { document.querySelector(".licenses-close-button")?.click(); return true; })()`;

const terminateExpression = `nui_rpc.backend["Nui::terminate"](), "closing"`;

const fileRowCountExpression = `[...document.querySelectorAll(".nui-file-grid-side")]
    .filter((side) => [...side.querySelectorAll("*")].some((node) => node.children.length === 0 && node.textContent.trim().toLowerCase() === "remote"))
    .flatMap((side) => [...side.querySelectorAll(".nui-file-grid-table-row, .nui-file-grid-item-icons[data-index]")])
    .filter((item) => item.innerText.trim() !== "..").length`;

/**
 * Drives a started app over CDP: About shows the release version, the test session connects through
 * nuiAutomation.connect, the remote file grid lists files, then the app closes through Nui::terminate.
 * target: { port, exitCode: async () => code }, exitCode waits for the app to end. Callers stop a still running app.
 */
const smokeTest = async (context, target) => {
    const { config } = context;
    context.log(`connecting to DevTools on 127.0.0.1:${target.port}`);
    const page = await CdpPage.connect(target.port, { timeoutMs: target.connectTimeoutMs ?? 120000, signal: context.signal });
    let terminated = false;
    try {
        await waitFor(() => page.evaluate(`document.querySelector(".toolbar") !== null`), {
            timeoutMs: 60000,
            message: "the toolbar never appeared",
            signal: context.signal,
        });
        context.check("main window", true, "toolbar rendered");

        const about = await page.evaluate(aboutExpression);
        if (about?.error) {
            context.check("About page", false, about.error);
        } else {
            context.check("About shows the version", about.version.includes(config.version), about.version.trim());
            const engine = about.text.split("\n").filter((line) => /chromium|cef|webview/i.test(line)).join(", ");
            context.check("browser engine listed", engine.length > 0, engine || about.text.slice(0, 200), { warn: true });
            context.screenshot("about", await page.screenshot());
            await page.evaluate(closeAboutExpression);
        }

        const hasHook = await page.evaluate(`typeof globalThis.nuiAutomation?.connect === "function"`);
        context.require("nuiAutomation.connect available", hasHook, hasHook ? "" : "this build has no connect hook (needs nui-sftp with nuiAutomation)");
        const connection = await page.evaluate(`nuiAutomation.connect(${JSON.stringify(config.testSession)})`, 90000);
        context.require(`connects to ${config.testSession}`, connection?.success === true, connection?.info ?? JSON.stringify(connection));

        const rows = await waitFor(() => page.evaluate(fileRowCountExpression), {
            timeoutMs: 45000,
            message: "the remote file grid listed nothing",
            signal: context.signal,
        }).catch(() => 0);
        context.check("lists remote files", rows > 0, `${rows} entries in the remote grid`);
        await sleep(1000, context.signal);
        context.screenshot("connected", await page.screenshot());

        context.log("closing through Nui::terminate");
        terminated = true;
        await page.evaluate(terminateExpression, 5000).catch((error) => context.log(`terminate: ${error.message}`));
    } finally {
        if (!terminated) {
            await page.evaluate(terminateExpression, 5000).catch(() => {});
        }
        page.close();
    }
    const code = await Promise.race([target.exitCode(), sleep(45000, context.signal).then(() => "none within 45 s")]);
    context.check("exit code 0", code === 0 || code === "0", `exit code ${code}`);
};

export { smokeTest };
