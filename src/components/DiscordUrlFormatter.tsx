import React, { useMemo, useState } from 'react';
import { Check, ClipboardCopy, Eraser, Link2, WandSparkles } from 'lucide-react';
import { extractDiscordAttachmentUrls, formatDiscordUrls } from '@/lib/discordUrlFormatter';

const copyText = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
};

export const DiscordUrlFormatter: React.FC = () => {
  const [input, setInput] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const urls = useMemo(() => extractDiscordAttachmentUrls(input), [input]);
  const output = useMemo(() => formatDiscordUrls(input), [input]);

  const handleCopy = async () => {
    if (!output) return;

    try {
      await copyText(output);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const clear = () => {
    setInput('');
    setCopyState('idle');
  };

  return (
    <div className="relative space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-md border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-sm font-semibold text-indigo-300">
              URL Tool
            </span>
            <span className="text-xs text-gray-500">브라우저에서만 처리됩니다</span>
          </div>
          <h3 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <Link2 className="h-5 w-5 text-indigo-400" />
            Discord URL Formatter
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            Discord 첨부 링크가 줄바꿈 없이 붙어 있어도 분리하고, 만료 쿼리를 제거해 Markdown 링크로 정리합니다.
          </p>
        </div>
        <button
          type="button"
          onClick={clear}
          disabled={!input}
          className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-gray-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Eraser className="h-4 w-4" />
          전체 지우기
        </button>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="discord-url-input" className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              입력 텍스트
            </label>
            <span className="text-[11px] text-gray-500">일반 URL · Markdown · https\:// 지원</span>
          </div>
          <textarea
            id="discord-url-input"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setCopyState('idle');
            }}
            placeholder={'Discord 첨부 링크가 포함된 텍스트를 붙여넣으세요.\n\nhttps\\://media.discordapp.net/attachments/.../file.any?ex=...'}
            spellCheck={false}
            className="min-h-[360px] w-full resize-y rounded-2xl border border-white/10 bg-[#121318] p-4 font-mono text-xs leading-6 text-gray-200 outline-none transition placeholder:text-gray-600 focus:border-purple-500"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="discord-url-output" className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              변환 결과
            </label>
            <span className="text-[11px] text-indigo-300">{urls.length}개 URL</span>
          </div>
          <textarea
            id="discord-url-output"
            value={output}
            readOnly
            placeholder="[.](https://media.discordapp.net/attachments/.../file.any)"
            spellCheck={false}
            className="min-h-[360px] w-full resize-y rounded-2xl border border-indigo-500/20 bg-black/30 p-4 font-mono text-xs leading-6 text-indigo-100 outline-none placeholder:text-gray-700"
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-xs text-gray-500">
          <WandSparkles className="mt-0.5 h-4 w-4 shrink-0 text-purple-400" />
          <span>붙어 있는 URL 분리 · 쿼리스트링 제거 · 중복 제거 · 확장자 제한 없음 · 입력 순서 유지</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!output}
          className={`flex min-w-40 items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
            copyState === 'copied'
              ? 'bg-green-600 text-white'
              : copyState === 'error'
                ? 'bg-red-600 text-white'
                : 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-500 hover:to-indigo-500'
          }`}
        >
          {copyState === 'copied' ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
          {copyState === 'copied' ? '복사 완료' : copyState === 'error' ? '복사 실패' : '결과 복사'}
        </button>
      </div>

      {input && urls.length === 0 && (
        <p className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
          Discord 첨부 URL을 찾지 못했습니다. 주소에 /attachments/ 경로와 파일 확장자가 있는지 확인해 주세요.
        </p>
      )}
    </div>
  );
};
