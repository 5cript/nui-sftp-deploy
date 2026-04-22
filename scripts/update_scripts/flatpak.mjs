import { flatpakYamlPath } from './files_and_dirs.mjs';
import { parsedVersion } from './version.mjs';
import { findLineIndexMatching, splitLines } from './text_editing.mjs';

import fs from 'node:fs/promises';

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

function updateMainSourceTag(yamlLines) {
    const url = 'https://github.com/5cript/nui-sftp';
    const urlLineIndex = findLineIndexMatching(yamlLines, new RegExp(`\\s*url:\\s*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)).lineIndex;
    if (urlLineIndex === -1) {
        console.warn(`Could not find main nui-sftp source URL in flatpak YAML, skipping tag update...`);
        return yamlLines;
    }

    let refLineIndex = -1;
    const checkTo = Math.min(yamlLines.length - 1, urlLineIndex + 3);
    for (let i = urlLineIndex; i <= checkTo; ++i) {
        if (/^\s*(tag|commit):\s*.*/.test(yamlLines[i])) {
            refLineIndex = i;
            break;
        }
    }

    if (refLineIndex === -1) {
        console.warn(`Could not find tag/commit line for main nui-sftp source in flatpak YAML, skipping...`);
        return yamlLines;
    }

    const refLineSpacePrefix = yamlLines[refLineIndex].match(/^(\s*)/)[1];
    console.log(`Updating main nui-sftp tag in flatpak YAML from ${yamlLines[refLineIndex]} to tag: ${parsedVersion().tag}`);
    yamlLines[refLineIndex] = refLineSpacePrefix + `tag: ${parsedVersion().tag}`;
    return yamlLines;
}

export async function updateFlatpakYaml() {
    const yamlContent = await fs.readFile(flatpakYamlPath, 'utf-8');
    let lines = updateMainSourceTag(splitLines(yamlContent));
    lines = await setFunctionOnForcedVersionCmakeOptions(lines);
    lines = await updateFrontendStep(lines);
    await fs.writeFile(flatpakYamlPath, lines.join('\n'), 'utf-8');
}
