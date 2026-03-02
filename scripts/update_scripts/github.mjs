// curl -H "X-Github-Api-Version: 2022-11-28" https://api.github.com/repos/5cript/nui-sftp/releases

const getReleases = async (repo) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases`, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'X-Github-Api-Version': '2022-11-28'
        }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch releases for repo ${repo}: ${response.status} ${response.statusText}`);
    }
    return await response.json();
}

export { getReleases };