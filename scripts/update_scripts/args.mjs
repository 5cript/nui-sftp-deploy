import { parseArgs } from "node:util";
import { getReleases } from "./github.mjs";

let {
    values: { version }
} = parseArgs({
    args: Bun.argv,
    options: {
        version: {
            type: 'string',
            short: 'v',
            description: 'New version to set in PKGBUILD'
        }
    },
    strict: true,
    allowPositionals: true
});

if (!version) {
    const releases = await getReleases('5cript/nui-sftp');
    if (releases.length === 0) {
        console.error('No releases found for 5cript/nui-sftp');
        process.exit(1);
    }
    const latestRelease = releases[0];
    console.log(`No version specified, using latest release: ${latestRelease.tag_name}`);
    version = latestRelease.tag_name;
}

export { version };