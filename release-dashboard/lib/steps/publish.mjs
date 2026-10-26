import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foreignFlatpaks, reinstallSwappedCopies } from "./linux.mjs";

const releaseBranch = (config) => `release/${config.version}`;
const flatpakTag = (config) => `flatpak/${config.version}`;
const prTitle = (config) => `Release ${config.version}`;

const remoteRef = async (context, ref, directory = context.config.deployRoot) => {
    const output = await context.capture("git", ["-C", directory, "ls-remote", "origin", ref], { allowFailure: true, timeoutMs: 60000 });
    return output.split("\n").find((line) => line.endsWith(ref))?.split(/\s+/)[0] ?? null;
};

const findPullRequest = async (context, repository, head) => {
    const output = await context.capture("gh", ["pr", "list", "-R", repository, "--head", head, "--state", "all", "--json", "number,url,state,title"]);
    return JSON.parse(output)[0] ?? null;
};

const pushBranch = (testStepIds) => ({
    id: "push-branch",
    irreversible: true,
    phase: "Publish",
    lane: "publish",
    kind: "manual",
    title: "Push the release branch",
    description: "Pushes release/X.Y.Z to the deploy repo (deploy CI runs on release/** pushes).",
    needs: ["review"],
    after: testStepIds,
    command: ({ config }) => `git push -u origin ${releaseBranch(config)}`,
    check: async (context) => {
        const { config } = context;
        const failed = testStepIds.filter((id) => context.otherStep(id).status === "failed");
        context.check("test matrix", failed.length === 0, failed.length ? `failed: ${failed.join(", ")}` : "all passed or skipped", { warn: true });
        const local = await context.capture("git", ["rev-parse", releaseBranch(config)]);
        const remote = await remoteRef(context, `refs/heads/${releaseBranch(config)}`);
        context.check("origin has the release commit", remote === local, remote ? `origin ${remote.slice(0, 10)}, local ${local.slice(0, 10)}` : "not pushed");
    },
});

const deployPullRequest = {
    id: "deploy-pr",
    irreversible: true,
    phase: "Publish",
    lane: "publish",
    kind: "manual",
    title: "Open the deploy PR",
    description: "PR \"Release X.Y.Z\" against main, no description.",
    needs: ["push-branch"],
    command: ({ config }) => `gh pr create -R ${config.deployRepository} --base main --head ${releaseBranch(config)} --title "${prTitle(config)}" --body ""`,
    check: async (context) => {
        const { config } = context;
        const pullRequest = await findPullRequest(context, config.deployRepository, releaseBranch(config));
        if (pullRequest) {
            context.setData({ deployPr: pullRequest });
        }
        context.check("PR exists", Boolean(pullRequest), pullRequest ? `#${pullRequest.number} ${pullRequest.title} (${pullRequest.state})` : "");
    },
};

const deployMerge = {
    id: "deploy-merge",
    irreversible: true,
    phase: "Publish",
    lane: "publish",
    kind: "gate",
    title: "Merge the deploy PR",
    description: "Merge it on GitHub (or let auto-merge do it). Checked again every minute while it waits. The release assets and S3 uploads run after the merge.",
    actionLabel: "Check merge",
    pollIntervalMs: 60000,
    needs: ["deploy-pr"],
    check: async (context) => {
        const { config, data } = context;
        const view = JSON.parse(
            await context.capture("gh", ["pr", "view", String(data.deployPr.number), "-R", config.deployRepository, "--json", "state,mergeCommit,statusCheckRollup,autoMergeRequest,url"]),
        );
        const checks = view.statusCheckRollup ?? [];
        const failing = checks.filter((check) => ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR"].includes(check.conclusion ?? check.state));
        const pending = checks.filter((check) => (check.status && check.status !== "COMPLETED") || check.state === "PENDING");
        context.check("CI", failing.length === 0, `${checks.length} checks, ${pending.length} running, failing: ${failing.map((check) => check.name ?? check.context).join(", ") || "none"}`);
        if (view.state === "MERGED") {
            context.setData({ deployMergeCommit: view.mergeCommit.oid });
        }
        context.check("PR merged", view.state === "MERGED", view.state === "MERGED" ? view.mergeCommit.oid.slice(0, 10) : `${view.state}${view.autoMergeRequest ? ", auto-merge on" : ""}`);
    },
};

const updateMain = {
    id: "main-update",
    phase: "After merge",
    lane: "publish",
    kind: "auto",
    title: "Update local main",
    description: "main moves to the merge commit. A merge commit fast-forwards; a rebase or squash merge rewrote the local \"Submodule Updates\" commit that rode along, then main moves onto origin/main as long as every local commit is upstream as the same patch.",
    needs: ["deploy-merge"],
    run: async (context) => {
        const dirty = await context.capture("git", ["status", "--porcelain", "--untracked-files=no"]);
        context.require("clean tree", dirty === "", dirty);
        await context.run("git", ["checkout", "main"]);
        await context.run("git", ["fetch", "origin", "main"], { timeoutMs: 120000 });
        const fastForward = (await context.run("git", ["merge-base", "--is-ancestor", "main", "origin/main"], { allowFailure: true, quiet: true })).code === 0;
        if (fastForward) {
            await context.run("git", ["merge", "--ff-only", "origin/main"]);
        } else {
            // "-" marks a local commit whose patch is upstream already, "+" one that would be lost.
            const cherry = (await context.capture("git", ["cherry", "-v", "origin/main", "main"])).split("\n").filter(Boolean);
            const unique = cherry.filter((line) => line.startsWith("+"));
            context.require("local main commits are all upstream (rebase or squash merge)", unique.length === 0, unique.join(" | "));
            context.log(`moving main onto origin/main, these local commits are upstream as the same patch: ${cherry.join(" | ")}`);
            await context.run("git", ["reset", "--keep", "origin/main"]);
        }
        await context.run("git", ["submodule", "update", "--init", "release-dashboard/vendor/5cript-nui-components"], { allowFailure: true });
        const head = await context.capture("git", ["rev-parse", "HEAD"]);
        context.require("main is the merge commit", head === context.data.deployMergeCommit, `HEAD ${head.slice(0, 10)}, merge ${context.data.deployMergeCommit?.slice(0, 10)}`);
    },
};

const createFlatpakTag = {
    id: "flatpak-tag",
    phase: "After merge",
    lane: "publish",
    kind: "auto",
    title: "Tag flatpak/X.Y.Z",
    description: "Annotated tag on the merge commit; the Flathub manifest pins it.",
    needs: ["main-update"],
    run: async (context) => {
        const { config } = context;
        const head = await context.capture("git", ["rev-parse", "HEAD"]);
        const existing = (await context.run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${flatpakTag(config)}^{commit}`], { allowFailure: true, quiet: true })).output.trim();
        if (!existing) {
            await context.run("git", ["tag", "-a", flatpakTag(config), "-m", flatpakTag(config)]);
        }
        const tagged = await context.capture("git", ["rev-parse", `${flatpakTag(config)}^{commit}`]);
        context.require("tag on the merge commit", tagged === head, `${tagged.slice(0, 10)} vs HEAD ${head.slice(0, 10)}`);
    },
};

const pushFlatpakTag = {
    id: "push-tag",
    irreversible: true,
    phase: "After merge",
    lane: "publish",
    kind: "manual",
    title: "Push the flatpak tag",
    description: "The Flathub build fetches the deploy repo at this tag.",
    needs: ["flatpak-tag"],
    command: ({ config }) => `git push origin ${flatpakTag(config)}`,
    check: async (context) => {
        const { config } = context;
        const local = await context.capture("git", ["rev-parse", `${flatpakTag(config)}^{commit}`]);
        const remote = await remoteRef(context, `refs/tags/${flatpakTag(config)}^{}`);
        context.check("origin has the tag", remote === local, remote ? remote.slice(0, 10) : "not pushed");
    },
};

const aurCommit = {
    id: "aur-commit",
    phase: "After merge",
    lane: "publish",
    kind: "auto",
    title: "AUR commit",
    description: "scripts/copy_pkgbuild_to_arch.sh: PKGBUILD and .SRCINFO into arch/, commit \"upgpkg: nui-sftp X.Y.Z-1\".",
    needs: ["main-update"],
    run: async (context) => {
        const { config } = context;
        const arch = join(config.deployRoot, "arch");
        await context.run("git", ["-C", arch, "fetch", "origin"], { allowFailure: true, timeoutMs: 120000 });
        const branch = await context.capture("git", ["-C", arch, "rev-parse", "--abbrev-ref", "HEAD"]);
        if (branch !== "master") {
            await context.run("git", ["-C", arch, "checkout", "master"]);
        }
        const behind = await context.capture("git", ["-C", arch, "rev-list", "--count", "master..origin/master"], { allowFailure: true });
        context.require("arch master not behind the AUR", behind === "0" || behind === "", `${behind} commits behind`);
        const subject = await context.capture("git", ["-C", arch, "log", "-1", "--format=%s"]);
        if (subject !== `upgpkg: nui-sftp ${config.version}-1`) {
            await context.run("./scripts/copy_pkgbuild_to_arch.sh");
        }
        const sourceInfo = readFileSync(join(arch, ".SRCINFO"), "utf8");
        context.check(".SRCINFO pkgver", sourceInfo.includes(`pkgver = ${config.version}`), sourceInfo.match(/pkgver = .*/)?.[0]);
        context.check("commit", true, await context.capture("git", ["-C", arch, "log", "-1", "--format=%h %s"]));
    },
};

const aurPush = {
    id: "aur-push",
    irreversible: true,
    phase: "After merge",
    lane: "publish",
    kind: "manual",
    title: "Push to the AUR",
    description: "Pushes arch/ master to aur.archlinux.org. The check compares the AUR's master with the local commit; the AUR RPC's version updates later, a stale one is only a warning.",
    needs: ["aur-commit"],
    command: () => "git -C arch push origin master",
    check: async (context) => {
        const { config } = context;
        const arch = join(config.deployRoot, "arch");
        const local = await context.capture("git", ["-C", arch, "rev-parse", "master"]);
        const remote = await remoteRef(context, "refs/heads/master", arch);
        context.check("AUR master has the upgpkg commit", remote === local, remote ? `AUR ${remote.slice(0, 10)}, local ${local.slice(0, 10)}` : "AUR not reachable");
        try {
            const response = await fetch("https://aur.archlinux.org/rpc/v5/info?arg[]=nui-sftp", { signal: AbortSignal.timeout(20000) });
            const version = (await response.json()).results?.[0]?.Version;
            context.check("AUR RPC reports the new version", version === `${config.version}-1`, version === `${config.version}-1` ? version : `${version} (the RPC lags behind the push)`, { warn: true });
        } catch (error) {
            context.check("AUR RPC reachable", false, error.message, { warn: true });
        }
    },
};

const flathubBranch = {
    id: "flathub-branch",
    phase: "After merge",
    lane: "publish",
    kind: "auto",
    title: "Flathub branch",
    description: "release/X.Y.Z in flathub/ from origin/master, then scripts/copy_manifest_to_flathub.sh (deploy HEAD exactly at the flatpak tag).",
    needs: ["flatpak-tag"],
    run: async (context) => {
        const { config } = context;
        const flathub = join(config.deployRoot, "flathub");
        const head = await context.capture("git", ["rev-parse", "HEAD"]);
        const tagged = await context.capture("git", ["rev-parse", `${flatpakTag(config)}^{commit}`]);
        context.require("deploy HEAD at the flatpak tag", head === tagged);
        await context.run("git", ["-C", flathub, "fetch", "origin"], { timeoutMs: 120000 });
        const exists = (await context.run("git", ["-C", flathub, "rev-parse", "--verify", "--quiet", `refs/heads/${releaseBranch(config)}`], { allowFailure: true, quiet: true })).code === 0;
        await context.run("git", ["-C", flathub, "checkout", ...(exists ? [releaseBranch(config)] : ["-b", releaseBranch(config), "origin/master"])]);
        const subject = await context.capture("git", ["-C", flathub, "log", "-1", "--format=%s"]);
        if (subject !== `Update to ${config.version}`) {
            await context.run("./scripts/copy_manifest_to_flathub.sh");
        }
        const manifest = readFileSync(join(flathub, "org.nuicpp.nui_sftp.yml"), "utf8");
        context.check("manifest pins the flatpak tag", manifest.includes(`tag: ${flatpakTag(config)}`));
        context.check("manifest builds the release tag", manifest.includes(`tag: ${config.tag}`));
        context.check("commit", true, await context.capture("git", ["-C", flathub, "log", "-1", "--format=%h %s"]));
    },
};

const flathubPush = {
    id: "flathub-push",
    irreversible: true,
    phase: "After merge",
    lane: "publish",
    kind: "manual",
    title: "Push the Flathub branch",
    description: "Pushes flathub/ release/X.Y.Z to github.com/flathub/org.nuicpp.nui_sftp.",
    needs: ["flathub-branch", "push-tag"],
    command: ({ config }) => `git -C flathub push -u origin ${releaseBranch(config)}`,
    check: async (context) => {
        const { config } = context;
        const flathub = join(config.deployRoot, "flathub");
        const local = await context.capture("git", ["-C", flathub, "rev-parse", "HEAD"]);
        const remote = await remoteRef(context, `refs/heads/${releaseBranch(config)}`, flathub);
        context.check("origin has the branch", remote === local, remote ? remote.slice(0, 10) : "not pushed");
    },
};

const flathubPullRequest = {
    id: "flathub-pr",
    irreversible: true,
    phase: "After merge",
    lane: "publish",
    kind: "manual",
    title: "Open the Flathub PR",
    description: "PR \"Release X.Y.Z\" against master, no description; Flathub's bot builds it (x86_64 and aarch64).",
    needs: ["flathub-push"],
    command: ({ config }) => `gh pr create -R ${config.flathubRepository} --base master --head ${releaseBranch(config)} --title "${prTitle(config)}" --body ""`,
    check: async (context) => {
        const { config } = context;
        const pullRequest = await findPullRequest(context, config.flathubRepository, releaseBranch(config));
        if (pullRequest) {
            context.setData({ flathubPr: pullRequest });
        }
        context.check("PR exists", Boolean(pullRequest), pullRequest ? `#${pullRequest.number} ${pullRequest.title} (${pullRequest.state})` : "");
    },
};

const submoduleCommit = {
    id: "submodule-commit",
    phase: "After merge",
    lane: "publish",
    kind: "auto",
    title: "Submodule commit on local main",
    description: "\"Submodule Updates from X.Y.Z\" on local main. main is protected: this commit is never pushed, it rides along with the next release PR.",
    needs: ["aur-commit", "flathub-branch"],
    run: async (context) => {
        const { config } = context;
        const subject = `Submodule Updates from ${config.version}`;
        const branch = await context.capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
        context.require("on main", branch === "main", branch);
        if ((await context.capture("git", ["log", "-1", "--format=%s"])) !== subject) {
            await context.run("git", ["add", "arch", "flathub"]);
            await context.run("git", ["commit", "-m", subject]);
        }
        context.check("commit", true, await context.capture("git", ["log", "-1", "--format=%h %s"]));
    },
};

const flathubReinstall = {
    id: "flathub-reinstall",
    phase: "After merge",
    lane: "publish",
    kind: "manual",
    title: "Reinstall your Flathub copy",
    description: "Only shown when the flatpak test asked you to uninstall an installed copy, or a swapped copy could not be put back (its data was kept).",
    needs: ["flatpak-smoke"],
    visible: (data) => (data.flatpakInstalls ?? []).length > 0 || (data.flatpakRemovedForTest ?? []).length > 0,
    command: ({ data }) =>
        [...(data.flatpakInstalls ?? []), ...(data.flatpakRemovedForTest ?? [])]
            .map(({ installation, branch, origin }) => `flatpak install --${installation} -y ${origin ?? "flathub"} org.nuicpp.nui_sftp//${branch ?? "stable"}`)
            .join(" && "),
    check: async (context) => {
        if ((context.data.flatpakRemovedForTest ?? []).length > 0) {
            await reinstallSwappedCopies(context);
            if ((context.data.flatpakInstalls ?? []).length === 0) {
                return;
            }
        }
        const missing = (context.data.flatpakInstalls ?? []).filter(
            ({ branch, installation }) => !context.data.flatpakReinstalled?.some((entry) => entry.branch === branch && entry.installation === installation),
        );
        const installed = await foreignFlatpaks(context);
        context.setData({ flatpakReinstalled: installed });
        const stillMissing = missing.filter(({ branch, installation }) => !installed.some((entry) => entry.branch === branch && entry.installation === installation));
        context.check("installed again", stillMissing.length === 0, stillMissing.map(({ branch, installation }) => `${installation} ${branch}`).join(", "));
    },
};

export {
    pushBranch,
    deployPullRequest,
    deployMerge,
    updateMain,
    createFlatpakTag,
    pushFlatpakTag,
    aurCommit,
    aurPush,
    flathubBranch,
    flathubPush,
    flathubPullRequest,
    submoduleCommit,
    flathubReinstall,
};
