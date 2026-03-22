import { flatpakYamlPath } from './files_and_dirs.mjs';
import { parsedVersion } from './version.mjs';
import { findLineIndexMatching, onLineMatchingModify, splitLines } from './text_editing.mjs';
import { workDependenciesAsMap } from './work_dependencies.mjs';
import { looksLikeGitHash } from './git.mjs';

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

async function updateSources(yamlLines) {
    const workDeps = await workDependenciesAsMap();
    workDeps['nui-sftp'] = { url: 'https://github.com/5cript/nui-sftp', rev: parsedVersion().full, branch: 'main' };
    for (const [name, { url, rev }] of Object.entries(workDeps)) {
        // find url in yaml lines
        const urlLineIndex = findLineIndexMatching(yamlLines, new RegExp(`\\s*url:\\s*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).lineIndex;
        if (urlLineIndex === -1) {
            console.warn(`Could not find url line for work dependency ${name} in flatpak YAML, skipping...`);
            continue;
        }

        // Search two lines up and below for "tag" or "commit":
        let refLineIndex = -1;
        const checkFrom = Math.max(0, urlLineIndex);
        const checkTo = Math.min(yamlLines.length - 1, urlLineIndex + 3);
        for (let i = checkFrom; i <= checkTo; ++i) {
            if (/^\s*(tag|commit):\s*v?.*/.test(yamlLines[i])) {
                refLineIndex = i;
                break;
            }
        }

        if (refLineIndex === -1) {
            console.warn(`Could not find tag or commit line for work dependency ${name} in flatpak YAML, skipping...`);
            continue;
        }

        const refLineSpacePrefix = yamlLines[refLineIndex].match(/^(\s*)/)[1];
        const refType = yamlLines[refLineIndex].match(/^\s*(tag|commit):\s*v?.*/)[1];
        const newRefValue = rev;

        console.log(`Updating source for work dependency ${name} in flatpak YAML from ${refType} ${yamlLines[refLineIndex]} to ${refType} ${newRefValue}...`);

        if (looksLikeGitHash(newRefValue)) {
            yamlLines[refLineIndex] = refLineSpacePrefix + `commit: ${newRefValue}`;
        } else {
            yamlLines[refLineIndex] = refLineSpacePrefix + `tag: ${newRefValue}`; // Assuming it's a tag if it doesn't look like a git hash
        }
    }
    return yamlLines;
}

export async function updateFlatpakYaml() {
    const yamlContent = await fs.readFile(flatpakYamlPath, 'utf-8');
    let lines = await updateSources(splitLines(yamlContent));
    lines = await setFunctionOnForcedVersionCmakeOptions(lines);
    await fs.writeFile(flatpakYamlPath, lines.join('\n'), 'utf-8');
}