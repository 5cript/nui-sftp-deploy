
import path from 'node:path';

const sourceDir = path.dirname(path.dirname(import.meta.dirname));
const pkgbuildPath = path.join(sourceDir, 'PKGBUILD');
const cloneLocation = path.join(sourceDir, 'checkout');
const nuiSftpRepoDir = `${cloneLocation}/nui-sftp`;

export { pkgbuildPath, sourceDir, nuiSftpRepoDir, cloneLocation };