import { flatpakYamlPath } from './files_and_dirs.mjs';
import { version } from './args.mjs';
import { findLineIndexMatching, onLineMatchingModify, splitLines } from './text_editing.mjs';
import { workDependenciesAsMap } from './work_dependencies.mjs';
import { looksLikeGitHash } from './git.mjs';

import fs from 'node:fs/promises';

async function updateSources(yamlLines) {
    const workDeps = await workDependenciesAsMap();
    for (const [name, { url, rev }] of Object.entries(workDeps)) {
        // find url in yaml lines
        const urlLineIndex = findLineIndexMatching(yamlLines, new RegExp(`\\s*url:\\s*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).lineIndex;
        if (urlLineIndex === -1) {
            console.warn(`Could not find url line for work dependency ${name} in flatpak YAML, skipping...`);
            continue;
        }

        // Search two lines up and below for "tag" or "commit":
        let refLineIndex = -1;
        const checkFrom = Math.max(0, urlLineIndex - 2);
        const checkTo = Math.min(yamlLines.length - 1, urlLineIndex + 2);
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

        const refType = yamlLines[refLineIndex].match(/^\s*(tag|commit):\s*v?.*/)[1];
        const newRefValue = rev;

        console.log(`Updating source for work dependency ${name} in flatpak YAML from ${refType} ${yamlLines[refLineIndex]} to ${refType} ${newRefValue}...`);

        if (looksLikeGitHash(newRefValue)) {
            yamlLines[refLineIndex] = yamlLines[refLineIndex].replace(/^\s*tag:\s*v?.*/, `commit: ${newRefValue}`);
        } else {
            yamlLines[refLineIndex] = yamlLines[refLineIndex].replace(/^\s*commit:\s*v?.*/, `tag: ${newRefValue}`);
        }
    }
    return yamlLines;
}

export async function updateFlatpakYaml() {
    const yamlContent = await fs.readFile(flatpakYamlPath, 'utf-8');
    const lines = await updateSources(splitLines(yamlContent));
    await fs.writeFile(flatpakYamlPath, lines.join('\n'), 'utf-8');
}