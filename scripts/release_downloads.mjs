#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { downloadSection, releaseDownloadState } from './update_scripts/release_downloads.mjs';

const usage = `Usage: scripts/release_downloads.mjs [--apply | --check] [-R owner/repo] [tag]
  (no option)   prints the Download section of the release notes
  --apply       writes it to the end of the release notes and labels the assets that are not downloads
  --check       exits 1 unless the release has both already
  tag           defaults to the newest release`;

const { values, positionals } = parseArgs({
    options: {
        apply: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        repository: { type: 'string', short: 'R', default: process.env.REPO ?? '5cript/nui-sftp' },
        help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
});
if (values.help || positionals.length > 1 || (values.apply && values.check)) {
    console.log(usage);
    process.exit(values.help ? 0 : 1);
}

const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).trim();

const repository = values.repository;
// The newest release, the latest flag only moves in the release dashboard's last step.
const tag = positionals[0] ?? gh(['release', 'list', '-R', repository, '--exclude-drafts', '--limit', '1', '--json', 'tagName', '--jq', '.[0].tagName']);
const release = JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`]));

if (!values.apply && !values.check) {
    console.log(downloadSection(release.assets));
    process.exit(0);
}

const state = releaseDownloadState(release);
if (state.missing.length > 0) {
    console.error(`${tag} is missing: ${state.missing.join(', ')}`);
    process.exit(1);
}

if (values.check) {
    console.log(`release notes: ${state.bodyUpToDate ? 'Download section is current' : 'Download section missing or outdated'}`);
    state.labels.forEach(({ name, current, wanted }) => console.log(`${name}: ${current === wanted ? `"${wanted}"` : `label "${current}", wanted "${wanted}"`}`));
    process.exit(state.bodyUpToDate && state.staleLabels.length === 0 ? 0 : 1);
}

if (state.bodyUpToDate) {
    console.log('release notes: Download section is current');
} else {
    // An edit of an older release must not make it the latest one.
    const latest = gh(['api', `repos/${repository}/releases/latest`, '--jq', '.tag_name']);
    const keepLatest = latest === tag ? [] : ['--latest=false'];
    gh(['release', 'edit', tag, '-R', repository, ...keepLatest, '--notes-file', '-'], state.wantedBody);
    console.log('release notes: Download section written');
}
for (const { id, name, wanted } of state.staleLabels) {
    gh(['api', '-X', 'PATCH', `repos/${repository}/releases/assets/${id}`, '-f', `label=${wanted}`, '--silent']);
    console.log(`${name}: labelled "${wanted}"`);
}
