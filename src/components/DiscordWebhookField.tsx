import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, MessageCircle, Save, X } from 'lucide-react';
import {
  getStoredDiscordWebhooks,
  removeStoredDiscordWebhook,
  storeDiscordWebhook,
} from '@/lib/discordWebhook';

interface DiscordWebhookFieldProps {
  value: string;
  onChange: (value: string) => void;
  loadedFromUrl: boolean;
}

export const DiscordWebhookField: React.FC<DiscordWebhookFieldProps> = ({ value, onChange, loadedFromUrl }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [savedWebhooks, setSavedWebhooks] = useState<string[]>(getStoredDiscordWebhooks);
  const [storageStatus, setStorageStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const saveWebhook = () => {
    try {
      setSavedWebhooks(storeDiscordWebhook(value));
      setStorageStatus({ tone: 'success', message: '웹훅 URL을 이 브라우저에 저장했습니다.' });
    } catch (error) {
      setStorageStatus({
        tone: 'error',
        message: error instanceof Error ? error.message : '웹훅 URL을 저장하지 못했습니다.',
      });
    }
  };

  const removeWebhook = (url: string) => {
    try {
      setSavedWebhooks(removeStoredDiscordWebhook(url));
      setStorageStatus({ tone: 'success', message: '저장된 웹훅 URL을 삭제했습니다.' });
    } catch {
      setStorageStatus({ tone: 'error', message: '저장된 웹훅 URL을 삭제하지 못했습니다.' });
    }
  };

  const getMaskedLabel = (rawUrl: string) => {
    try {
      const url = new URL(rawUrl);
      const pathParts = url.pathname.split('/').filter(Boolean);
      const webhookId = pathParts[pathParts.length - 2] ?? 'unknown';
      const abbreviatedId = webhookId.length > 12
        ? `${webhookId.slice(0, 6)}…${webhookId.slice(-4)}`
        : webhookId;
      return `${url.hostname} · ${abbreviatedId} · ••••••••`;
    } catch {
      return '저장된 Discord Webhook';
    }
  };

  return (
    <section className="glass-panel rounded-2xl border border-indigo-500/20 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="discord-webhook-url" className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-200">
            <MessageCircle className="h-4 w-4 text-indigo-400" />
            Discord Webhook URL
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <input
                id="discord-webhook-url"
                type={isVisible ? 'url' : 'password'}
                value={value}
                onChange={(event) => {
                  onChange(event.target.value);
                  setStorageStatus(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveWebhook();
                }}
                placeholder="https://discord.com/api/webhooks/..."
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="w-full rounded-xl border border-white/10 bg-[#121318] px-4 py-3 pr-12 text-sm text-gray-200 outline-none transition placeholder:text-gray-600 focus:border-indigo-500"
              />
              <button
                type="button"
                onClick={() => setIsVisible((current) => !current)}
                className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-gray-500 transition hover:text-gray-300"
                aria-label={isVisible ? '웹훅 URL 숨기기' : '웹훅 URL 보기'}
                title={isVisible ? 'URL 숨기기' : 'URL 보기'}
              >
                {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <button
              type="button"
              onClick={saveWebhook}
              disabled={!value.trim()}
              className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save className="h-4 w-4" />
              저장
            </button>
          </div>
        </div>
        <p className="max-w-md text-[11px] leading-relaxed text-gray-500 md:pb-1">
          {loadedFromUrl
            ? '주소의 discord-webhook 값으로 자동 입력했습니다. 전송할 때만 결과 파일이 Discord로 업로드됩니다.'
            : '저장한 URL은 이 브라우저의 localStorage에 보관됩니다. 공용 기기에서는 저장하지 마세요.'}
        </p>
      </div>

      {storageStatus && (
        <div className={`mt-3 flex items-center gap-2 text-xs ${storageStatus.tone === 'success' ? 'text-green-300' : 'text-red-300'}`} role="status">
          {storageStatus.tone === 'success'
            ? <CheckCircle2 className="h-4 w-4 shrink-0" />
            : <AlertCircle className="h-4 w-4 shrink-0" />}
          {storageStatus.message}
        </div>
      )}

      {savedWebhooks.length > 0 && (
        <div className="mt-4 border-t border-white/5 pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400">저장된 웹훅</span>
            <span className="text-[10px] text-gray-600">{savedWebhooks.length}개</span>
          </div>
          <div className="space-y-2">
            {savedWebhooks.map((url, index) => (
              <div key={url} className="flex items-center gap-2 rounded-xl border border-white/5 bg-black/20 p-2">
                <button
                  type="button"
                  onClick={() => {
                    onChange(url);
                    setStorageStatus({ tone: 'success', message: `저장된 웹훅 ${index + 1}번을 불러왔습니다.` });
                  }}
                  className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5"
                >
                  <span className="block text-[10px] font-semibold text-indigo-300">Webhook {index + 1}</span>
                  <span className="block truncate font-mono text-[11px] text-gray-500">{getMaskedLabel(url)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeWebhook(url)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 transition hover:bg-red-500/10 hover:text-red-300"
                  aria-label={`저장된 웹훅 ${index + 1} 삭제`}
                  title="삭제"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
