import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const execAsync = promisify(exec);
const defaultBranchName = 'main';

const pullLatestChanges = async (repoDir) => {
    console.log(`Pulling latest changes in ${repoDir}...`);
    await execAsync(`git -C ${repoDir} pull origin ${defaultBranchName}`);
}

const checkoutRevision = async (repoDir, ref) => {
    console.log(`Checking out revision ${ref} in ${repoDir}...`);
    await execAsync(`git -C ${repoDir} checkout ${ref}`);
}

const fetchAll = async (repoDir) => {
    console.log(`Fetching all refs in ${repoDir}...`);
    await execAsync(`git -C ${repoDir} fetch --all --tags --prune --force`);
}

const directoryExists = async (dir) => {
    try {
        await fs.access(dir);
        return true;
    } catch (err) {
        return false;
    }
}

const updateRepo = async (repoUrl, targetDir, ref) => {
    if (await directoryExists(targetDir)) {
        console.log(`Directory ${targetDir} already exists. Updating repository to ${ref}`);
        await fetchAll(targetDir);
        if (ref) {
            await checkoutRevision(targetDir, ref);
        } else {
            await pullLatestChanges(targetDir);
        }
        return;
    }

    console.log(`Cloning repository from ${repoUrl} to ${targetDir}...`);
    await execAsync(`git clone ${repoUrl} ${targetDir}`);
    if (ref) {
        await checkoutRevision(targetDir, ref);
    }
    return;
}

export { updateRepo }