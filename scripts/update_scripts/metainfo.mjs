import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import { sourceDir } from './files_and_dirs.mjs';
import { getReleases } from './github.mjs';

import showdown from 'showdown';
import fsOld from 'node:fs';
import path from 'node:path';

function convertReleaseToHtml(str) {
    // const window = new JSDOM('').window;
    // const purify = DOMPurify(window);
    // const clean = purify.sanitize(str);
    const converter = new showdown.Converter();
    const html = converter.makeHtml(str);
    return html;
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
                '@_version': release.tag_name,
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