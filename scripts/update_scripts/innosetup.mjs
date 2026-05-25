import fs from 'node:fs/promises';
import { parsedVersion } from './version.mjs';
import { innoSetupIssPath } from './files_and_dirs.mjs';
import { splitLines, onLineMatchingModify, findLineIndexMatching } from './text_editing.mjs';

// Matches `#define MyAppVersion "1.2.3"` (with or without surrounding whitespace).
const versionLineRegex = /^(\s*#define\s+MyAppVersion\s+)"([^"]*)"\s*$/;

const updateInnoSetup = async () => {
    console.log(`Updating Inno Setup script at ${innoSetupIssPath}...`);

    const version = parsedVersion();
    let lines = splitLines(await fs.readFile(innoSetupIssPath, 'utf-8'));

    if (findLineIndexMatching(lines, versionLineRegex).lineIndex === -1) {
        throw new Error(
            `No '#define MyAppVersion "..."' line found in ${innoSetupIssPath}. ` +
            `Has the .iss been hand-edited?`
        );
    }

    lines = onLineMatchingModify(lines, versionLineRegex, (_line, match) => {
        console.log(`Updating MyAppVersion from ${match[2]} to ${version.full}...`);
        return `${match[1]}"${version.full}"`;
    });

    await fs.writeFile(innoSetupIssPath, lines.join('\n'), 'utf-8');
    console.log('Inno Setup script updated successfully.');
};

export { updateInnoSetup };
