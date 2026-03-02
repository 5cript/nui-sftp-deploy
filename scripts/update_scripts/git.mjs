import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const execAsync = promisify(exec);
const defaultBranchName = 'main';

const switchToDefaultBranch = async (repoDir) => {
    console.log(`Switching to default branch in ${repoDir}...`);
    await execAsync(`git -C ${repoDir} checkout ${defaultBranchName}`);
}

const pullLatestChanges = async (repoDir) => {
    console.log(`Pulling latest changes in ${repoDir}...`);
    await execAsync(`git -C ${repoDir} pull origin ${defaultBranchName}`);
}

const pullRevision = async (repoDir, ref) => {
    console.log(`Pulling revision ${ref} in ${repoDir}...`);
    await execAsync(`git -C ${repoDir} pull origin ${ref}`);
}

const isOnDefaultBranch = async (repoDir) => {
    const { stdout } = await execAsync(`git -C ${repoDir} rev-parse --abrev-ref HEAD`);
    return stdout.trim() === defaultBranchName;
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
        if (ref) {
            await pullRevision(targetDir, ref);
        } else {
            await pullLatestChanges(targetDir);
        }
        return;
    }

    console.log(`Cloning repository from ${repoUrl} to ${targetDir}...`);
    await execAsync(`git clone ${repoUrl} ${targetDir}`);
    if (ref) {
        await pullRevision(targetDir, ref);
    }
    return;
}

const checkoutSpecificRef = async (repoDir, ref) => {
    console.log(`Checking out ref ${ref} in ${repoDir}...`);
    await execAsync(`git -C ${repoDir} checkout ${ref}`);
}

export { updateRepo, checkoutSpecificRef }