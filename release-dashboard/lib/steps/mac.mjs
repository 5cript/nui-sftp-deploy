import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { smokeTest } from "../smoke.mjs";
import { sleep } from "../process.mjs";
import { cmakeLoopWatcher, remoteBuildSource } from "./linux.mjs";

const testState = "$HOME/nui-release-test-state";
const testLog = "/tmp/nui-sftp-release-test.log";
const tunnelPort = 15000;

/**
 * Runs a bash script (stdin) on the Mac through test-vm/macos/lib.sh's mac_ssh.
 */
const macShell = (context, script, options = {}) =>
    context.run("bash", ["-c", `source "${context.config.macScripts}/lib.sh"; mac_ssh 'bash -s'`], {
        input: script,
        quiet: true,
        timeoutMs: 5 * 60 * 1000,
        ...options,
    });

const macOutput = async (context, script, options = {}) => (await macShell(context, script, options)).output.trim();

const idleSeconds = async (context) => Number(await macOutput(context, `ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'`));

const crashReportCount = async (context) =>
    Number(await macOutput(context, "ls ~/Library/Logs/DiagnosticReports/nui-sftp-*.ips 2>/dev/null | wc -l | tr -d ' '"));

const macWake = {
    id: "mac-wake",
    phase: "Test",
    lane: "mac",
    kind: "auto",
    title: "Mac: wake",
    description: "Wake-on-LAN, then ssh; someone must be logged in at the Mac (automatic login). Warns when the Mac is in use.",
    needs: ["review"],
    run: async (context) => {
        const { config } = context;
        const reachable = (await context.run("bash", ["-c", `source "${config.macScripts}/lib.sh"; mac_reachable`], { allowFailure: true, quiet: true })).code === 0;
        if (context.data.macWasAwake === undefined) {
            context.setData({ macWasAwake: reachable });
        }
        await context.run(join(config.macScripts, "wake.sh"), ["180"]);
        const user = await context.capture("bash", ["-c", `source "${config.macScripts}/lib.sh"; echo "$MAC_USER"`]);
        const consoleUser = await macOutput(context, "stat -f %Su /dev/console");
        context.require("logged in at the Mac", consoleUser === user, `console belongs to ${consoleUser}`);
        const idle = await idleSeconds(context);
        context.check("nobody using the Mac", idle >= 120, `last input ${idle} s ago`, { warn: true });
    },
};

/**
 * Hash of a file in the given revision of a local repository, or of its working tree file when revision is null.
 */
const localHash = async (context, repository, revision, path) => {
    if (revision === null) {
        const file = join(repository, path);
        return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
    }
    const { code, output } = await context.run("bash", ["-c", `git -C "$0" show "$1:$2" | sha256sum`, repository, revision, path], { allowFailure: true, quiet: true });
    return code === 0 ? output.split(" ")[0] : null;
};

const macResidue = {
    id: "mac-residue",
    phase: "Test",
    lane: "mac",
    kind: "auto",
    title: "Mac: local changes",
    description: "The user also works in ~/src/nui-sftp on the Mac. Changed files that equal a recent commit (or the working tree) of the local checkout are sync residue and get overwritten; anything else fails here (Skip to overwrite anyway).",
    needs: ["mac-wake"],
    run: async (context) => {
        const status = await macOutput(context, "cd ~/src/nui-sftp 2>/dev/null && git status --porcelain --untracked-files=all || true");
        const paths = status
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(3).replace(/^.* -> /, ""))
            .filter((path) => !path.startsWith("dependencies/5cript-nui-components"));
        if (paths.length === 0) {
            context.check("no local changes", true);
            return;
        }
        const hashes = await macOutput(context, `cd ~/src/nui-sftp && for file in ${paths.map((path) => context.quote(path)).join(" ")}; do [ -f "$file" ] && shasum -a 256 "$file"; done; true`);
        const remoteHashes = new Map(hashes.split("\n").filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]));
        const repository = context.config.workCheckout;
        const recent = await context.capture("git", ["-C", repository, "log", "--all", "-n", "40", "--format=%H"]);
        const tags = await context.capture("git", ["-C", repository, "tag", "--sort=-creatordate"]);
        const revisions = [...recent.split("\n"), ...tags.split("\n").slice(0, 5)];
        const unknown = [];
        for (const path of paths) {
            const remote = remoteHashes.get(path);
            if (!remote) {
                continue;
            }
            let known = (await localHash(context, repository, null, path)) === remote;
            for (const revision of revisions) {
                if (known) {
                    break;
                }
                known = (await localHash(context, repository, revision, path)) === remote;
            }
            if (!known) {
                unknown.push(path);
            }
        }
        context.check("changes are sync residue", unknown.length === 0, unknown.length ? `unknown: ${unknown.join(", ")}` : `${paths.length} residue files`);
    },
};

const macBuild = {
    id: "mac-build",
    phase: "Test",
    lane: "mac",
    kind: "auto",
    title: "Mac: build",
    description: "sync-and-build.sh with the tag checkout: rsync to ~/src/nui-sftp, Release build and bundle on the Mac (remote, runs next to a local build).",
    needs: ["mac-residue", "tag-checkout"],
    run: async (context) => {
        const { config } = context;
        const source = await remoteBuildSource(context);
        await context.run(join(config.macScripts, "sync-and-build.sh"), [], {
            env: { NUI_SFTP_SRC: source.directory },
            timeoutMs: 4 * 60 * 60 * 1000,
            watchers: [cmakeLoopWatcher],
        });
        const head = await macOutput(context, "git -C ~/src/nui-sftp rev-parse HEAD");
        context.check("Mac source at the expected commit", head === source.commit, head);
        const bundle = await macOutput(context, "test -x ~/src/nui-sftp/build/install/nui-sftp.app/Contents/MacOS/nui-sftp && echo yes || echo no");
        context.check("bundle deployed", bundle === "yes");
    },
};

/**
 * Test profile on the Mac: only the test session, connecting through the reverse tunnel on the Mac's loopback, so a
 * freshly signed bundle needs no Local Network permission. Prints the session's real host:port.
 */
const profileScript = (session) => `set -e
mkdir -p ${testState}/config/nui-sftp ${testState}/state ${testState}/cache
python3 - <<'PY'
import json, os
source = os.path.expanduser("~/Library/Application Support/nui-sftp/persistence.json")
data = json.load(open(source))
session = data["sessions"][${JSON.stringify(session)}]
print(f'{session["engine"]["host"]}:{session["engine"].get("port", 22)}')
session["engine"]["host"] = "127.0.0.1"
session["engine"]["port"] = ${tunnelPort}
session["startupSession"] = False
data["sessions"] = {${JSON.stringify(session)}: session}
json.dump(data, open(os.path.expanduser("~/nui-release-test-state/config/nui-sftp/persistence.json"), "w"), indent=2)
PY
`;

const launchScript = (port) => `set -e
binary=$HOME/src/nui-sftp/build/install/nui-sftp.app/Contents/MacOS/nui-sftp
rm -f ${testLog}
sudo -n launchctl asuser $(id -u) sudo -n -u $(id -un) /usr/bin/env \\
    XDG_CONFIG_HOME=${testState}/config XDG_STATE_HOME=${testState}/state XDG_CACHE_HOME=${testState}/cache \\
    NUI_CEF_REMOTE_DEBUGGING_PORT=${port} \\
    /bin/bash -c "\\"$binary\\" --enable-dev-tools >${testLog} 2>&1 </dev/null; echo \\"nui-sftp exit code \\$?\\" >>${testLog}" </dev/null >/dev/null 2>&1 &
echo started
`;

const macSmoke = {
    id: "mac-smoke",
    phase: "Test",
    lane: "mac",
    kind: "auto",
    title: "Mac: smoke test",
    description: "Starts the bundle in the Mac's GUI session with a test profile, DevTools and the test server tunnelled over ssh; no new crash reports afterwards.",
    needs: ["mac-build"],
    run: async (context) => {
        const { config } = context;
        const port = config.ports.mac;
        const running = await macOutput(context, "pgrep -x nui-sftp >/dev/null && echo yes || echo no");
        context.require("no nui-sftp running on the Mac", running === "no");
        const crashesBefore = await crashReportCount(context);
        const target = (await macOutput(context, profileScript(config.testSession))).split("\n").at(-1);
        context.check("test profile", /^[^:]+:\d+$/.test(target), `${config.testSession} via 127.0.0.1:${tunnelPort} -> ${target}`);
        await macShell(context, launchScript(port));
        const sshOptions = (await context.capture("bash", ["-c", `source "${config.macScripts}/lib.sh"; printf '%s\\n' "\${SSH_OPTS[@]}"; echo "$MAC_USER@$MAC_HOST"`])).split("\n");
        const destination = sshOptions.pop();
        const tunnel = context.start("ssh", [...sshOptions, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `${port}:127.0.0.1:${port}`, "-R", `${tunnelPort}:${target}`, destination]);
        const exitCode = async () => {
            for (;;) {
                const line = await macOutput(context, `grep '^nui-sftp exit code ' ${testLog} | tail -n 1`, { allowFailure: true });
                if (line) {
                    return Number(line.slice("nui-sftp exit code ".length));
                }
                await sleep(2000, context.signal);
            }
        };
        try {
            await smokeTest(context, { port, exitCode, connectTimeoutMs: 120000 });
        } finally {
            tunnel.kill();
            const left = await macOutput(context, "pgrep -x nui-sftp >/dev/null && echo yes || echo no", { allowFailure: true });
            if (left === "yes") {
                context.log("nui-sftp still runs on the Mac, killing it");
                await macShell(context, "pkill -x nui-sftp || true", { allowFailure: true });
            }
        }
        await sleep(5000, context.signal);
        const crashesAfter = await crashReportCount(context);
        context.check("no new crash reports", crashesAfter === crashesBefore, `${crashesBefore} before, ${crashesAfter} after`);
    },
};

const macSleep = {
    id: "mac-sleep",
    phase: "Test",
    lane: "mac",
    kind: "auto",
    title: "Mac: sleep",
    description: "Puts the Mac back to sleep if it was asleep before, nobody used it in the last 2 minutes and \"keep the Mac awake\" is off. Never shuts it down.",
    needs: ["mac-wake"],
    after: ["mac-residue", "mac-build", "mac-smoke"],
    run: async (context) => {
        if (context.settings.keepMacAwake) {
            return { summary: "left awake (setting)" };
        }
        if (context.data.macWasAwake) {
            return { summary: "left awake, it was awake before" };
        }
        const idle = await idleSeconds(context);
        if (idle < 120) {
            return { summary: `left awake, last input ${idle} s ago`, warning: true };
        }
        await context.run(join(context.config.macScripts, "sleep.sh"));
        context.check("sent to sleep", true);
    },
};

export { macWake, macResidue, macBuild, macSmoke, macSleep };
