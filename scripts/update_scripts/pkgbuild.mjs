import { spawn, spawnSync } from 'node:child_process';
import { parsedVersion } from './version.mjs';
import { pkgbuildPath, cloneLocation } from './files_and_dirs.mjs';
import { splitLines, onLineMatchingModify, findLineIndexMatching } from './text_editing.mjs';
import { workDependenciesAsMap } from './work_dependencies.mjs';

import fs from 'node:fs/promises';
import fsOld from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function calcChecksumGit(url, checkoutDir, integ) {
    return new Promise((resolve, reject) => {
        const hashIndex = url.indexOf("#");
        if (hashIndex === -1) {
            return resolve({ sum: "SKIP", ret: 0 });
        }

        const fragment = url.slice(hashIndex + 1);
        const [key, value] = fragment.split("=", 2);

        if (key !== "tag" && key !== "commit") {
            return resolve({ sum: "SKIP", ret: 0 });
        }

        const tmpFile = path.join(
            os.tmpdir(),
            `git-archive-${process.pid}-${Date.now()}.tar`
        );

        const out = fsOld.createWriteStream(tmpFile);

        const git = spawn("git", [
            "-c", "core.abbrev=no",
            "-C", checkoutDir,
            "archive",
            "--format=tar",
            value
        ]);

        git.stdout.pipe(out);
        git.stderr.pipe(process.stderr);

        git.on("error", reject);

        git.on("close", (code) => {
            if (code !== 0) {
                fs.unlink(tmpFile, () => { });
                return resolve({ sum: "SKIP", ret: 1 });
            }

            // Now hash the tar file
            const hash = spawn(`${integ}sum`, [tmpFile]);

            let output = "";

            hash.stdout.on("data", (d) => {
                output += d.toString("utf8");
            });

            hash.stderr.pipe(process.stderr);

            hash.on("close", (hashCode) => {
                fs.unlink(tmpFile, () => { });

                if (hashCode !== 0) {
                    return resolve({ sum: "SKIP", ret: 1 });
                }

                const sum = output.trim().split(/\s+/)[0];
                resolve({ sum, ret: 0 });
            });
        });
    });
}

const extractSources = (lines) => {
    const sourceLineIndex = lines.findIndex(line => line.startsWith('source='));
    if (sourceLineIndex === -1) {
        throw new Error('No source line found in PKGBUILD');
    }
    const sha256sumsLineIndex = lines.findIndex(line => line.startsWith('sha256sums='));
    if (sha256sumsLineIndex === -1) {
        throw new Error('No sha256sums line found in PKGBUILD');
    }
    /*
    source=(
        "$pkgname::git+$url.git#tag=$pkgver"
        "git+https://github.com/NuiCpp/Nui.git#commit=96e87184cd48fe0dfa1bf9c187a49842a36b96f7"
        "git+https://github.com/5cript/roar.git#commit=a787bce9c8132f4c860bc9e55bff742fd1a3276f"
        "git+https://github.com/DNKpp/gimo.git#commit=16377a6d496b31a9272f9a079c060fba15258bcc"
        "git+https://github.com/NuiCpp/traits.git#commit=6c9caa21c48c9e1f7f039a7bdf8805a0940fce0a"
        "git+https://github.com/NuiCpp/ui5.git#commit=a514318f9110f7e77574abd283ef0c5ecf634f40"
        "git+https://github.com/5cript/5cript-nui-components.git#commit=fb33b5f751eed174b930329fbecf52138e63c0cf"
    )
    sha256sum=(
        'SKIP'
        'SKIP'
        ...
    )
    */
    for (let i = sourceLineIndex + 1; i < lines.length; i++) {
        if (lines[i].trim() === ')') {
            const sources = lines.slice(sourceLineIndex + 1, i).map(line => line.trim().replace(/"/g, '')).map((line, index) => {
                let name = '';
                if (line.indexOf('::') !== -1) {
                    const parts = line.split('::');
                    name = parts[0];
                    line = parts[1];
                } else {
                    // get name from url if it is in the form git+
                    const urlStartIndex = line.indexOf('git+');
                    if (urlStartIndex !== -1) {
                        const urlEndIndex = line.indexOf('#');
                        const url = line.substring(urlStartIndex, urlEndIndex);
                        const urlParts = url.split('/');
                        name = urlParts[urlParts.length - 1].replace('.git', '');
                    }
                }
                const protocolEndIndex = line.indexOf('+');
                const urlEndIndex = line.indexOf('#');
                const protocol = line.substring(0, protocolEndIndex);
                const url = line.substring(protocolEndIndex + 1, urlEndIndex);
                const refTypeAndValue = line.substring(urlEndIndex + 1);
                const [refType, refValue] = refTypeAndValue.split('=');
                return {
                    name,
                    protocol,
                    url,
                    lineIndex: sourceLineIndex + 1 + index,
                    refType,
                    refValue,
                    sha256sumLine: sha256sumsLineIndex + 1 + index
                }
            })
            return sources;
        }
    }
    return sources;
}

const looksLikeGitHash = (str) => /^[0-9a-f]{40}$/.test(str);

const joinSourcesWithWorkDependenciesByUrl = async (sources) => {
    const workDependenciesMap = await workDependenciesAsMap();
    return sources.map(source => {
        const matchingWorkDependency = Object.values(workDependenciesMap).find(workDependency => workDependency.url === source.url);
        if (matchingWorkDependency) {
            let newType = source.refType;
            let newRef = source.refValue;
            if (looksLikeGitHash(matchingWorkDependency.rev))
            {
                newType = 'commit';
                newRef = matchingWorkDependency.rev;
            }
            else
            {
                newType = 'tag';
                newRef = matchingWorkDependency.rev;
            }

            return {
                ...source,
                newRefType: newType,
                newRefValue: newRef,
                urlWithFragment: `${source.url}#${newType}=${newRef}`
            }
        }
        return source;
    });
}

const reassembleSourceLine = (source) => {
    const namePart = source.name ? `${source.name}::` : '';
    return `    "${namePart}${source.protocol}+${source.urlWithFragment}"`;
}

const updatePkgBuild = async () => {
    console.log(`Updating PKGBUILD at ${pkgbuildPath}...`);

    const version = parsedVersion();
    let pkgbuildLines = splitLines(await fs.readFile(pkgbuildPath, 'utf-8'));
        pkgbuildLines = onLineMatchingModify(pkgbuildLines, /^pkgver=(.+)$/, (line, match) => {
        const oldVersion = match[1];
        const newVersion = version.dehyphenated;

        console.log(`Updating version from ${oldVersion} to ${newVersion}...`);
        return `pkgver=${newVersion}`;
    });

    const pkgverLineIndex = findLineIndexMatching(pkgbuildLines, /^pkgver=(.+)$/);
    if (pkgverLineIndex.lineIndex === -1) {
        throw new Error('No pkgver line found in PKGBUILD');
    }
    const oldPkgver = pkgverLineIndex.match[1];
    console.log(`Current pkgver in PKGBUILD: ${oldPkgver}`);

    const joined = await joinSourcesWithWorkDependenciesByUrl(extractSources(pkgbuildLines));
    // Update sources:
    for (let source of joined) {
        if (source.name == '$pkgname') {
            source.name = 'nui-sftp',
            source.url = 'git+https://github.com/5cript/nui-sftp.git',
            source.urlWithFragment = `git+https://github.com/5cript/nui-sftp.git#tag=${version.tag}`;
            source.isMainPackage = true;
        }
        const revisionChanged = source.refType !== source.newRefType || source.refValue !== source.newRefValue;

        if (!source.isMainPackage) {
            if (source.newRefType && source.newRefValue) {
                const oldLine = pkgbuildLines[source.lineIndex];
                const newLine = reassembleSourceLine(source);
                if (revisionChanged) {
                    console.log(`Updating source line from:\n${oldLine}\nto:\n${newLine}`);
                    pkgbuildLines[source.lineIndex] = newLine;
                }
            } else {
                throw new Error(`No matching work dependency found for source URL: ${source.url}`);
            }
        }

        if (revisionChanged || pkgbuildLines[source.sha256sumLine].includes('SKIP')) {
            const {sum, ret} = await calcChecksumGit(source.urlWithFragment, `${cloneLocation}/${source.name}`, 'sha256');
            if (ret !== 0) {
                throw new Error(`Error calculating checksum for ${source.url}`);
            }
            console.log(`Updating sha256sum for ${source.name} to ${sum}...`);
            pkgbuildLines[source.sha256sumLine] = `    '${sum}'`;
        }
    }
    await fs.writeFile(pkgbuildPath, pkgbuildLines.join('\n'), 'utf-8');

    console.log('PKGBUILD updated successfully.');
}

export { updatePkgBuild };