export interface DiscordUploadSource {
  url: string;
  name: string;
}

interface SendDiscordFilesOptions {
  onBatchProgress?: (completedBatches: number, totalBatches: number) => void;
}

const FILES_PER_MESSAGE = 10;
const DISCORD_WEBHOOK_STORAGE_KEY = 'vyvyd.discord-webhooks.v1';
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'www.discord.com',
  'canary.discord.com',
  'ptb.discord.com',
  'discordapp.com',
  'www.discordapp.com',
]);

const sleep = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const getWebhookEndpoint = (rawUrl: string) => {
  const trimmedUrl = rawUrl.trim();
  if (!trimmedUrl) {
    throw new Error('Discord Webhook URL을 먼저 입력해 주세요.');
  }

  let url: URL;
  try {
    url = new URL(trimmedUrl);
  } catch {
    throw new Error('올바른 Discord Webhook URL을 입력해 주세요.');
  }

  const webhookPath = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/?#]+\/?$/;
  if (url.protocol !== 'https:' || !DISCORD_WEBHOOK_HOSTS.has(url.hostname) || !webhookPath.test(url.pathname)) {
    throw new Error('discord.com의 올바른 Webhook URL만 사용할 수 있습니다.');
  }

  url.searchParams.set('wait', 'true');
  return url.toString();
};

export const isDiscordWebhookUrl = (rawUrl: string) => {
  try {
    getWebhookEndpoint(rawUrl);
    return true;
  } catch {
    return false;
  }
};

export const getStoredDiscordWebhooks = () => {
  try {
    const storedValue = window.localStorage.getItem(DISCORD_WEBHOOK_STORAGE_KEY);
    if (!storedValue) return [];

    const parsed = JSON.parse(storedValue) as unknown;
    if (!Array.isArray(parsed)) return [];

    return Array.from(new Set(
      parsed.filter((item): item is string => typeof item === 'string' && isDiscordWebhookUrl(item)),
    ));
  } catch {
    return [];
  }
};

export const storeDiscordWebhook = (rawUrl: string) => {
  const url = rawUrl.trim();
  if (!isDiscordWebhookUrl(url)) {
    throw new Error('올바른 Discord Webhook URL을 입력해 주세요.');
  }

  const nextWebhooks = [url, ...getStoredDiscordWebhooks().filter((storedUrl) => storedUrl !== url)];
  window.localStorage.setItem(DISCORD_WEBHOOK_STORAGE_KEY, JSON.stringify(nextWebhooks));
  return nextWebhooks;
};

export const removeStoredDiscordWebhook = (url: string) => {
  const nextWebhooks = getStoredDiscordWebhooks().filter((storedUrl) => storedUrl !== url);
  window.localStorage.setItem(DISCORD_WEBHOOK_STORAGE_KEY, JSON.stringify(nextWebhooks));
  return nextWebhooks;
};

const getResponseError = (status: number) => {
  if (status === 401 || status === 403 || status === 404) {
    return '웹훅이 유효하지 않거나 삭제되었습니다. URL을 확인해 주세요.';
  }
  if (status === 413) {
    return 'Discord의 파일 업로드 용량 제한을 초과했습니다.';
  }
  if (status === 429) {
    return 'Discord 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  }
  return `Discord 전송에 실패했습니다. (HTTP ${status})`;
};

const getRetryDelay = async (response: Response) => {
  try {
    const body = await response.clone().json() as { retry_after?: number };
    if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) {
      return Math.max(250, Math.ceil(body.retry_after * 1000));
    }
  } catch {
    // Fall back to the rate-limit header below.
  }

  const resetAfter = Number(response.headers.get('X-RateLimit-Reset-After'));
  return Number.isFinite(resetAfter) ? Math.max(250, Math.ceil(resetAfter * 1000)) : 1000;
};

const createFormData = async (
  sources: DiscordUploadSource[],
  batchNumber: number,
  totalBatches: number,
) => {
  const files = await Promise.all(
    sources.map(async (source) => {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`전송할 파일을 읽지 못했습니다. (${source.name})`);
      const blob = await response.blob();
      return new File([blob], source.name, { type: blob.type });
    }),
  );

  const batchLabel = totalBatches > 1 ? ` (${batchNumber}/${totalBatches})` : '';
  const formData = new FormData();
  formData.append('payload_json', JSON.stringify({
    content: `vyvyd에서 보낸 파일 ${files.length}개${batchLabel}`,
    allowed_mentions: { parse: [] },
  }));
  files.forEach((file, index) => formData.append(`files[${index}]`, file, file.name));
  return formData;
};

const sendBatch = async (endpoint: string, formData: FormData) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, { method: 'POST', body: formData });
    } catch {
      throw new Error('Discord에 연결하지 못했습니다. 네트워크 상태와 웹훅 URL을 확인해 주세요.');
    }

    if (response.ok) return;
    if (response.status !== 429 || attempt === 2) {
      throw new Error(getResponseError(response.status));
    }

    await sleep(await getRetryDelay(response));
  }
};

export const getDiscordWebhookFromSearch = (search: string) => {
  const params = new URLSearchParams(search);
  return (params.get('discord-webhook') ?? params.get('webhook') ?? '').trim();
};

export const sendFilesToDiscord = async (
  webhookUrl: string,
  sources: DiscordUploadSource[],
  options: SendDiscordFilesOptions = {},
) => {
  if (sources.length === 0) throw new Error('Discord로 보낼 파일이 없습니다.');

  const endpoint = getWebhookEndpoint(webhookUrl);
  const totalBatches = Math.ceil(sources.length / FILES_PER_MESSAGE);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const startIndex = batchIndex * FILES_PER_MESSAGE;
    const batch = sources.slice(startIndex, startIndex + FILES_PER_MESSAGE);
    const formData = await createFormData(batch, batchIndex + 1, totalBatches);
    await sendBatch(endpoint, formData);
    options.onBatchProgress?.(batchIndex + 1, totalBatches);
  }
};
