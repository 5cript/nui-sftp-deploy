import fs from 'node:fs/promises';
import { nuiSftpRepoDir } from './files_and_dirs.mjs';

const extractWorkDependencies = async () => {
    const workDependenciesJson = await fs.readFile(`${nuiSftpRepoDir}/work_dependencies.json`, 'utf-8');
    return JSON.parse(workDependenciesJson);
}

const workDependenciesAsMap = async () => {
    const map = {};
    const work = await extractWorkDependencies();
    for (const dependency of work.sources) {
        map[dependency.name] = {
            url: dependency.url,
            rev: dependency.rev,
            branch: dependency.branch
        }
    }
    return map;
}

export { extractWorkDependencies, workDependenciesAsMap };