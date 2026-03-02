const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

import { version } from "./args.mjs";

const parsedVersion = () => {
    let sanitizedVersion = version;
    let tag = version;
    if (version.startsWith('v')) {
        console.warn(`Version ${version} starts with 'v'. Stripping it for parsing.`);
        sanitizedVersion = version.substring(1);
    }
    else {
        tag = 'v' + version;
    }
    const match = sanitizedVersion.match(semverRegex);
    if (!match) {
        throw new Error(`Version ${sanitizedVersion} does not match semantic versioning format`);
    }
    return {
        major: match[1],
        minor: match[2],
        patch: match[3],
        prerelease: match[4],
        build: match[5],
        majorMinorPatch: `${match[1]}.${match[2]}.${match[3]}`,
        dehyphenated: (() => {
            let base = `${match[1]}.${match[2]}.${match[3]}`
            if (match[4]) {
                base = `${base}_${match[4].replace(/-/g, '_')}`;
            }
            if (match[5]) {
                base = `${base}+${match[5].replace(/-/g, '_')}`;
            }
            return base;
        })(),
        full: sanitizedVersion,
        tag: tag
    }
}

export { parsedVersion };
