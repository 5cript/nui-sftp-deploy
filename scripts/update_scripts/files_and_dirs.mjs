
import path from 'node:path';

const sourceDir = path.dirname(path.dirname(import.meta.dirname));
const pkgbuildPath = path.join(sourceDir, 'PKGBUILD');
const cloneLocation = path.join(sourceDir, 'checkout');
const nuiSftpRepoDir = `${cloneLocation}/nui-sftp`;
const flatpakYamlPath = path.join(sourceDir, 'org.nuicpp.nui_sftp.yml');
const appimageDockerfilePath = path.join(sourceDir, 'appimage', 'Dockerfile');
const innoSetupIssPath = path.join(sourceDir, 'windows', 'nui-sftp.iss');

export { pkgbuildPath, sourceDir, nuiSftpRepoDir, flatpakYamlPath, appimageDockerfilePath, innoSetupIssPath };