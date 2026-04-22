import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { parsedVersion } from './version.mjs';
import { pkgbuildPath, nuiSftpRepoDir } from './files_and_dirs.mjs';
import { splitLines, onLineMatchingModify, findLineIndexMatching } from './text_editing.mjs';

import fs from 'node:fs/promises';
import fsOld from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function calcChecksumGitTag(checkoutDir, tag) {
    return new Promise((resolve, reject) => {
        const tmpFile = path.join(os.tmpdir(), `git-archive-${process.pid}-${Date.now()}.tar`);
        const out = fsOld.createWriteStream(tmpFile);

        const git = spawn("git", [
            "-c", "core.abbrev=no",
            "-C", checkoutDir,
            "archive", "--format=tar", tag
        ]);

        git.stdout.pipe(out);
        git.stderr.pipe(process.stderr);
        git.on("error", reject);

        git.on("close", (code) => {
            if (code !== 0) {
                fs.unlink(tmpFile, () => { });
                return reject(new Error(`git archive exited with code ${code}`));
            }

            const hash = spawn("sha256sum", [tmpFile]);
            let output = "";
            hash.stdout.on("data", (d) => { output += d.toString("utf8"); });
            hash.stderr.pipe(process.stderr);
            hash.on("close", (hashCode) => {
                fs.unlink(tmpFile, () => { });
                if (hashCode !== 0) return reject(new Error(`sha256sum exited with code ${hashCode}`));
                resolve(output.trim().split(/\s+/)[0]);
            });
        });
    });
}

async function calcChecksumHttp(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

    const hash = spawn("sha256sum", [], { stdio: ['pipe', 'pipe', 'inherit'] });
    Readable.fromWeb(res.body).pipe(hash.stdin);

    let output = "";
    hash.stdout.on("data", (d) => { output += d.toString("utf8"); });

    return new Promise((resolve, reject) => {
        hash.on("close", (code) => {
            if (code !== 0) return reject(new Error(`sha256sum exited with code ${code}`));
            resolve(output.trim().split(/\s+/)[0]);
        });
    });
}

const findSha256sumsRange = (lines) => {
    const start = lines.findIndex(line => line.startsWith('sha256sums='));
    if (start === -1) throw new Error('No sha256sums line found in PKGBUILD');
    const end = lines.findIndex((line, i) => i > start && line.trim() === ')');
    if (end === -1) throw new Error('Unterminated sha256sums array in PKGBUILD');
    return { start, end };
}

const findSourcesRange = (lines) => {
    const start = lines.findIndex(line => line.startsWith('source='));
    if (start === -1) throw new Error('No source line found in PKGBUILD');
    const end = lines.findIndex((line, i) => i > start && line.trim() === ')');
    if (end === -1) throw new Error('Unterminated source array in PKGBUILD');
    return { start, end };
}

const updatePkgBuild = async () => {
    console.log(`Updating PKGBUILD at ${pkgbuildPath}...`);

    const version = parsedVersion();
    let lines = splitLines(await fs.readFile(pkgbuildPath, 'utf-8'));

    lines = onLineMatchingModify(lines, /^pkgver=(.+)$/, (_line, match) => {
        console.log(`Updating pkgver from ${match[1]} to ${version.dehyphenated}...`);
        return `pkgver=${version.dehyphenated}`;
    });

    if (findLineIndexMatching(lines, /^pkgver=(.+)$/).lineIndex === -1) {
        throw new Error('No pkgver line found in PKGBUILD');
    }

    const sources = findSourcesRange(lines);
    const sha256s = findSha256sumsRange(lines);

    for (let i = 0; i < sources.end - sources.start - 1; ++i) {
        const rawLine = lines[sources.start + 1 + i].trim().replace(/"/g, '');
        const resolved = rawLine
            .replace(/\$\{pkgver\/\/_\/-\}/g, version.full)
            .replace(/\$\{pkgver\}/g, version.full);

        let sum;
        if (resolved.includes('git+')) {
            sum = await calcChecksumGitTag(nuiSftpRepoDir, version.tag);
        } else if (resolved.startsWith('https://github.com/5cript/nui-sftp/releases/download/')) {
            sum = await calcChecksumHttp(resolved);
        } else {
            continue;
        }

        const shaLineIndex = sha256s.start + 1 + i;
        console.log(`Updating sha256 at line ${shaLineIndex + 1} to ${sum}`);
        lines[shaLineIndex] = `    '${sum}'`;
    }

    await fs.writeFile(pkgbuildPath, lines.join('\n'), 'utf-8');
    console.log('PKGBUILD updated successfully.');
}

export { updatePkgBuild };
