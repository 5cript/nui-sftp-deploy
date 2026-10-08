// curl -H "X-Github-Api-Version: 2022-11-28" https://api.github.com/repos/5cript/nui-sftp/releases

let releasesMemo = null

const getReleases = async (repo) => {
    if (releasesMemo) {
        return releasesMemo;
    }
    // The API pages its results (30 per page by default), so collect every page.
    const releases = [];
    for (let page = 1; ; ++page) {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
            headers: {
                'Accept': 'application/vnd.github+json',
                'X-Github-Api-Version': '2022-11-28'
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch releases for repo ${repo}: ${response.status} ${response.statusText}`);
        }
        const pageReleases = await response.json();
        releases.push(...pageReleases);
        if (pageReleases.length < 100) {
            break;
        }
    }
    releasesMemo = releases;
    return releasesMemo;
}

export { getReleases };