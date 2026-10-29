import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isPortFree, processesMatching } from "../checks.mjs";
import { sleep } from "../process.mjs";

const expectedReleaseFiles = ["PKGBUILD", "org.nuicpp.nui_sftp.metainfo.xml", "org.nuicpp.nui_sftp.yml", "windows/nui-sftp.iss"];
const optionalReleaseFiles = ["appimage/Dockerfile"];

const releaseCommitSubject = (config) => `Updated to ${config.version}`;

/**
 * The "Updated to X.Y.Z" commit on the release branch, anywhere after main (later commits may sit on top), or null.
 */
const findReleaseCommit = async (context) => {
    const output = await context.capture("git", ["log", "--format=%H %s", "main..HEAD"], { allowFailure: true });
    const line = output.split("\n").find((entry) => entry.slice(41) === releaseCommitSubject(context.config));
    return line ? line.slice(0, 40) : null;
};

const currentBranch = (context) => context.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);

const preflight = {
    id: "preflight",
    phase: "Prepare",
    lane: "prepare",
    kind: "auto",
    title: "Preflight",
    description: "Tools, GitHub login, test host scripts, deploy repo state, free ports, leftover test apps.",
    run: async (context) => {
        const { config } = context;
        const terminal = config.terminal.split(" ")[0];
        for (const tool of ["git", "gh", "bun", "node", "makepkg", "flatpak", "docker", "virsh", "rsync", "ssh", "coredumpctl", terminal]) {
            const { code } = await context.run("bash", ["-c", `command -v ${tool}`], { allowFailure: true, quiet: true });
            context.check(`${tool} installed`, code === 0, "", { warn: tool === terminal });
        }
        const auth = await context.run("gh", ["auth", "status"], { allowFailure: true, quiet: true });
        context.check("gh logged in", auth.code === 0, auth.output.split("\n").find((line) => line.includes("Logged in")) ?? auth.output.trim().split("\n")[0]);
        context.check("Windows VM scripts", existsSync(join(config.windowsScripts, "lib.sh")), config.windowsScripts);
        context.check("Mac scripts", existsSync(join(config.macScripts, "lib.sh")), config.macScripts);
        context.check("persistence.json to copy", existsSync(config.userPersistence), config.userPersistence);

        const branch = await currentBranch(context);
        const releaseBranch = `release/${config.version}`;
        context.check("deploy repo on main or the release branch", branch === "main" || branch === releaseBranch, branch);
        const dirty = await context.capture("git", ["status", "--porcelain", "--untracked-files=no"]);
        const preparedButUncommitted = branch === releaseBranch && !(await findReleaseCommit(context));
        context.check("deploy repo clean", dirty === "" || preparedButUncommitted, dirty.replaceAll("\n", ", "), { warn: preparedButUncommitted });
        await context.run("git", ["fetch", "--quiet", "origin"], { allowFailure: true });
        const ahead = await context.capture("git", ["log", "--oneline", "origin/main..main"]);
        context.check("local main commits that ride along", true, ahead === "" ? "none" : ahead.replaceAll("\n", " | "));

        for (const [name, port] of Object.entries(config.ports)) {
            context.check(`port ${port} (${name}) free`, await isPortFree(port));
        }
        const leftovers = (await processesMatching(context, "nui-sftp")).filter((line) => {
            const executable = line.split(/\s+/)[1] ?? "";
            return executable.startsWith(config.workDirectory) || /\.AppImage$|\.mount_nui/.test(executable);
        });
        context.check("no test app left running", leftovers.length === 0, leftovers.slice(0, 3).join(" | "), { warn: true });
        const flatpaks = await context.capture("flatpak", ["list", "--app", "--columns=application,branch,installation"], { allowFailure: true });
        const installed = flatpaks.split("\n").filter((line) => line.startsWith("org.nuicpp.nui_sftp"));
        context.check("installed nui-sftp flatpaks", true, installed.join(" | ") || "none");
        const stamp = await context.capture("git", ["-C", config.dashboardRoot, "log", "-1", "--format=%h %s"], { allowFailure: true });
        context.log(`dashboard ${stamp}, settings ${JSON.stringify(context.settings)}`);
    },
};

const assets = {
    id: "assets",
    phase: "Prepare",
    lane: "assets",
    kind: "auto",
    title: "Release assets",
    description: "Waits for the frontend tarball and the CEF distribution JSON on the GitHub release (the tag's Arch CI uploads them, 15-30 min).",
    needs: ["preflight"],
    run: async (context) => {
        const { config } = context;
        const wanted = [`nui-sftp-linux-frontend_${config.version}.tar.gz`, `nui-sftp-cef-distribution_${config.version}.json`];
        const deadline = Date.now() + 90 * 60 * 1000;
        let lastReport = "";
        for (;;) {
            const release = await context.run("gh", ["release", "view", config.tag, "-R", config.sourceRepository, "--json", "assets,isDraft,isPrerelease"], {
                allowFailure: true,
                quiet: true,
            });
            if (release.code !== 0) {
                context.require(`release ${config.tag} exists`, false, release.output.trim().split("\n")[0]);
            }
            const view = JSON.parse(release.output);
            const names = view.assets.map((asset) => asset.name);
            const missing = wanted.filter((name) => !names.includes(name));
            if (missing.length === 0) {
                wanted.forEach((name) => context.check(name, true));
                // AppImageUpdate follows the latest release, the last step makes it latest once it has the .zsync.
                context.check("release is a pre-release", view.isPrerelease, view.isPrerelease ? "" : "set the label to Pre-release, AppImageUpdate may find it before its .zsync", { warn: true });
                return { summary: "both assets are on the release" };
            }
            const runs = JSON.parse(
                await context.capture("gh", ["run", "list", "-R", config.sourceRepository, "--branch", config.tag, "--json", "workflowName,status,conclusion,databaseId"]),
            );
            const arch = runs.find((run) => run.workflowName === "Archlinux Build & Frontend");
            const report = runs.map((run) => `${run.workflowName}: ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`).join(", ");
            if (report !== lastReport) {
                context.log(`waiting for ${missing.join(", ")}; ${report || "no runs yet"}`);
                lastReport = report;
            }
            if (arch?.status === "completed" && arch.conclusion !== "success") {
                context.require("Arch CI of the tag", false, `${arch.conclusion}, run ${arch.databaseId}`);
            }
            if (arch?.status === "completed" && arch.conclusion === "success") {
                await sleep(60000, context.signal);
                context.require("assets after a successful Arch CI", false, `still missing ${missing.join(", ")}`);
            }
            if (Date.now() > deadline) {
                context.require("assets within 90 minutes", false, `still missing ${missing.join(", ")}`);
            }
            await sleep(30000, context.signal);
        }
    },
};

const branch = {
    id: "branch",
    phase: "Prepare",
    lane: "prepare",
    kind: "auto",
    title: "Release branch",
    description: "release/X.Y.Z from local main (reused when it exists).",
    needs: ["preflight"],
    run: async (context) => {
        const { config } = context;
        const name = `release/${config.version}`;
        const current = await currentBranch(context);
        if (current === name) {
            context.check(`on ${name}`, true, "already checked out");
            return;
        }
        const dirty = await context.capture("git", ["status", "--porcelain", "--untracked-files=no"]);
        context.require("clean tree before switching", dirty === "", dirty);
        const exists = (await context.run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFailure: true, quiet: true })).code === 0;
        if (exists) {
            await context.run("git", ["checkout", name]);
        } else {
            await context.run("git", ["checkout", "main"]);
            await context.run("git", ["checkout", "-b", name]);
        }
        context.check(`on ${name}`, (await currentBranch(context)) === name, exists ? "existing branch" : "new from main");
    },
};

const prepareRelease = {
    id: "prepare",
    phase: "Prepare",
    lane: "prepare",
    kind: "auto",
    title: "prepare_release.mjs",
    description: "Rewrites PKGBUILD, flatpak manifest, metainfo, Inno Setup script and CEF pins for the tag; clones the tag into checkout/nui-sftp.",
    needs: ["assets", "branch"],
    run: async (context) => {
        const { config } = context;
        const releaseCommit = await findReleaseCommit(context);
        if (releaseCommit) {
            context.check("already committed", true, `${releaseCommit.slice(0, 7)} ${releaseCommitSubject(config)}`);
            await context.run("git", ["-C", config.tagCheckout, "checkout", "--quiet", config.tag]);
            return { summary: "release commit exists, only the tag checkout was updated" };
        }
        if (!existsSync(join(config.deployRoot, "node_modules"))) {
            await context.run("bun", ["install", "--frozen-lockfile"], { timeoutMs: 10 * 60 * 1000 });
        }
        const { output } = await context.run("bun", ["scripts/prepare_release.mjs", "--version", config.version], { timeoutMs: 20 * 60 * 1000 });
        const warnings = output.split("\n").filter((line) => /warn|failed|error/i.test(line));
        context.check("no warnings from the network steps", warnings.length === 0, warnings.slice(0, 5).join(" | "), { warn: true });
    },
};

const releaseFile = (context, path) => readFileSync(join(context.config.deployRoot, path), "utf8");

const diffSanity = {
    id: "diff-sanity",
    phase: "Prepare",
    lane: "prepare",
    kind: "auto",
    title: "Diff sanity",
    description: "Expected files only, frontend hash equal in PKGBUILD/manifest and to the real download, manifest commit is the tag's, metainfo entry dated today, Inno version, flatpak runtime current.",
    needs: ["prepare"],
    run: async (context) => {
        const { config } = context;
        const releaseCommit = await findReleaseCommit(context);
        const changed = (
            await context.capture("git", releaseCommit ? ["diff", "--name-only", `${releaseCommit}~1`, releaseCommit] : ["diff", "--name-only", "HEAD"])
        )
            .split("\n")
            .filter(Boolean);
        if (releaseCommit) {
            const since = await context.capture("git", ["diff", "--name-only", releaseCommit, "--", ...expectedReleaseFiles, ...optionalReleaseFiles]);
            context.check("release files unchanged since the release commit", since === "", since.replaceAll("\n", ", ") || releaseCommit.slice(0, 7), { warn: true });
        }
        const missing = expectedReleaseFiles.filter((file) => !changed.includes(file));
        const unexpected = changed.filter((file) => !expectedReleaseFiles.includes(file) && !optionalReleaseFiles.includes(file));
        context.check("all release files changed", missing.length === 0, missing.length ? `unchanged: ${missing.join(", ")}` : changed.join(", "));
        context.check("no unexpected files changed", unexpected.length === 0, unexpected.join(", "));

        const pkgbuild = releaseFile(context, "PKGBUILD");
        const manifest = releaseFile(context, "org.nuicpp.nui_sftp.yml");
        const metainfo = releaseFile(context, "org.nuicpp.nui_sftp.metainfo.xml");
        const innoSetup = releaseFile(context, "windows/nui-sftp.iss");

        context.check("PKGBUILD pkgver", pkgbuild.includes(`pkgver=${config.version}\n`), pkgbuild.match(/^pkgver=.*$/m)?.[0]);
        context.check("PKGBUILD pkgrel 1", /^pkgrel=1$/m.test(pkgbuild), pkgbuild.match(/^pkgrel=.*$/m)?.[0]);
        const pkgbuildHashes = [...(pkgbuild.match(/sha256sums=\(([\s\S]*?)\)/)?.[1] ?? "").matchAll(/'([0-9a-f]{64}|SKIP)'/g)].map((match) => match[1]);
        const frontendName = `nui-sftp-linux-frontend_${config.version}.tar.gz`;
        const manifestFrontend = manifest.match(new RegExp(`url: (\\S*${frontendName.replaceAll(".", "\\.")})\\s+sha256: ([0-9a-f]{64})`));
        context.check("manifest frontend URL", Boolean(manifestFrontend), manifestFrontend?.[1] ?? `no ${frontendName} source`);
        context.check("frontend sha256 equal in PKGBUILD and manifest", manifestFrontend && pkgbuildHashes[2] === manifestFrontend[2], `${pkgbuildHashes[2]} / ${manifestFrontend?.[2]}`);
        const download = await fetch(`https://github.com/${config.sourceRepository}/releases/download/${config.tag}/${frontendName}`);
        const realHash = download.ok ? createHash("sha256").update(Buffer.from(await download.arrayBuffer())).digest("hex") : `HTTP ${download.status}`;
        context.check("frontend sha256 matches the release asset", realHash === pkgbuildHashes[2], realHash);

        const tagCommit = await context.capture("git", ["-C", config.tagCheckout, "rev-parse", `${config.tag}^{commit}`]);
        const sourceBlock = manifest.match(/url: https:\/\/github\.com\/5cript\/nui-sftp\s+tag: (\S+)\s+commit: ([0-9a-f]{40})/);
        context.check("manifest tag", sourceBlock?.[1] === config.tag, sourceBlock?.[1]);
        context.check("manifest commit is the tag's", sourceBlock?.[2] === tagCommit, `${sourceBlock?.[2]} vs ${tagCommit}`);
        context.check("manifest FORCED_PROJECT_VERSION", manifest.includes(`-DFORCED_PROJECT_VERSION=${config.version}`));

        const today = new Date().toISOString().slice(0, 10);
        const topRelease = metainfo.match(/<release version="([^"]+)" date="([^"]+)"/);
        context.check("metainfo top entry is this version", topRelease?.[1] === config.version, topRelease?.[0]);
        context.check("metainfo entry dated today", topRelease?.[2] === today, `${topRelease?.[2]} (today ${today})`, { warn: true });
        context.check("Inno Setup MyAppVersion", innoSetup.includes(`#define MyAppVersion "${config.version}"`));

        const cefVersion = pkgbuild.match(/^_cefversion=(.*)$/m)?.[1];
        context.check("CEF archive equal in PKGBUILD and manifest", Boolean(cefVersion) && manifest.includes(`cef_binary_${cefVersion}_linux64_minimal.tar.bz2`), cefVersion);

        const runtime = manifest.match(/^runtime-version: '([^']+)'/m)?.[1];
        const remote = await context.capture("flatpak", ["remote-ls", "--user", "flathub", "--all", "--columns=ref"], { allowFailure: true, timeoutMs: 120000 });
        const platformVersions = [...remote.matchAll(/^runtime\/org\.freedesktop\.Platform\/x86_64\/(\d+\.\d+)$/gm)].map((match) => match[1]).sort();
        const newest = platformVersions.at(-1);
        context.check("flatpak runtime is the newest freedesktop Platform", !newest || newest === runtime, `manifest ${runtime}, newest ${newest ?? "unknown"}`, { warn: true });
    },
};

const review = {
    id: "review",
    phase: "Prepare",
    lane: "prepare",
    kind: "review",
    title: "Review and commit",
    description: "Read the diff, then approve: commits \"Updated to X.Y.Z\" on the release branch (local only).",
    actionLabel: "Approve & commit",
    needs: ["diff-sanity"],
    run: async (context) => {
        const { config } = context;
        const releaseCommit = await findReleaseCommit(context);
        if (releaseCommit) {
            context.setData({ reviewDiff: await context.capture("git", ["show", "--stat", "--patch", releaseCommit]) });
            context.check("committed", true, await context.capture("git", ["log", "-1", "--format=%h %s", releaseCommit]));
            return;
        }
        context.setData({ reviewDiff: await context.capture("git", ["diff", "--stat", "--patch", "HEAD"]) });
        return { waiting: true, summary: "waiting for approval" };
    },
    approve: async (context) => {
        const { config } = context;
        await context.run("git", ["add", "-A", "--", ...expectedReleaseFiles, ...optionalReleaseFiles.filter((file) => existsSync(join(config.deployRoot, file)))]);
        await context.run("git", ["commit", "-m", releaseCommitSubject(config)]);
        context.setData({ reviewDiff: await context.capture("git", ["show", "--stat", "--patch", "HEAD"]) });
        context.check("committed", true, await context.capture("git", ["log", "-1", "--format=%h %s"]));
    },
};

const tagCheckout = {
    id: "tag-checkout",
    phase: "Prepare",
    lane: "prepare",
    kind: "auto",
    title: "Tag checkout",
    description: "checkout/nui-sftp at the tag with all submodules; every test builds from it.",
    needs: ["prepare"],
    run: async (context) => {
        const { config } = context;
        const head = await context.capture("git", ["-C", config.tagCheckout, "rev-parse", "HEAD"]);
        const tagCommit = await context.capture("git", ["-C", config.tagCheckout, "rev-parse", `${config.tag}^{commit}`]);
        context.require("checkout at the tag", head === tagCommit, `${head.slice(0, 10)} vs ${config.tag} ${tagCommit.slice(0, 10)}`);
        await context.run("git", ["-C", config.tagCheckout, "submodule", "update", "--init", "--recursive"], { timeoutMs: 30 * 60 * 1000 });
        const dirty = await context.capture("git", ["-C", config.tagCheckout, "status", "--porcelain"]);
        context.check("tag checkout clean", dirty === "", dirty.split("\n").slice(0, 5).join(", "), { warn: true });
    },
};

export { preflight, assets, branch, prepareRelease, diffSanity, review, tagCheckout, releaseCommitSubject };
