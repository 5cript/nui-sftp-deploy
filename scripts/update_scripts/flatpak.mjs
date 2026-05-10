import { flatpakYamlPath, nuiSftpRepoDir } from './files_and_dirs.mjs';
import { parsedVersion } from './version.mjs';
import { findLineIndexMatching, splitLines } from './text_editing.mjs';

import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

async function setFunctionOnForcedVersionCmakeOptions(yamlLines) {
    const { lineIndex, match } = findLineIndexMatching(yamlLines, /^(\s*)-DFORCED_PROJECT_VERSION=.*$/);
    if (lineIndex === -1) {
        console.warn('Could not find line with DFORCED_PROJECT_VERSION in flatpak YAML, skipping...');
        return yamlLines;
    }

    const cmakeOptionsLine = yamlLines[lineIndex];
    yamlLines[lineIndex] = match[1] + `-DFORCED_PROJECT_VERSION=${parsedVersion().majorMinorPatch}`;
    console.log(`Updating DFORCED_PROJECT_VERSION in flatpak YAML from ${cmakeOptionsLine} to ${yamlLines[lineIndex]}...`);
    return yamlLines;
}

async function updateFrontendStep(yamlLines) {
    const frontendStepLineIndex = findLineIndexMatching(yamlLines, /^\s*- name:\s*nui-sftp-frontend\s*$/).lineIndex;
    if (frontendStepLineIndex === -1) {
        console.warn('Could not find line with nui-sftp-frontend step in flatpak YAML, skipping...');
        return yamlLines;
    }

    const urlMatch = findLineIndexMatching(yamlLines, /^\s*url:\s*(.)+$/, frontendStepLineIndex);
    if (urlMatch.lineIndex === -1) {
        console.warn('Could not find url line for nui-sftp-frontend step in flatpak YAML, skipping...');
        return yamlLines;
    }
    const shaMatch = findLineIndexMatching(yamlLines, /^\s*sha256:\s*(.)+$/, urlMatch.lineIndex);
    if (shaMatch.lineIndex === -1) {
        console.warn('Could not find sha256 line for nui-sftp-frontend step in flatpak YAML, skipping...');
        return yamlLines;
    }

    const urlLine = yamlLines[urlMatch.lineIndex];
    const shaLine = yamlLines[shaMatch.lineIndex];

    const oldUrl = urlLine.match(/^\s*url:\s*(.+)\s*$/)[1];
    const splitOldUrl = oldUrl.split('/');
    const newFileName = `nui-sftp-linux-frontend_${parsedVersion().full}.tar.gz`;
    splitOldUrl[splitOldUrl.length - 1] = newFileName;
    splitOldUrl[splitOldUrl.length - 2] = parsedVersion().tag;
    const newUrl = splitOldUrl.join('/');

    console.log(`Updating nui-sftp-frontend source URL in flatpak YAML from ${oldUrl} to ${newUrl}...`);
    yamlLines[urlMatch.lineIndex] = urlLine.replace(oldUrl, newUrl);

    const response = await fetch(newUrl);
    if (!response.ok) {
        console.warn(`Failed to fetch ${newUrl} to update sha256 in flatpak YAML, skipping sha256 update...`);
        return yamlLines;
    }
    const buffer = await response.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const shaSpacePrefix = shaLine.match(/^(\s*)sha256:\s*(.)+$/)[1];
    console.log(`Updating nui-sftp-frontend source SHA256 in flatpak YAML from ${shaLine} to ${shaSpacePrefix}sha256: ${hashHex}...`);
    yamlLines[shaMatch.lineIndex] = `${shaSpacePrefix}sha256: ${hashHex}`;

    return yamlLines;
}

// Resolve the commit SHA a tag points at by asking the local clone.
// updateRepo() in prepare_release.mjs has already fetched + checked out
// the requested tag, so the ref is guaranteed to exist locally.
async function resolveCommitForTag(repoDir, tag) {
    try {
        const { stdout } = await execAsync(`git -C ${repoDir} rev-parse ${tag}^{commit}`);
        return stdout.trim();
    } catch (err) {
        console.warn(`Failed to resolve commit for tag '${tag}' in ${repoDir}: ${err.message}`);
        return null;
    }
}

// Update the `tag:` and `commit:` lines that follow a known `url:` line.
// Both must already be present in the manifest; this never inserts new keys.
function updateGitSourceTagAndCommit(yamlLines, exactUrl, newTag, newCommit, windowSize = 6) {
    const escapedUrl = exactUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const urlLineIndex = findLineIndexMatching(yamlLines, new RegExp(`^\\s*url:\\s*${escapedUrl}\\s*$`)).lineIndex;
    if (urlLineIndex === -1) {
        console.warn(`Could not find git source URL '${exactUrl}' in flatpak YAML, skipping...`);
        return yamlLines;
    }

    const checkTo = Math.min(yamlLines.length - 1, urlLineIndex + windowSize);
    let tagLineIndex = -1;
    let commitLineIndex = -1;
    for (let i = urlLineIndex + 1; i <= checkTo; ++i) {
        if (tagLineIndex === -1 && /^\s*tag:\s*.+$/.test(yamlLines[i])) tagLineIndex = i;
        if (commitLineIndex === -1 && /^\s*commit:\s*.+$/.test(yamlLines[i])) commitLineIndex = i;
        if (tagLineIndex !== -1 && commitLineIndex !== -1) break;
    }

    if (tagLineIndex !== -1) {
        const indent = yamlLines[tagLineIndex].match(/^(\s*)/)[1];
        console.log(`Updating tag for ${exactUrl}: '${yamlLines[tagLineIndex].trim()}' -> 'tag: ${newTag}'`);
        yamlLines[tagLineIndex] = `${indent}tag: ${newTag}`;
    } else {
        console.warn(`No tag: line found for ${exactUrl} within ${windowSize} lines of url:, skipping tag update...`);
    }

    if (commitLineIndex !== -1) {
        const indent = yamlLines[commitLineIndex].match(/^(\s*)/)[1];
        console.log(`Updating commit for ${exactUrl}: '${yamlLines[commitLineIndex].trim()}' -> 'commit: ${newCommit}'`);
        yamlLines[commitLineIndex] = `${indent}commit: ${newCommit}`;
    } else {
        console.warn(`No commit: line found for ${exactUrl} within ${windowSize} lines of url:, skipping commit update...`);
    }

    return yamlLines;
}

async function updateMainSourceRef(yamlLines) {
    const tag = parsedVersion().tag;
    const commit = await resolveCommitForTag(nuiSftpRepoDir, tag);
    if (!commit) {
        console.warn('Skipping main nui-sftp source ref update: could not resolve commit.');
        return yamlLines;
    }
    return updateGitSourceTagAndCommit(yamlLines, 'https://github.com/5cript/nui-sftp', tag, commit);
}

export async function updateFlatpakYaml() {
    const yamlContent = await fs.readFile(flatpakYamlPath, 'utf-8');
    let lines = splitLines(yamlContent);
    lines = await updateMainSourceRef(lines);
    lines = await setFunctionOnForcedVersionCmakeOptions(lines);
    lines = await updateFrontendStep(lines);
    await fs.writeFile(flatpakYamlPath, lines.join('\n'), 'utf-8');
}
