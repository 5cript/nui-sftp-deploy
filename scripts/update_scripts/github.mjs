// curl -H "X-Github-Api-Version: 2022-11-28" https://api.github.com/repos/5cript/nui-sftp/releases

let releasesMemo = null

const getReleases = async (repo) => {
    if (releasesMemo) {
        return releasesMemo;
    }
    const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'X-Github-Api-Version': '2022-11-28'
        }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch releases for repo ${repo}: ${response.status} ${response.statusText}`);
    }
    releasesMemo = await response.json();
    return releasesMemo;
}

export { getReleases };