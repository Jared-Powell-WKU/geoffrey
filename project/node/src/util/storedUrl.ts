// The web-add notice and the extractor live together because reaction-based
// removal (checkForImageDeletion) only works if the extractor recovers exactly
// the URL string that was stored. The URL goes in raw, not as <url>: Discord
// then embeds the image for the mods, and the extractor needs no unwrapping.
export function formatWebAddNotice(userId: string, url: string): string {
    return `<@${userId}> added an image via cantus.dev: ${url}`;
}

// Bot-authored messages carry the stored URL as their first https URL: the
// /homies and /cute rolls start with it and the web-add notice ends with it.
// Web-added URLs can be on any host, so this is not limited to the Discord CDN.
export function getStoredUrlFromContent(content: string|null|undefined): string|null {
    if(!content) return null;
    return /https:\/\/[^\s]+/.exec(content)?.[0] || null;
}
