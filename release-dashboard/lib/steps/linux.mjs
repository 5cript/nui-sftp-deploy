import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

/**
 * The checkout the Windows VM and Mac build: the tag clone, or --source when testing a branch. Returns the directory
 * and the commit the remote copy must be at.
 */
const remoteBuildSource = async (context) => {
    const { config } = context;
    if (config.sourceOverride) {
        context.check("building --source instead of the tag", false, config.sourceOverride, { warn: true });
        return { directory: config.sourceOverride, commit: await context.capture("git", ["-C", config.sourceOverride, "rev-parse", "HEAD"]) };
    }
    return { directory: config.tagCheckout, commit: await context.capture("git", ["-C", config.tagCheckout, "rev-parse", `${config.tag}^{commit}`]) };
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
        // makepkg locks pkg/ (mode 0111) during build() and only unlocks it when packaging, a stopped run leaves it so.
        if (existsSync(directory)) {
            await context.run("chmod", ["-R", "u+rwX", directory], { quiet: true });
        }
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
        const archive = join(directory, `nui-sftp-${config.version}-1-x86_64.pkg.tar.zst`);
        context.check("package written", newerThan(archive, started), archive);
        const binary = join(directory, "pkg", "nui-sftp", "opt", "nui-sftp", "bin", "nui-sftp");
        context.check("package binary", existsSync(binary), binary);
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
    (await context.capture("flatpak", ["list", "--app", "--columns=application,branch,installation,origin"], { allowFailure: true }))
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([application]) => application === flatpakApplication)
        .map(([, branch, installation, origin]) => ({ branch, installation, origin: origin || "flathub" }));

const describeInstalls = (installs) => installs.map(({ branch, installation }) => `${installation} ${branch}`).join(", ");

/**
 * Puts back the copies the swap removed (from their remote, data was kept), whatever the test's result.
 */
const reinstallSwappedCopies = async (context) => {
    const removed = context.data.flatpakRemovedForTest ?? [];
    for (const { branch, installation, origin } of removed) {
        await context.run("flatpak", ["install", `--${installation}`, "-y", "--noninteractive", origin, `${flatpakApplication}//${branch}`], {
            allowFailure: true,
            timeoutMs: 20 * 60 * 1000,
        });
    }
    if (removed.length === 0) {
        return;
    }
    const installed = await installedFlatpaks(context);
    const missing = removed.filter(({ branch, installation }) => !installed.some((entry) => entry.branch === branch && entry.installation === installation));
    context.check("swapped Flathub copy reinstalled", missing.length === 0, missing.length ? `missing: ${describeInstalls(missing)}` : describeInstalls(removed));
    context.setData({ flatpakRemovedForTest: missing });
};

const foreignFlatpaks = async (context) => (await installedFlatpaks(context)).filter(({ branch, installation }) => !(branch === "master" && installation === "user"));

const flatpakConflict = {
    id: "flatpak-conflict",
    phase: "Test",
    lane: "flatpak",
    kind: "manual",
    title: "Flatpak: no other installed copy",
    description: "The test bundle installs as branch master for the user. An installed Flathub copy (stable) shares the app id and its config; uninstall it first (data is kept), it can be reinstalled at the end. With \"swap Flathub copy\" on, this step uninstalls it itself and the smoke test reinstalls it afterwards.",
    needs: ["flatpak-build"],
    command: (context) => {
        const found = context.data.flatpakInstalls ?? [];
        return found.length === 0
            ? "flatpak list --app | grep nui_sftp"
            : found.map(({ branch, installation }) => `flatpak uninstall --${installation} -y ${flatpakApplication}//${branch}`).join(" && ");
    },
    check: async (context) => {
        let found = await foreignFlatpaks(context);
        if (found.length > 0 && context.settings.swapFlathubCopy) {
            const running = await context.capture("flatpak", ["ps", "--columns=application"], { allowFailure: true });
            if (running.split("\n").some((line) => line.trim() === flatpakApplication)) {
                context.check("installed copy not running", false, "close your nui-sftp flatpak, then check again");
                return;
            }
            const removed = [...(context.data.flatpakRemovedForTest ?? [])];
            for (const install of found) {
                const { code } = await context.run(
                    "flatpak",
                    ["uninstall", `--${install.installation}`, "-y", "--noninteractive", `${flatpakApplication}//${install.branch}`],
                    { allowFailure: true, timeoutMs: 5 * 60 * 1000 },
                );
                if (code === 0) {
                    removed.push(install);
                }
            }
            context.setData({ flatpakRemovedForTest: removed });
            found = await foreignFlatpaks(context);
            context.check("swapped out the installed copy (data kept)", found.length === 0, found.length ? `still installed: ${describeInstalls(found)}` : describeInstalls(removed));
            return;
        }
        if (found.length > 0) {
            context.setData({ flatpakInstalls: found });
        }
        context.check("no other nui-sftp flatpak installed", found.length === 0, describeInstalls(found));
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
            await reinstallSwappedCopies(context);
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

/**
 * The name .github/workflows/appimage.yml uploads the AppImage under, its .zsync gets the same plus ".zsync".
 */
const appImageReleaseName = (config) => `nui-sftp-appimage-x86_64_${config.version}.AppImage`;

/**
 * The header fields of a .zsync file, an empty line separates them from the block checksums.
 */
const readZsyncHeader = (path) => {
    const data = readFileSync(path);
    const end = data.indexOf("\n\n");
    const lines = data.subarray(0, end === -1 ? 0 : end).toString("utf8").split("\n");
    return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
};

const globMatches = (pattern, name) =>
    new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name);

const sha1OfFile = async (path) => {
    const hash = createHash("sha1");
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
};

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

const appImageUpdate = {
    id: "appimage-update",
    phase: "Test",
    lane: "appimage",
    kind: "auto",
    title: "AppImage: update information",
    description: "The runtime reports gh-releases-zsync update information that finds the release's .zsync, which matches the AppImage.",
    needs: ["appimage-build"],
    run: async (context) => {
        const { config } = context;
        const appImage = appImagePath(config);
        const releaseName = appImageReleaseName(config);
        // With APPIMAGE_EXTRACT_AND_RUN the runtime hands its own options to the app.
        const result = await context.run("env", ["-u", "APPIMAGE_EXTRACT_AND_RUN", appImage, "--appimage-updateinformation"], { allowFailure: true, quiet: true });
        const output = result.output.trim();
        const reported = result.code === 0 ? output : "";
        const [transport, owner, repository, tag, pattern = ""] = reported.split("|");
        if (context.check("update information embedded", reported !== "", result.code === 0 ? output || "none" : `exit code ${result.code}: ${output}`)) {
            context.check(
                "points at the latest release",
                transport === "gh-releases-zsync" && `${owner}/${repository}` === config.sourceRepository && tag === "latest",
                `${transport} ${owner}/${repository} ${tag}`,
            );
            context.check("pattern finds the release .zsync", globMatches(pattern, `${releaseName}.zsync`), `${pattern} for ${releaseName}.zsync`);
        }

        const zsync = `${appImage}.zsync`;
        context.require(".zsync written after the AppImage", existsSync(zsync) && statSync(zsync).mtimeMs >= statSync(appImage).mtimeMs, zsync);
        const header = readZsyncHeader(zsync);
        context.check(".zsync file name is the release name", header.Filename === releaseName, header.Filename ?? "none");
        context.check(".zsync URL is the release name", header.URL === releaseName, header.URL ?? "none");
        context.check(".zsync length is the AppImage's", Number(header.Length) === statSync(appImage).size, header.Length ?? "none");
        context.check(".zsync SHA-1 is the AppImage's", header["SHA-1"] === (await sha1OfFile(appImage)), header["SHA-1"] ?? "none");
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

export { reinstallSwappedCopies, installedFlatpaks, remoteBuildSource, archBuild, archSmoke, flatpakBuild, flatpakLint, flatpakConflict, flatpakSmoke, docker, appImageBuild, appImageUpdate, appImageSmoke, cmakeLoopWatcher, foreignFlatpaks };
