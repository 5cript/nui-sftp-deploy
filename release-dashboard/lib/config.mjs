import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const dashboardRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Usage: run.sh --version X.Y.Z [options]
  --port <n>            dashboard port on 127.0.0.1 (default 8740)
  --deploy-root <dir>   nui-sftp-deploy checkout to release from (default: the one containing the dashboard)
  --test-vm <dir>       directory with windows/ and macos/ test host scripts (default: <deploy-root>/test-vm)
  --source <dir>        build the Windows VM and Mac targets from this nui-sftp checkout instead of the tag (testing a
                        branch; the Linux packages always build the tag)
  --no-open             do not open the browser`;

const parseConfig = () => {
    const { values } = parseArgs({
        options: {
            version: { type: "string", short: "v" },
            port: { type: "string", default: "8740" },
            "deploy-root": { type: "string" },
            "test-vm": { type: "string" },
            source: { type: "string" },
            "no-open": { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
    });
    if (values.help || !values.version) {
        console.log(usage);
        process.exit(values.help ? 0 : 1);
    }
    if (!/^\d+\.\d+\.\d+$/.test(values.version)) {
        console.error(`not a release version: ${values.version}`);
        process.exit(1);
    }
    const deployRoot = resolve(values["deploy-root"] ?? join(dashboardRoot, ".."));
    const testVm = resolve(values["test-vm"] ?? process.env.RELEASE_DASHBOARD_TEST_VM ?? join(deployRoot, "test-vm"));
    const version = values.version;
    const workDirectory = join(deployRoot, "build", "release-dashboard", version);
    return {
        version,
        tag: `v${version}`,
        port: Number(values.port),
        openBrowser: !values["no-open"],
        dashboardRoot,
        deployRoot,
        testVm,
        windowsScripts: join(testVm, "windows"),
        macScripts: join(testVm, "macos"),
        workDirectory,
        logDirectory: join(workDirectory, "logs"),
        screenshotDirectory: join(workDirectory, "screenshots"),
        statePath: join(workDirectory, "state.json"),
        tagCheckout: join(deployRoot, "checkout", "nui-sftp"),
        sourceOverride: values.source ? resolve(values.source) : null,
        workCheckout: resolve(process.env.RELEASE_DASHBOARD_NUI_SFTP ?? join(dashboardRoot, "..", "..", "nui-sftp")),
        userPersistence: join(homedir(), ".config", "nui-sftp", "persistence.json"),
        testSession: process.env.RELEASE_DASHBOARD_SESSION ?? "sftp-container",
        sourceRepository: "5cript/nui-sftp",
        deployRepository: "5cript/nui-sftp-deploy",
        flathubRepository: "flathub/org.nuicpp.nui_sftp",
        terminal: process.env.RELEASE_DASHBOARD_TERMINAL ?? "konsole -e",
        ports: { arch: 9401, flatpak: 9402, appimage: 9403, mac: 9404, windows: 9405 },
    };
};

export { parseConfig };
