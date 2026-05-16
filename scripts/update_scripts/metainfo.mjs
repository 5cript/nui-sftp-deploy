import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import { sourceDir } from './files_and_dirs.mjs';
import { getReleases } from './github.mjs';

import showdown from 'showdown';
import fsOld from 'node:fs';
import path from 'node:path';
import { parsedVersion } from './version.mjs';

function convertReleaseToHtml(str) {
    // const window = new JSDOM('').window;
    // const purify = DOMPurify(window);
    // const clean = purify.sanitize(str);
    const converter = new showdown.Converter();
    const html = converter.makeHtml(str);
    return html;
}

// AppStream <description> only permits: p, ul, ol, li, em, code.
// Everything else (h1-h6, strong, b, i, a, ...) is rejected by the flatpak/appstream linter.
// showdown produces several of those from GitHub release markdown, so we rewrite the parsed
// tree before it gets serialised back into the metainfo XML.
const TAG_RENAMES = {
    h1: 'p', h2: 'p', h3: 'p', h4: 'p', h5: 'p', h6: 'p',
    strong: 'em',
    b: 'em',
    i: 'em',
};

function sanitizeAppStreamNodes(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
        const tag = Object.keys(node).find(k => k !== ':@');
        if (!tag || tag.startsWith('#') || tag === 'comment' || tag === 'cdata') continue;

        sanitizeAppStreamNodes(node[tag]);

        const renamed = TAG_RENAMES[tag];
        if (renamed) {
            node[renamed] = node[tag];
            delete node[tag];
            // <p>/<em> don't accept the id attribute showdown adds to headings.
            delete node[':@'];
        }
    }
}

function htmlToFastXmlFormat(html) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        preserveOrder: true,
        commentPropName: 'comment',
        cdataPropName: 'cdata',
        format: true,
        indentBy: '  ',
        suppressEmptyNode: false
    });

    const parsed = parser.parse(html);
    sanitizeAppStreamNodes(parsed);
    return parsed;
}

export function parseMetainfoXml() {
    const xmlContent = fsOld.readFileSync(path.join(sourceDir, 'org.nuicpp.nui_sftp.metainfo.xml'), 'utf-8');
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        preserveOrder: true,
        commentPropName: 'comment',
        cdataPropName: 'cdata',
        format: true,
        indentBy: '  ',
        suppressEmptyNode: false
    });
    return parser.parse(xmlContent);
}

export async function updateReleasesInMetainfoXml(metainfoObj) {
    const releases = await getReleases('5cript/nui-sftp');

    if (metainfoObj.length < 2 || !metainfoObj[1].component) {
        throw new Error('Unexpected metainfo XML structure: missing component element');
    }
    const component = metainfoObj[1].component;

    // find in component array the index of which the object contains 'releases'
    const releasesIndex = component.findIndex(item => item.releases);
    if (releasesIndex === -1) {
        throw new Error('Unexpected metainfo XML structure: missing releases element');
    }

    console.log(component[releasesIndex].releases);

    const releasesInXml = component[releasesIndex].releases;
    // clear existing releases
    releasesInXml.length = 0;

    // add new releases
    for (const release of releases) {
        const releaseObj = {
            release: [
                {
                    description: htmlToFastXmlFormat(convertReleaseToHtml(release.body || 'No description provided.'))
                }
            ],
            ":@": {
                '@_version': parsedVersion(release.tag_name).full,
                '@_date': release.published_at.split('T')[0],
            }
        };
        releasesInXml.push(releaseObj);
    }

    const builder = new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        preserveOrder: true,
        commentPropName: 'comment',
        cdataPropName: 'cdata',
        format: true,
        indentBy: '    ',
        suppressEmptyNode: false
    });
    const updatedXml = builder.build(metainfoObj);
    fsOld.writeFileSync(path.join(sourceDir, 'org.nuicpp.nui_sftp.metainfo.xml'), updatedXml, 'utf-8');
}