import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";

const gibibyte = 1024 ** 3;

const availableMemoryGiB = () => {
    const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
    return match ? Number(match[1]) / 1024 ** 2 : 0;
};

const freeDiskGiB = (path) => {
    const stats = statfsSync(path);
    return (stats.bavail * stats.bsize) / gibibyte;
};

const isPortFree = (port) =>
    new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });

/**
 * Before a heavy job: enough memory and disk.
 */
const checkHeavyJobResources = async (context, { memoryGiB = 8, diskGiB = 20 } = {}) => {
    const memory = availableMemoryGiB();
    context.require("free memory", memory >= memoryGiB, `${memory.toFixed(1)} GiB available, ${memoryGiB} GiB wanted`);
    const disk = freeDiskGiB(context.config.deployRoot);
    context.require("free disk", disk >= diskGiB, `${disk.toFixed(0)} GiB free, ${diskGiB} GiB wanted`);
    const vm = await context.capture("virsh", ["-c", "qemu:///system", "domstate", "nui-sftp-win11"], { allowFailure: true });
    context.check("Windows VM not running next to a host build", !/running/.test(vm) || context.step.lane === "windows", vm, { warn: true });
};

/**
 * Isolated XDG home with a copy of the user's persistence.json, so test runs never touch ~/.config/nui-sftp.
 */
const prepareTestHome = (context, directory) => {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(join(directory, "config", "nui-sftp"), { recursive: true });
    context.require("user persistence.json exists", existsSync(context.config.userPersistence), context.config.userPersistence);
    copyFileSync(context.config.userPersistence, join(directory, "config", "nui-sftp", "persistence.json"));
    const sessions = Object.keys(JSON.parse(readFileSync(context.config.userPersistence, "utf8")).sessions ?? {});
    context.require(`session ${context.config.testSession} configured`, sessions.includes(context.config.testSession), sessions.join(", "));
    return {
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_STATE_HOME: join(directory, "state"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CACHE_HOME: join(directory, "cache"),
    };
};

/**
 * Coredumps of nui-sftp (or its CEF helpers) since the given ISO time.
 */
const checkCoredumps = async (context, since) => {
    const { output } = await context.run("coredumpctl", ["list", "--no-pager", "--no-legend", "--since", since.replace("T", " ").slice(0, 19)], {
        allowFailure: true,
        quiet: true,
        env: { TZ: "UTC" },
    });
    const dumps = output.split("\n").filter((line) => /nui-sftp|cef|chrom/i.test(line));
    context.check("no coredumps", dumps.length === 0, dumps.join(" | "));
};

/**
 * Processes whose command line contains needle, without matching the probing shell itself.
 */
const processesMatching = async (context, needle) => {
    const output = await context.capture("ps", ["-eo", "pid=,args="]);
    return output
        .split("\n")
        .filter((line) => line.includes(needle) && !line.includes("ps -eo"))
        .map((line) => line.trim());
};

export { availableMemoryGiB, freeDiskGiB, isPortFree, checkHeavyJobResources, prepareTestHome, checkCoredumps, processesMatching };
