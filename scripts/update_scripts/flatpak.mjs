import { flatpakYamlPath } from './files_and_dirs.mjs';
import { version } from './args.mjs';
import { findLineIndexMatching, splitLines } from './text_editing.mjs';

import fs from 'node:fs/promises';

export async function updateFlatpakYaml() {
    const yamlContent = await fs.readFile(flatpakYamlPath, 'utf-8');

    const lines = splitLines(yamlContent);

    // Work on the file as text, yaml library spits the file out much differently then before
    // and I want to keep it human.
    const line = findLineIndexMatching(lines, /\s*url:\s*https:\/\/github\.com\/5cript\/nui-sftp/).lineIndex;

    if (line === -1) {
        throw new Error('Could not find url line in flatpak YAML');
    }

    // Search two lines up and below for "tag":
    let tagLineIndex = -1;
    const checkFrom = Math.max(0, line - 2);
    const checkTo = Math.min(lines.length - 1, line + 2);
    for (let i = checkFrom; i <= checkTo; ++i) {
        if (/^\s*tag:\s*v?.*/.test(lines[i])) {
            tagLineIndex = i;
            break;
        }
    }

    const spaceBeforeTag = lines[tagLineIndex].match(/^(\s*)tag:\s*v?.*/)[1];

    if (tagLineIndex === -1) {
        throw new Error('Could not find tag line in flatpak YAML');
    }

    lines[tagLineIndex] = `${spaceBeforeTag}tag: ${version}`;

    await fs.writeFile(flatpakYamlPath, lines.join('\n'), 'utf-8');
}