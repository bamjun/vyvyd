import React, { useState } from 'react';
import { Eye, EyeOff, MessageCircle } from 'lucide-react';

interface DiscordWebhookFieldProps {
  value: string;
  onChange: (value: string) => void;
  loadedFromUrl: boolean;
}

export const DiscordWebhookField: React.FC<DiscordWebhookFieldProps> = ({ value, onChange, loadedFromUrl }) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <section className="glass-panel rounded-2xl border border-indigo-500/20 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="discord-webhook-url" className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-200">
            <MessageCircle className="h-4 w-4 text-indigo-400" />
            Discord Webhook URL
          </label>
          <div className="relative">
            <input
              id="discord-webhook-url"
              type={isVisible ? 'url' : 'password'}
              value={value}
              onChange={(event) => onChange(event.target.value)}
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
        </div>
        <p className="max-w-md text-[11px] leading-relaxed text-gray-500 md:pb-1">
          {loadedFromUrl
            ? '주소의 discord-webhook 값으로 자동 입력했습니다. 전송할 때만 결과 파일이 Discord로 업로드됩니다.'
            : '입력값은 저장하지 않습니다. ?discord-webhook=URL 또는 ?webhook=URL로 열면 자동 입력됩니다.'}
        </p>
      </div>
    </section>
  );
};
