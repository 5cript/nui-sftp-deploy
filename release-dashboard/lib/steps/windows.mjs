import { join } from "node:path";
import { smokeTest } from "../smoke.mjs";
import { sleep, waitFor } from "../process.mjs";
import { cmakeLoopWatcher, remoteBuildSource } from "./linux.mjs";

const vmName = "nui-sftp-win11";
const virshUri = "qemu:///system";
const guestRelease = "C:\\nui-sftp-vm\\release";
const programDirectory = "C:\\Program Files\\nui-sftp";

const helper = (config) => join(config.dashboardRoot, "hosts", "windows.sh");

const helperEnvironment = (config) => ({ WINDOWS_SCRIPTS: config.windowsScripts });

const powerShell = (context, script, options = {}) =>
    context.run(helper(context.config), ["ps"], { input: script, env: helperEnvironment(context.config), quiet: true, timeoutMs: 10 * 60 * 1000, ...options });

const powerShellOutput = async (context, script, options = {}) => (await powerShell(context, script, options)).output.trim();

const msys = (context, script, variables = [], options = {}) =>
    context.run(helper(context.config), ["msys", ...variables], { input: script, env: helperEnvironment(context.config), timeoutMs: 60 * 60 * 1000, ...options });

const domainState = async (context) => context.capture("virsh", ["-c", virshUri, "domstate", vmName], { allowFailure: true });

/**
 * Guest clock against the host: the guest keeps local time without w32time, after a DST change it is an hour off
 * and builds loop on "Re-running CMake" (synced files from the future).
 */
const checkClock = async (context) => {
    const offsetSeconds = async () => {
        const guest = Date.parse(await powerShellOutput(context, "[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')"));
        return Math.round((guest - Date.now()) / 1000);
    };
    let offset = await offsetSeconds();
    if (Math.abs(offset) > 30) {
        context.log(`guest clock is ${offset} s off, setting it from the host`);
        await powerShell(context, `Set-Date -Date ([datetime]::Parse('${new Date().toISOString()}').ToUniversalTime().ToLocalTime()) | Out-Null`);
        offset = await offsetSeconds();
    }
    context.require("guest clock within 30 s of the host", Math.abs(offset) <= 30, `${offset} s`);
};

const windowsStart = {
    id: "win-start",
    phase: "Test",
    lane: "windows",
    kind: "auto",
    title: "Windows: start VM",
    description: "Starts nui-sftp-win11 if it is off (it is shut down again at the end), waits for ssh and the desktop, fixes the guest clock, checks disk and leftovers.",
    needs: ["review"],
    after: ["arch-build", "flatpak-build", "appimage-build"],
    run: async (context) => {
        const { config } = context;
        const state = await domainState(context);
        if (context.data.windowsWasRunning === undefined) {
            context.setData({ windowsWasRunning: state === "running" });
        }
        if (state !== "running") {
            await context.run("virsh", ["-c", virshUri, "start", vmName]);
        }
        await waitFor(async () => (await context.capture(helper(config), ["ip"], { env: helperEnvironment(config), allowFailure: true })) !== "", {
            timeoutMs: 4 * 60 * 1000,
            intervalMs: 3000,
            message: "the VM got no IP",
            signal: context.signal,
        });
        await waitFor(async () => (await powerShell(context, "'ready'", { allowFailure: true, timeoutMs: 20000 })).output.includes("ready"), {
            timeoutMs: 4 * 60 * 1000,
            intervalMs: 5000,
            message: "ssh into the VM never worked",
            signal: context.signal,
        });
        context.check("ssh", true);
        await waitFor(async () => (await powerShellOutput(context, "(Get-Process explorer -ErrorAction SilentlyContinue).Count")) !== "0", {
            timeoutMs: 3 * 60 * 1000,
            intervalMs: 5000,
            message: "no desktop session (auto-logon) in the VM",
            signal: context.signal,
        });
        context.check("desktop session", true);
        await checkClock(context);
        const freeGiB = Number(await powerShellOutput(context, "[math]::Round((Get-PSDrive C).Free / 1GB)"));
        context.check("free space on C:", freeGiB >= 20, `${freeGiB} GiB`);
        const running = await powerShellOutput(context, "(Get-Process nui-sftp -ErrorAction SilentlyContinue).Count");
        context.require("no nui-sftp running in the VM", running === "0", `${running} processes`);
        const tasks = await powerShellOutput(context, "(Get-ScheduledTask | Where-Object TaskName -like 'nui-sftp-release*').TaskName -join ','");
        if (tasks) {
            context.log(`removing leftover tasks ${tasks}`);
            await powerShell(context, "Get-ScheduledTask | Where-Object TaskName -like 'nui-sftp-release*' | Unregister-ScheduledTask -Confirm:$false");
        }
    },
};

const windowsBuild = {
    id: "win-build",
    phase: "Test",
    lane: "windows",
    kind: "auto",
    heavy: true,
    title: "Windows: build",
    description: "sync-and-build.sh with the tag checkout: rsync to C:\\src\\nui-sftp, Release build in MSYS2 CLANG64, deploy to build\\install.",
    needs: ["win-start", "tag-checkout"],
    run: async (context) => {
        const { config } = context;
        await checkClock(context);
        const source = await remoteBuildSource(context);
        await context.run(join(config.windowsScripts, "sync-and-build.sh"), [], {
            env: { NUI_SFTP_SRC: source.directory },
            timeoutMs: 4 * 60 * 60 * 1000,
            watchers: [cmakeLoopWatcher],
        });
        const guestHead = (await msys(context, "cd /c/src/nui-sftp && git rev-parse HEAD", [], { quiet: true })).output.trim().split("\n").at(-1);
        context.check("guest source at the expected commit", guestHead === source.commit, guestHead);
        const exists = await powerShellOutput(context, "Test-Path C:\\src\\nui-sftp\\build\\install\\bin\\nui-sftp.exe");
        context.check("nui-sftp.exe deployed", exists === "True");
    },
};

/**
 * Starts nui-sftp.exe in the guest through an interactive task, forwards its DevTools port and runs the smoke test.
 */
const smokeWindows = async (context, binDirectory, name) => {
    const { config } = context;
    const port = config.ports.windows;
    await context.run(helper(config), ["launch", binDirectory, String(port), name], { env: helperEnvironment(config) });
    const sshOptions = (await context.capture(helper(config), ["ssh-options"], { env: helperEnvironment(config) })).split("\n");
    const ip = await context.capture(helper(config), ["ip"], { env: helperEnvironment(config) });
    const tunnel = context.start("ssh", [...sshOptions, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `${port}:127.0.0.1:${port}`, `tester@${ip}`]);
    const exitCode = async () => {
        for (;;) {
            const log = await powerShellOutput(context, `Get-Content -ErrorAction SilentlyContinue ${guestRelease}\\${name}.log`, { allowFailure: true });
            const line = log.split("\n").findLast((entry) => entry.startsWith("nui-sftp exit code "));
            if (line) {
                return Number(line.slice("nui-sftp exit code ".length));
            }
            await sleep(2000, context.signal);
        }
    };
    try {
        await smokeTest(context, { port, exitCode, connectTimeoutMs: 180000 });
    } finally {
        tunnel.kill();
        const remaining = await powerShellOutput(context, "(Get-Process nui-sftp -ErrorAction SilentlyContinue).Count", { allowFailure: true });
        if (remaining !== "0") {
            context.log("nui-sftp still runs in the VM, killing it");
            await powerShell(context, "Stop-Process -Name nui-sftp -Force", { allowFailure: true });
        }
        await context.run(helper(config), ["cleanup", name], { env: helperEnvironment(config), allowFailure: true, quiet: true });
        const log = await powerShellOutput(context, `Get-Content -Tail 15 -ErrorAction SilentlyContinue ${guestRelease}\\${name}.log`, { allowFailure: true });
        if (log) {
            context.log(`guest output (tail):\n${log}`);
        }
    }
};

const windowsSmoke = {
    id: "win-smoke",
    phase: "Test",
    lane: "windows",
    kind: "auto",
    title: "Windows: smoke test (build dir)",
    description: "Runs build\\install\\bin\\nui-sftp.exe on the guest desktop with WebView2's DevTools tunnelled here.",
    needs: ["win-build"],
    run: (context) => smokeWindows(context, "C:\\src\\nui-sftp\\build\\install\\bin", "nui-sftp-release-build"),
};

const installerName = (config) => `nui-sftp-windows-x86_64_${config.version}-setup.exe`;

const windowsInstaller = {
    id: "win-installer",
    phase: "Test",
    lane: "windows",
    kind: "auto",
    title: "Windows: installer",
    description: "Fresh install tree (scripts/deploy.sh into a new directory, build\\install collects stale files), then build_installer.sh with the deploy repo's scripts, windows/ and PKGBUILD.",
    needs: ["win-build"],
    after: ["win-smoke"],
    run: async (context) => {
        const { config } = context;
        await powerShell(context, `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ${guestRelease}\\deploy, ${guestRelease}\\install; New-Item -ItemType Directory ${guestRelease}\\deploy | Out-Null`);
        for (const entry of ["scripts", "windows", "PKGBUILD"]) {
            await context.run(helper(config), ["upload", join(config.deployRoot, entry), "C:/nui-sftp-vm/release/deploy/"], { env: helperEnvironment(config) });
        }
        await msys(
            context,
            [
                "set -euo pipefail",
                "cd /c/src/nui-sftp",
                "INSTALL_TARGET=/c/nui-sftp-vm/release/install BUILD_DIRECTORY=/c/src/nui-sftp/build/clang_release bash scripts/deploy.sh",
                "cd /c/nui-sftp-vm/release/deploy",
                `bash scripts/build_installer.sh --version ${config.version} --source-dir /c/nui-sftp-vm/release/install --output-dir /c/nui-sftp-vm/release/deploy/build`,
            ].join("\n"),
        );
        const size = await powerShellOutput(context, `(Get-Item ${guestRelease}\\deploy\\build\\${installerName(config)}).Length`, { allowFailure: true });
        context.check("installer built", Number(size) > 10 * 1024 * 1024, `${installerName(config)} ${(Number(size) / 1024 ** 2).toFixed(0)} MiB`);
        const stale = await powerShellOutput(context, `(Get-ChildItem ${guestRelease}\\install\\bin -Filter 'command_store.db*').Name -join ','`);
        context.check("no stale files in the install tree", stale === "", stale);
    },
};

const fileListScript = `if (Test-Path '${programDirectory}') { (Get-ChildItem -Recurse -File '${programDirectory}').FullName | Sort-Object } else { '' }`;

const windowsInstalled = {
    id: "win-installed",
    phase: "Test",
    lane: "windows",
    kind: "auto",
    title: "Windows: install, smoke test, uninstall",
    description: "Silent install, per-user assets hidden (icons must come from the package), smoke test, nothing written to Program Files, silent uninstall leaves nothing.",
    needs: ["win-installer"],
    run: async (context) => {
        const { config } = context;
        const before = await powerShellOutput(context, `Test-Path '${programDirectory}'`);
        if (before === "True") {
            const content = await powerShellOutput(context, `(Get-ChildItem '${programDirectory}').Name -join ', '`);
            context.require("Program Files\\nui-sftp absent before installing", false, content);
        }
        await powerShell(
            context,
            `Start-Process -Wait -FilePath '${guestRelease}\\deploy\\build\\${installerName(config)}' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'`,
        );
        context.require("installed", (await powerShellOutput(context, `Test-Path '${programDirectory}\\bin\\nui-sftp.exe'`)) === "True");
        const installedFiles = await powerShellOutput(context, fileListScript);
        const assets = "C:\\Users\\tester\\Documents\\nui-sftp\\assets";
        await powerShell(context, `if (Test-Path '${assets}') { Rename-Item '${assets}' 'assets.release-test-hidden' }`);
        let uninstall = "";
        try {
            await smokeWindows(context, `${programDirectory}\\bin`, "nui-sftp-release-installed");
            const afterRun = await powerShellOutput(context, fileListScript);
            const added = afterRun.split("\n").filter((file) => file && !installedFiles.split("\n").includes(file));
            context.check("nothing written to Program Files", added.length === 0, added.slice(0, 5).join(", "));
        } finally {
            await powerShell(context, `if (Test-Path '${assets}.release-test-hidden') { Rename-Item '${assets}.release-test-hidden' 'assets' }`, { allowFailure: true });
            uninstall = await powerShellOutput(
                context,
                `$uninstaller = Get-ChildItem '${programDirectory}\\unins*.exe' | Sort-Object LastWriteTime | Select-Object -Last 1
Start-Process -Wait -FilePath $uninstaller.FullName -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'
for ($attempt = 0; $attempt -lt 60 -and (Test-Path '${programDirectory}'); ++$attempt) { Start-Sleep 1 }
if (Test-Path '${programDirectory}') { 'left: ' + ((Get-ChildItem -Recurse '${programDirectory}').FullName -join ', ') } else { 'removed' }`,
                { allowFailure: true },
            );
        }
        context.check("uninstall removes everything", uninstall.endsWith("removed"), uninstall);
    },
};

const windowsStop = {
    id: "win-stop",
    phase: "Test",
    lane: "windows",
    kind: "auto",
    title: "Windows: shut down VM",
    description: "Removes the helper tasks; shuts the VM down if it was off before the release run.",
    needs: ["win-start"],
    after: ["win-build", "win-smoke", "win-installer", "win-installed"],
    run: async (context) => {
        await powerShell(context, "Get-ScheduledTask | Where-Object TaskName -like 'nui-sftp-release*' | Unregister-ScheduledTask -Confirm:$false", {
            allowFailure: true,
        });
        if (context.data.windowsWasRunning) {
            return { summary: "left running, it was running before" };
        }
        await context.run("virsh", ["-c", virshUri, "shutdown", vmName]);
        await waitFor(async () => (await domainState(context)) === "shut off", {
            timeoutMs: 5 * 60 * 1000,
            intervalMs: 5000,
            message: "the VM did not shut down within 5 minutes",
            signal: context.signal,
        });
        context.check("VM shut off", true);
    },
};

export { windowsStart, windowsBuild, windowsSmoke, windowsInstaller, windowsInstalled, windowsStop };
