#!/bin/bun

import { updatePkgBuild } from "./update_scripts/pkgbuild.mjs";
import { updateRepo } from "./update_scripts/git.mjs";
import { nuiSftpRepoDir, cloneLocation } from "./update_scripts/files_and_dirs.mjs";
import { workDependenciesAsMap } from "./update_scripts/work_dependencies.mjs";
import { checkoutSpecificRef } from './update_scripts/git.mjs'
import { updateReleasesInMetainfoXml, parseMetainfoXml } from "./update_scripts/metainfo.mjs";

const repoUrl = 'https://github.com/5cript/nui-sftp.git';

await updateRepo(repoUrl, nuiSftpRepoDir).catch((err) => {
    console.error('Error updating repository:', err);
    process.exit(1);
});

const workDeps = await workDependenciesAsMap();
// checkout work deps:
for (const [name, { url, rev, branch }] of Object.entries(workDeps)) {
    console.log(`Checking out work dependency ${name} from ${url} at rev ${rev} on branch ${branch}...`);
    await updateRepo(url, `${cloneLocation}/${name}`, rev).catch((err) => {
        console.error(`Error updating repository for work dependency ${name}:`, err);
        process.exit(1);
    });
}

// await updatePkgBuild().catch((err) => {
//     console.error('Error updating PKGBUILD:', err);
//     process.exit(1);
// });

const metainfoXml = parseMetainfoXml();
updateReleasesInMetainfoXml(metainfoXml);

