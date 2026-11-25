import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAsset, downloadSection, releaseDownloadState, stripDownloadSection, withDownloadSection } from './release_downloads.mjs';

const url = (name) => `https://github.com/5cript/nui-sftp/releases/download/v9.8.7/${name}`;
const asset = (name, label = null) => ({ id: name.length, name, label, browser_download_url: url(name) });

const assets = [
    asset('nui-sftp-9.8.7-1-x86_64.pkg.tar.zst'),
    asset('nui-sftp-appimage-x86_64_9.8.7.AppImage'),
    asset('nui-sftp-appimage-x86_64_9.8.7.AppImage.zsync'),
    asset('nui-sftp-cef-distribution_9.8.7.json'),
    asset('nui-sftp-flatpak-x86_64_9.8.7.flatpak'),
    asset('nui-sftp-licenses_9.8.7.tar.gz'),
    asset('nui-sftp-linux-frontend_9.8.7.tar.gz'),
    asset('nui-sftp-macos-arm64_9.8.7.dmg'),
    asset('nui-sftp-windows-x86_64_9.8.7-setup.exe'),
    asset('nui-sftp-windows-x86_64_9.8.7.zip'),
];

const notes = "## What's Changed\n* Something by @someone in https://github.com/5cript/nui-sftp/pull/1\n\n**Full Changelog**: https://github.com/5cript/nui-sftp/compare/v9.8.6...v9.8.7";

test('the section lists installers only, grouped by platform', () => {
    const section = downloadSection(assets);
    assert.match(section, /^## Download\n### Linux\n- \[AppImage\]/);
    const linked = [...section.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)].map((match) => match[1]);
    assert.deepEqual(linked, ['AppImage', 'Flatpak bundle', 'Arch package', 'Apple Silicon DMG', 'Windows installer', 'Windows zip']);
    assert.ok(section.indexOf('### Linux') < section.indexOf('### macOS') && section.indexOf('### macOS') < section.indexOf('### Windows'));
    for (const hidden of ['frontend', 'zsync', 'licenses', 'cef-distribution']) {
        assert.ok(!section.includes(hidden), hidden);
    }
});

test('the Flatpak entry carries the Flathub install line and the Arch entry its AUR note', () => {
    const section = downloadSection(assets);
    assert.match(section, /^- \[Flatpak bundle\]\([^)]+\), or from Flathub:\n  ```\n  flatpak install flathub org\.nuicpp\.nui_sftp\n  ```$/m);
    assert.match(section, /^- \[Arch package\]\([^)]+\)\n  > \*\*Arch Linux users:\*\* prefer installing/m);
});

test('the assets that are not downloads say so in their label', () => {
    const labelled = assets.filter(({ name }) => classifyAsset(name).label !== undefined).map(({ name }) => name);
    assert.deepEqual(labelled, [
        'nui-sftp-appimage-x86_64_9.8.7.AppImage.zsync',
        'nui-sftp-cef-distribution_9.8.7.json',
        'nui-sftp-licenses_9.8.7.tar.gz',
        'nui-sftp-linux-frontend_9.8.7.tar.gz',
    ]);
    labelled.forEach((name) => assert.match(classifyAsset(name).label, /^Not an installer: /));
});

test('an unknown asset is an error', () => {
    assert.throws(() => classifyAsset('nui-sftp-something-new_9.8.7.bin'), /unclassified release asset/);
});

test('adding the section twice changes nothing, and stripping gives the notes back', () => {
    const once = withDownloadSection(notes, assets);
    assert.equal(withDownloadSection(once, assets), once);
    assert.equal(stripDownloadSection(once), notes);
    assert.equal(stripDownloadSection(notes.replace(/\n/g, '\r\n')), notes);
});

test('a section in the middle is stripped up to the next heading', () => {
    const middle = `${downloadSection(assets)}\n\n${notes}`;
    assert.equal(stripDownloadSection(middle), notes);
});

test('the state reports what is left to do', () => {
    const fresh = releaseDownloadState({ body: notes.replace(/\n/g, '\r\n'), assets });
    assert.deepEqual(fresh.missing, []);
    assert.equal(fresh.bodyUpToDate, false);
    assert.equal(fresh.staleLabels.length, 4);

    const done = releaseDownloadState({
        body: fresh.wantedBody,
        assets: assets.map((entry) => ({ ...entry, label: classifyAsset(entry.name).label ?? null })),
    });
    assert.equal(done.bodyUpToDate, true);
    assert.deepEqual(done.staleLabels, []);
});

test('a release without one of its installers is reported', () => {
    const state = releaseDownloadState({ body: notes, assets: assets.filter(({ name }) => !name.endsWith('.dmg')) });
    assert.deepEqual(state.missing, ['Apple Silicon DMG']);
});
