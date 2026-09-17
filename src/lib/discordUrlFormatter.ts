const DISCORD_ATTACHMENT_HOST = /^(?:cdn|media)\.discordapp\.(?:com|net)$/i;
const DISCORD_ATTACHMENT_PATH = /^\/attachments\/\d+\/\d+\/[^/]+\.[^/?#]+$/i;
const URL_PATTERN = /https?:\/\/(?:(?!https?:\/\/)[^\s<>()"'])+/gi;

const normalizeEscapedText = (text: string) => text
  .replace(/https\\+:\/\//gi, 'https://')
  .replace(/\\&/g, '&')
  .replace(/&amp;/gi, '&');

export const extractDiscordAttachmentUrls = (text: string) => {
  const normalizedText = normalizeEscapedText(text);
  const matches = normalizedText.match(URL_PATTERN) ?? [];
  const uniqueUrls = new Set<string>();

  matches.forEach((match) => {
    const candidate = match.replace(/[},;]+$/g, '').replace(/]$/, '');

    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' || !DISCORD_ATTACHMENT_HOST.test(url.hostname)) return;
      if (!DISCORD_ATTACHMENT_PATH.test(url.pathname)) return;

      uniqueUrls.add(`${url.origin}${url.pathname}`);
    } catch {
      // Ignore malformed text fragments and keep formatting the remaining URLs.
    }
  });

  return Array.from(uniqueUrls);
};

export const formatDiscordUrls = (text: string) =>
  extractDiscordAttachmentUrls(text)
    .map((url) => `[.](${url})`)
    .join('\n');
