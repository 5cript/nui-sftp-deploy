// The "## Download" section of a GitHub release's notes and the labels of the assets that are not downloads.

const notAnInstaller = 'Not an installer';

// First match wins. An asset with a section is listed there; one with a label is not a download and shows that label
// instead of its file name in the asset list. required: a release without it is not ready for its Download section.
const assetKinds = [
    { pattern: /\.pkg\.tar\.zst$/, section: 'linux', title: 'Arch package', required: true },
    { pattern: /\.deb$/, section: 'linux', title: 'Debian package' },
    { pattern: /\.rpm$/, section: 'linux', title: 'RPM package' },
    { pattern: /\.appimage$/, section: 'linux', title: 'AppImage', required: true },
    { pattern: /\.appimage\.zsync$/, label: `${notAnInstaller}: AppImage update data (zsync)` },
    { pattern: /\.flatpak$/, section: 'linux', title: 'Flatpak bundle', required: true },
    { pattern: /linux-frontend.*\.tar\.gz$/, label: `${notAnInstaller}: frontend build input for packagers` },
    { pattern: /cef-distribution.*\.json$/, label: `${notAnInstaller}: CEF version info for packagers` },
    { pattern: /licenses.*\.tar\.gz$/, label: `${notAnInstaller}: third-party license texts` },
    { pattern: /arm64.*\.dmg$/, section: 'macos', title: 'Apple Silicon DMG', required: true },
    { pattern: /x86_64.*\.dmg$/, section: 'macos', title: 'Intel DMG' },
    { pattern: /\.dmg$/, section: 'macos', title: 'DMG' },
    { pattern: /\.pkg$/, section: 'macos', title: 'macOS installer package' },
    { pattern: /setup\.exe$/, section: 'windows', title: 'Windows installer', required: true },
    { pattern: /windows.*\.zip$/, section: 'windows', title: 'Windows zip', required: true },
    { pattern: /\.msi$/, section: 'windows', title: 'Windows MSI' },
];

const sections = [
    { key: 'linux', title: 'Linux' },
    { key: 'macos', title: 'macOS' },
    { key: 'windows', title: 'Windows' },
];

const archNote =
    '> **Arch Linux users:** prefer installing the [`nui-sftp`](https://aur.archlinux.org/packages/nui-sftp) package from the AUR instead of the `.pkg.tar.zst` directly, so you get automatic updates and dependency resolution.';

/**
 * The kind of a release asset. An unknown name throws, so a new asset is classified on purpose.
 */
export function classifyAsset(name) {
    const lower = name.toLowerCase();
    const kind = assetKinds.find(({ pattern }) => pattern.test(lower));
    if (!kind) {
        throw new Error(`unclassified release asset: ${name} (add it to assetKinds in scripts/update_scripts/release_downloads.mjs)`);
    }
    return kind;
}

/**
 * Strips the "## Download" section (everything until the next h1/h2 or the end) from release notes.
 */
export function stripDownloadSection(markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let skipping = false;
    for (const line of lines) {
        if (skipping) {
            if (/^#{1,2} (?!#)/.test(line)) {
                skipping = false;
                out.push(line);
            }
            continue;
        }
        if (/^##\s+Download\s*$/i.test(line)) {
            skipping = true;
            continue;
        }
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The Download section for assets of the GitHub API's shape (name, browser_download_url): installers only.
 */
export function downloadSection(assets) {
    const classified = assets.map((asset) => ({ asset, kind: classifyAsset(asset.name) }));
    const parts = ['## Download'];
    for (const { key, title } of sections) {
        const entries = classified.filter(({ kind }) => kind.section === key);
        if (entries.length === 0) {
            continue;
        }
        parts.push(`### ${title}`);
        if (key === 'linux' && entries.some(({ asset }) => asset.name.endsWith('.pkg.tar.zst'))) {
            parts.push(`${archNote}\n`);
        }
        parts.push(`${entries.map(({ asset, kind }) => `- [${kind.title}](${asset.browser_download_url})`).join('\n')}\n`);
    }
    return parts.join('\n').trim();
}

/**
 * Release notes with their Download section replaced by the current one, at the end.
 */
export function withDownloadSection(body, assets) {
    return `${stripDownloadSection(body ?? '')}\n\n${downloadSection(assets)}`.trim();
}

/**
 * What a release (GitHub API object with body and assets) has and what it should have.
 */
export function releaseDownloadState(release) {
    const names = release.assets.map((asset) => asset.name.toLowerCase());
    const missing = assetKinds.filter(({ required, pattern }) => required && !names.some((name) => pattern.test(name))).map(({ title }) => title);
    const body = (release.body ?? '').replace(/\r\n/g, '\n').trim();
    const wantedBody = withDownloadSection(body, release.assets);
    const labels = release.assets
        .map((asset) => ({ id: asset.id, name: asset.name, current: asset.label ?? '', wanted: classifyAsset(asset.name).label }))
        .filter(({ wanted }) => wanted !== undefined);
    return {
        missing,
        wantedBody,
        bodyUpToDate: body === wantedBody,
        labels,
        staleLabels: labels.filter(({ current, wanted }) => current !== wanted),
    };
}
