import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { parsedVersion } from './version.mjs';
import { pkgbuildPath, cloneLocation } from './files_and_dirs.mjs';
import { splitLines, onLineMatchingModify, findLineIndexMatching } from './text_editing.mjs';
import { workDependenciesAsMap } from './work_dependencies.mjs';
import { looksLikeGitHash } from './git.mjs';

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

async function calcChecksumHttp(url, integ) {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
        }

        const hash = spawn(`${integ}sum`, [], { stdio: ['pipe', 'pipe', 'inherit'] });
        Readable.fromWeb(res.body).pipe(hash.stdin);

        let output = "";
        hash.stdout.on("data", (d) => {
            output += d.toString("utf8");
        });

        return new Promise((resolve, reject) => {
            hash.on("close", (code) => {
                if (code !== 0) {
                    return reject(new Error(`Hash process exited with code ${code}`));
                }
                const sum = output.trim().split(/\s+/)[0];
                resolve(sum);
            });
        });
    } catch (err) {
        console.error(`Error fetching ${url}:`, err);
    }
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

    for (let i = sourceLineIndex + 1; i < lines.length; i++) {
        if (lines[i].trim() === ')') {
            const sources = lines.slice(sourceLineIndex + 1, i).map(line => line.trim().replace(/"/g, '')).map((line, index) => {
                let name = '';
                let isGitLink = false;
                let hadNamePrefix = false;
                if (line.startsWith('git+')) {
                    isGitLink = true;
                }
                if (line.indexOf('::') !== -1) {
                    const parts = line.split('::');
                    name = parts[0];
                    hadNamePrefix = true;
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
                if (isGitLink) {
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
                        sha256sumLine: sha256sumsLineIndex + 1 + index,
                        isGitLink,
                        hadNamePrefix
                    }
                } else {
                    return {
                        name,
                        protocol: line.startsWith("https") ? "https" : null,
                        url: line,
                        lineIndex: sourceLineIndex + 1 + index,
                        refType: null,
                        refValue: null,
                        sha256sumLine: sha256sumsLineIndex + 1 + index,
                        isGitLink: false,
                        hadNamePrefix
                    }
                }
            })
            return sources;
        }
    }
    return sources;
}

const joinSourcesWithWorkDependenciesByUrl = async (sources) => {
    const workDependenciesMap = await workDependenciesAsMap();
    return sources.map(source => {
        const matchingWorkDependency = Object.values(workDependenciesMap).find(workDependency => workDependency.url === source.url);
        if (matchingWorkDependency) {
            let newType = source.refType;
            let newRef = source.refValue;
            if (looksLikeGitHash(matchingWorkDependency.rev)) {
                newType = 'commit';
                newRef = matchingWorkDependency.rev;
            }
            else {
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
    const namePart = (source.hadNamePrefix && source.name) ? `${source.name}::` : '';
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
            source.isGitLink = true;
            source.protocol = 'git';
        }
        const revisionChanged = source.refType !== source.newRefType || source.refValue !== source.newRefValue;

        if (!source.isMainPackage && source.isGitLink) {
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

        const mustRecalculateHash = revisionChanged || pkgbuildLines[source.sha256sumLine].includes('SKIP');

        if (mustRecalculateHash) {
            if (source.protocol === 'git') {
                const { sum, ret } = await calcChecksumGit(source.urlWithFragment, `${cloneLocation}/${source.name}`, 'sha256');
                if (ret !== 0) {
                    throw new Error(`Error calculating checksum for ${source.url}`);
                }
                console.log(`Updating sha256sum for ${source.name} to ${sum}...`);
                pkgbuildLines[source.sha256sumLine] = `    '${sum}'`;
            } else if (source.protocol === 'https') {
                const sum = await calcChecksumHttp(source.url, 'sha256');
                if (!sum) {
                    throw new Error(`Error calculating checksum for ${source.url}`);
                }
                console.log(`Updating sha256sum for ${source.name} to ${sum}...`);
                pkgbuildLines[source.sha256sumLine] = `    '${sum}'`;
            }
        }
    }
    await fs.writeFile(pkgbuildPath, pkgbuildLines.join('\n'), 'utf-8');

    console.log('PKGBUILD updated successfully.');
}

export { updatePkgBuild };