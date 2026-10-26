import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkCoredumps, checkHeavyJobResources, prepareTestHome, processesMatching } from "../checks.mjs";
import { smokeTest } from "../smoke.mjs";
import { sleep } from "../process.mjs";

const headlessArguments = "--ozone-platform=headless --ozone-override-screen-size=1920,1080";

const cmakeLoopWatcher = {
    pattern: /Re-running CMake|Re-checking globbed directories/,
    limit: 8,
    message: "the build keeps re-running CMake (file mtimes in the future? check the clock)",
};

const appEnvironment = (context, port) => ({
    NUI_CEF_REMOTE_DEBUGGING_PORT: String(port),
    ...(context.settings.headless ? { NUI_CEF_ARGUMENTS: headlessArguments } : {}),
});

/**
 * Runs the smoke test against a locally started process and makes sure it is gone afterwards.
 */
const smokeLocalProcess = async (context, handle, port, exitCodeFromOutput = false) => {
    const exitCode = async () => {
        const code = await handle.exited;
        if (!exitCodeFromOutput) {
            return code;
        }
        const line = handle.lines.findLast((entry) => entry.startsWith("nui-sftp exit code "));
        return line ? Number(line.slice("nui-sftp exit code ".length)) : `wrapper ended with ${code}, no exit code line`;
    };
    try {
        await smokeTest(context, { port, exitCode });
    } finally {
        const ended = await Promise.race([handle.exited.then(() => true), sleep(15000).then(() => false)]);
        if (!ended) {
            context.log("the app still runs, stopping it");
            handle.kill("SIGTERM");
            await Promise.race([handle.exited, sleep(10000)]);
            handle.kill("SIGKILL");
        }
    }
};

const newerThan = (path, isoTime) => existsSync(path) && statSync(path).mtimeMs >= Date.parse(isoTime);

const archDirectory = (config) => join(config.workDirectory, "arch");

const archBuild = {
    id: "arch-build",
    phase: "Test",
    lane: "arch",
    kind: "auto",
    heavy: true,
    title: "Arch: makepkg",
    description: "Builds the committed PKGBUILD in build/release-dashboard/X/arch exactly as AUR users get it (verifysource first).",
    needs: ["review"],
    run: async (context) => {
        const { config } = context;
        await checkHeavyJobResources(context);
        const directory = archDirectory(config);
        rmSync(directory, { recursive: true, force: true });
        mkdirSync(directory, { recursive: true });
        copyFileSync(join(config.deployRoot, "PKGBUILD"), join(directory, "PKGBUILD"));
        const sourceInfo = await context.capture("makepkg", ["--printsrcinfo"], { cwd: directory });
        const dependencies = [...sourceInfo.matchAll(/^\s*(?:make)?depends = (.+)$/gm)].map((match) => match[1]);
        const missing = (await context.run("pacman", ["-T", ...dependencies], { allowFailure: true, quiet: true })).output.trim();
        context.require("build dependencies installed", missing === "", missing ? `sudo pacman -S --needed ${missing.replaceAll("\n", " ")}` : "");
        await context.run("makepkg", ["--verifysource"], { cwd: directory, timeoutMs: 30 * 60 * 1000 });
        context.check("makepkg --verifysource", true);
        const started = new Date().toISOString();
        await context.run("makepkg", ["-f", "--noconfirm"], {
            cwd: directory,
            env: { CMAKE_BUILD_PARALLEL_LEVEL: String(context.settings.buildParallelLevel) },
            timeoutMs: 4 * 60 * 60 * 1000,
            watchers: [cmakeLoopWatcher],
        });
        const binary = join(directory, "pkg", "nui-sftp", "opt", "nui-sftp", "bin", "nui-sftp");
        context.check("package binary built", newerThan(binary, started), binary);
    },
};

const archSmoke = {
    id: "arch-smoke",
    phase: "Test",
    lane: "arch",
    kind: "auto",
    title: "Arch: smoke test",
    description: "Runs the package from pkg/ with an isolated config: About, connect, files, clean exit, no coredumps.",
    needs: ["arch-build"],
    run: async (context) => {
        const { config } = context;
        const port = config.ports.arch;
        const binary = join(archDirectory(config), "pkg", "nui-sftp", "opt", "nui-sftp", "bin", "nui-sftp");
        const environment = prepareTestHome(context, join(config.workDirectory, "arch-home"));
        const started = new Date().toISOString();
        const handle = context.start(binary, ["--enable-dev-tools"], { env: { ...environment, ...appEnvironment(context, port) } });
        await smokeLocalProcess(context, handle, port);
        await checkCoredumps(context, started);
    },
};

const flatpakApplication = "org.nuicpp.nui_sftp";
const flatpakConfig = join(homedir(), ".var", "app", flatpakApplication, "config", "nui-sftp");

const flatpakBuild = {
    id: "flatpak-build",
    phase: "Test",
    lane: "flatpak",
    kind: "auto",
    heavy: true,
    title: "Flatpak: build",
    description: "scripts/build_flatpak.sh: builds the manifest like Flathub (tag and frontend from GitHub), exports build/nui-sftp.flatpak.",
    needs: ["review"],
    after: ["arch-build"],
    run: async (context) => {
        const { config } = context;
        await checkHeavyJobResources(context);
        const started = new Date().toISOString();
        await context.run("./scripts/build_flatpak.sh", [], {
            env: { CMAKE_BUILD_PARALLEL_LEVEL: String(context.settings.buildParallelLevel) },
            timeoutMs: 4 * 60 * 60 * 1000,
            watchers: [cmakeLoopWatcher],
        });
        context.check("bundle exported", newerThan(join(config.deployRoot, "build", "nui-sftp.flatpak"), started), "build/nui-sftp.flatpak");
    },
};

const knownLocalRepoLintErrors = ["appstream-external-screenshot-url", "appstream-screenshots-not-mirrored-in-ostree"];

const flatpakLint = {
    id: "flatpak-lint",
    phase: "Test",
    lane: "flatpak-lint",
    kind: "auto",
    title: "Flatpak: lint",
    description: "flatpak-builder-lint on the manifest (must pass) and the exported repo (screenshot mirroring errors are expected locally).",
    needs: ["flatpak-build"],
    run: async (context) => {
        const lint = ["run", "--command=flatpak-builder-lint", "org.flatpak.Builder", "--exceptions", "--exceptions-repo", "stable"];
        const manifest = await context.run("flatpak", [...lint, "manifest", "org.nuicpp.nui_sftp.yml"], { allowFailure: true });
        context.check("manifest lint", manifest.code === 0, manifest.code === 0 ? "" : manifest.output.trim().slice(0, 400));
        const repository = await context.run("flatpak", [...lint, "repo", "build/flatpak-export"], { allowFailure: true });
        let unexpected = [];
        if (repository.code !== 0) {
            try {
                const report = JSON.parse(repository.output.slice(repository.output.indexOf("{")));
                unexpected = (report.errors ?? []).filter((error) => !knownLocalRepoLintErrors.includes(error));
            } catch {
                unexpected = [repository.output.trim().slice(0, 300)];
            }
        }
        context.check("repo lint (apart from known local screenshot errors)", unexpected.length === 0, unexpected.join(", "), { warn: true });
    },
};

const installedFlatpaks = async (context) =>
    (await context.capture("flatpak", ["list", "--app", "--columns=application,branch,installation"], { allowFailure: true }))
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([application]) => application === flatpakApplication)
        .map(([, branch, installation]) => ({ branch, installation }));

const foreignFlatpaks = async (context) => (await installedFlatpaks(context)).filter(({ branch, installation }) => !(branch === "master" && installation === "user"));

const flatpakConflict = {
    id: "flatpak-conflict",
    phase: "Test",
    lane: "flatpak",
    kind: "manual",
    title: "Flatpak: no other installed copy",
    description: "The test bundle installs as branch master for the user. An installed Flathub copy (stable) shares the app id and its config; uninstall it first (data is kept), it can be reinstalled at the end.",
    needs: ["flatpak-build"],
    command: (context) => {
        const found = context.data.flatpakInstalls ?? [];
        return found.length === 0
            ? "flatpak list --app | grep nui_sftp"
            : found.map(({ branch, installation }) => `flatpak uninstall --${installation} -y ${flatpakApplication}//${branch}`).join(" && ");
    },
    check: async (context) => {
        const found = await foreignFlatpaks(context);
        if (found.length > 0) {
            context.setData({ flatpakInstalls: found });
        }
        context.check("no other nui-sftp flatpak installed", found.length === 0, found.map(({ branch, installation }) => `${installation} ${branch}`).join(", "));
    },
};

const flatpakSmoke = {
    id: "flatpak-smoke",
    phase: "Test",
    lane: "flatpak",
    kind: "auto",
    title: "Flatpak: smoke test",
    description: "Installs the bundle for the user, runs it with a copy of your persistence.json (backed up and restored), smoke test, uninstalls (data kept).",
    needs: ["flatpak-conflict"],
    run: async (context) => {
        const { config } = context;
        const port = config.ports.flatpak;
        const persistence = join(flatpakConfig, "persistence.json");
        const backup = join(config.workDirectory, "flatpak-persistence-backup.json");
        const hadPersistence = existsSync(persistence);
        if (hadPersistence && !existsSync(backup)) {
            copyFileSync(persistence, backup);
        }
        mkdirSync(flatpakConfig, { recursive: true });
        copyFileSync(config.userPersistence, persistence);
        const started = new Date().toISOString();
        try {
            await context.run("flatpak", ["install", "--user", "-y", "--noninteractive", "--reinstall", "build/nui-sftp.flatpak"], { timeoutMs: 15 * 60 * 1000 });
            const environment = Object.entries(appEnvironment(context, port)).map(([key, value]) => `--env=${key}=${value}`);
            const handle = context.start("flatpak", [
                "run",
                ...environment,
                "--command=bash",
                flatpakApplication,
                "-c",
                'nui-sftp --enable-dev-tools; echo "nui-sftp exit code $?"',
            ]);
            await smokeLocalProcess(context, handle, port, true);
        } finally {
            await context.run("flatpak", ["uninstall", "--user", "-y", "--noninteractive", `${flatpakApplication}//master`], { allowFailure: true });
            if (existsSync(backup)) {
                copyFileSync(backup, persistence);
                rmSync(backup);
                context.log("restored the flatpak persistence.json");
            } else if (!hadPersistence) {
                rmSync(persistence, { force: true });
            }
        }
        await checkCoredumps(context, started);
    },
};

const appImagePath = (config) => join(config.deployRoot, "build", `nui-sftp-${config.version}-x86_64.AppImage`);

const docker = {
    id: "docker",
    phase: "Test",
    lane: "appimage",
    kind: "manual",
    title: "AppImage: docker running",
    description: "The AppImage builds in a container. Started automatically when sudo needs no password, otherwise start it in the terminal.",
    command: () => "sudo systemctl start docker",
    check: async (context) => {
        let running = (await context.run("docker", ["info"], { allowFailure: true, quiet: true })).code === 0;
        if (!running && (await context.run("sudo", ["-n", "true"], { allowFailure: true, quiet: true })).code === 0) {
            await context.run("sudo", ["-n", "systemctl", "start", "docker"], { allowFailure: true });
            running = (await context.run("docker", ["info"], { allowFailure: true, quiet: true })).code === 0;
        }
        context.check("docker daemon answers", running);
    },
};

const appImageBuild = {
    id: "appimage-build",
    phase: "Test",
    lane: "appimage",
    kind: "auto",
    heavy: true,
    title: "AppImage: build",
    description: "scripts/build_appimage.sh: the tag and the release frontend inside the Ubuntu builder image.",
    needs: ["review", "docker"],
    after: ["flatpak-build"],
    run: async (context) => {
        const { config } = context;
        await checkHeavyJobResources(context);
        const started = new Date().toISOString();
        await context.run("./scripts/build_appimage.sh", [], { timeoutMs: 3 * 60 * 60 * 1000, watchers: [cmakeLoopWatcher] });
        context.check("AppImage written", newerThan(appImagePath(config), started), appImagePath(config));
    },
};

const appImageSmoke = {
    id: "appimage-smoke",
    phase: "Test",
    lane: "appimage",
    kind: "auto",
    title: "AppImage: smoke test",
    description: "Runs the AppImage with an isolated config; afterwards no FUSE mount or process may be left, no coredumps.",
    needs: ["appimage-build"],
    run: async (context) => {
        const { config } = context;
        const port = config.ports.appimage;
        const environment = prepareTestHome(context, join(config.workDirectory, "appimage-home"));
        const started = new Date().toISOString();
        const handle = context.start(appImagePath(config), ["--enable-dev-tools"], { env: { ...environment, ...appEnvironment(context, port) } });
        await smokeLocalProcess(context, handle, port);
        await sleep(2000, context.signal);
        const mounts = readFileSync("/proc/mounts", "utf8").split("\n").filter((line) => line.includes(".mount_nui"));
        context.check("no FUSE mount left", mounts.length === 0, mounts.join(" | "));
        const processes = await processesMatching(context, ".mount_nui");
        context.check("no AppImage process left", processes.length === 0, processes.slice(0, 3).join(" | "));
        await checkCoredumps(context, started);
    },
};

export { archBuild, archSmoke, flatpakBuild, flatpakLint, flatpakConflict, flatpakSmoke, docker, appImageBuild, appImageSmoke, cmakeLoopWatcher, foreignFlatpaks };
