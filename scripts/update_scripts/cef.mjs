// The PKGBUILD and the flatpak manifest download CEF themselves. They get the distribution the release was configured
// with: nui-sftp's release CI publishes text/cef_distribution.json of its configure (Nui's NUI_CEF_SELECTED_* cache
// entries, which include a NUI_CEF_VERSION_OVERRIDE) as nui-sftp-cef-distribution_<version>.json. A missing or
// incomplete distribution, or a recipe without the expected CEF lines, fails the release preparation.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { parsedVersion } from './version.mjs';
import { cefDistributionFile } from './args.mjs';
import { pkgbuildPath, flatpakYamlPath } from './files_and_dirs.mjs';
import { splitLines } from './text_editing.mjs';
import { findSourcesRange, findSha256sumsRange } from './pkgbuild.mjs';

const cefDownloadHost = 'https://cef-builds.spotifycdn.com';

const loadDistribution = async () => {
    let text;
    if (cefDistributionFile) {
        console.log(`Reading the CEF distribution from ${cefDistributionFile}...`);
        text = await fs.readFile(cefDistributionFile, 'utf-8');
    } else {
        const version = parsedVersion();
        const url = `https://github.com/5cript/nui-sftp/releases/download/${version.tag}/nui-sftp-cef-distribution_${version.full}.json`;
        console.log(`Fetching the CEF distribution from ${url}...`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Fetching ${url} failed: ${response.status} ${response.statusText}`);
        }
        text = await response.text();
    }

    const distribution = JSON.parse(text);
    for (const key of ['version', 'platform', 'archive', 'url', 'sha256']) {
        if (typeof distribution[key] !== 'string' || distribution[key] === '') {
            throw new Error(`The CEF distribution has no ${key}`);
        }
    }
    if (distribution.platform !== 'linux64') {
        throw new Error(`The CEF distribution is for ${distribution.platform}, the recipes need linux64`);
    }
    if (!/^[0-9a-f]{64}$/.test(distribution.sha256)) {
        throw new Error(`The CEF distribution has no valid SHA256: ${distribution.sha256}`);
    }
    if (distribution.archive !== `cef_binary_${distribution.version}_linux64_minimal.tar.bz2`) {
        throw new Error(`The CEF archive ${distribution.archive} does not belong to version ${distribution.version}`);
    }
    // Both recipes name the archive on this host, the PKGBUILD builds the URL from _cefversion.
    if (distribution.url !== `${cefDownloadHost}/${distribution.archive.replaceAll('+', '%2B')}`) {
        throw new Error(`The CEF archive is not on ${cefDownloadHost} (${distribution.url}), update the recipes by hand`);
    }
    return distribution;
};

const singleLineIndex = (lines, regex, description) => {
    const indices = lines.flatMap((line, index) => (regex.test(line) ? [index] : []));
    if (indices.length !== 1) {
        throw new Error(`Expected exactly one ${description}, found ${indices.length}`);
    }
    return indices[0];
};

const updatePkgBuildCef = (lines, distribution) => {
    const versionIndex = singleLineIndex(lines, /^_cefversion=/, '_cefversion= line in PKGBUILD');
    lines[versionIndex] = `_cefversion=${distribution.version}`;

    const sources = findSourcesRange(lines);
    const sha256s = findSha256sumsRange(lines);
    const cefSources = [];
    for (let index = sources.start + 1; index < sources.end; ++index) {
        if (lines[index].includes(cefDownloadHost)) {
            cefSources.push(index - sources.start - 1);
        }
    }
    if (cefSources.length !== 1) {
        throw new Error(`Expected exactly one CEF source in PKGBUILD, found ${cefSources.length}`);
    }
    const shaIndex = sha256s.start + 1 + cefSources[0];
    if (shaIndex >= sha256s.end) {
        throw new Error('PKGBUILD has no sha256sums entry for the CEF source');
    }
    lines[shaIndex] = `    '${distribution.sha256}'`;
};

// The flatpak also builds aarch64. The release only publishes the linux64 distribution, so the linuxarm64 archive of
// the same version is hashed from its download.
const archDistribution = async (distribution, platform) => {
    if (platform === distribution.platform) {
        return distribution;
    }
    const archive = `cef_binary_${distribution.version}_${platform}_minimal.tar.bz2`;
    const url = `${cefDownloadHost}/${archive.replaceAll('+', '%2B')}`;
    console.log(`Hashing ${url}...`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Fetching ${url} failed: ${response.status} ${response.statusText}`);
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of response.body) {
        hash.update(chunk);
    }
    return { ...distribution, platform, archive, url, sha256: hash.digest('hex') };
};

const updateFlatpakCef = (lines, distribution) => {
    const urlIndex = singleLineIndex(
        lines,
        new RegExp(`^\\s*url:\\s*https:\\/\\/cef-builds\\.spotifycdn\\.com\\/\\S+_${distribution.platform}_minimal\\.tar\\.bz2\\s*$`),
        `${distribution.platform} CEF source url in the flatpak manifest`);
    // The lines of the source entry around the url: from its "- type:" line to the next entry.
    let entryStart = urlIndex;
    while (entryStart > 0 && !/^\s*-\s*type:/.test(lines[entryStart])) {
        --entryStart;
    }
    let entryEnd = urlIndex + 1;
    while (entryEnd < lines.length && /^\s+[a-z0-9-]+:/.test(lines[entryEnd]) && !/^\s*-\s/.test(lines[entryEnd])) {
        ++entryEnd;
    }
    const replaceInSource = (key, value) => {
        for (let index = entryStart; index < entryEnd; ++index) {
            const match = lines[index].match(new RegExp(`^(\\s*-?\\s*${key}:\\s*)\\S+\\s*$`));
            if (match) {
                lines[index] = `${match[1]}${value}`;
                return;
            }
        }
        throw new Error(`The CEF source of the flatpak manifest has no ${key}`);
    };
    replaceInSource('url', distribution.url);
    replaceInSource('dest-filename', distribution.archive);
    replaceInSource('sha256', distribution.sha256);

    const archiveIndex = singleLineIndex(
        lines,
        new RegExp(`^\\s*-\\s*-DNUI_CEF_ARCHIVE=\\/run\\/build\\/nui-sftp\\/\\S+_${distribution.platform}_minimal\\.tar\\.bz2\\s*$`),
        `${distribution.platform} NUI_CEF_ARCHIVE option in the flatpak manifest`);
    lines[archiveIndex] = lines[archiveIndex].replace(/\/run\/build\/nui-sftp\/\S+/, `/run/build/nui-sftp/${distribution.archive}`);
};

const flatpakPlatforms = ['linux64', 'linuxarm64'];

export async function updateCefDistribution({ pkgbuild = pkgbuildPath, manifest = flatpakYamlPath } = {}) {
    const distribution = await loadDistribution();
    console.log(`Using CEF ${distribution.version} (${distribution.sha256})...`);

    const pkgbuildLines = splitLines(await fs.readFile(pkgbuild, 'utf-8'));
    const manifestLines = splitLines(await fs.readFile(manifest, 'utf-8'));
    updatePkgBuildCef(pkgbuildLines, distribution);
    for (const platform of flatpakPlatforms) {
        updateFlatpakCef(manifestLines, await archDistribution(distribution, platform));
    }
    await fs.writeFile(pkgbuild, pkgbuildLines.join('\n'), 'utf-8');
    await fs.writeFile(manifest, manifestLines.join('\n'), 'utf-8');
    console.log('CEF distribution updated in PKGBUILD and the flatpak manifest.');
}
