import React, { useState } from 'react';
import { Frame, Images, Minimize2, Scissors } from 'lucide-react';
import { ImagePadding } from './ImagePadding';
import { ImageResizer } from './ImageResizer';
import { ImageSplitter } from './ImageSplitter';

interface ImageEditorProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
}

type EditorMode = 'padding' | 'resize' | 'split';

export const ImageEditor: React.FC<ImageEditorProps> = ({ onSuccess, discordWebhookUrl }) => {
  const [mode, setMode] = useState<EditorMode>('resize');

  return (
    <div className="relative space-y-8">
      <div className="flex flex-col justify-between gap-4 border-b border-white/5 pb-6 md:flex-row md:items-center">
        <div>
          <h3 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <Images className="h-5 w-5 text-purple-400" />
            Image Editor
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            9:16 여백 추가, 비율 유지 크기 조절, 균등 분할을 한 곳에서 처리합니다.
          </p>
        </div>

        <div className="grid shrink-0 grid-cols-1 gap-2 rounded-xl border border-white/5 bg-[#121318] p-1.5 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => setMode('padding')}
            className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
              mode === 'padding'
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            <Frame className="h-4 w-4" />
            9:16 여백 추가
          </button>
          <button
            type="button"
            onClick={() => setMode('resize')}
            className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
              mode === 'resize'
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            <Minimize2 className="h-4 w-4" />
            크기 줄이기
          </button>
          <button
            type="button"
            onClick={() => setMode('split')}
            className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
              mode === 'split'
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            <Scissors className="h-4 w-4" />
            균등 자르기
          </button>
        </div>
      </div>

      <div className={mode === 'padding' ? 'block' : 'hidden'}>
        <ImagePadding onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
      <div className={mode === 'resize' ? 'block' : 'hidden'}>
        <ImageResizer onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
      <div className={mode === 'split' ? 'block' : 'hidden'}>
        <ImageSplitter onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
    </div>
  );
};
