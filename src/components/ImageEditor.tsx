import React from 'react';
import { useMediaTransfer } from '@/hooks/useMediaTransfer';
import { Crop, Frame, Images, Minimize2, PanelsTopLeft, Scissors } from 'lucide-react';
import { ImageCropper } from './ImageCropper';
import { ImagePadding } from './ImagePadding';
import { ImageResizer } from './ImageResizer';
import { ImageSplitter } from './ImageSplitter';
import { MediaMerger } from './MediaMerger';

interface ImageEditorProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
}

export type EditorMode = 'padding' | 'resize' | 'split' | 'crop' | 'merge';

export const ImageEditor: React.FC<ImageEditorProps> = ({ onSuccess, discordWebhookUrl, mode, onModeChange: setMode }) => {
  const { notice } = useMediaTransfer();

  return (
    <div className="relative space-y-8">
      <div className="flex flex-col gap-4 border-b border-white/5 pb-6">
        <div>
          <h3 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <Images className="h-5 w-5 text-purple-400" />
            Image Editor
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            9:16 여백 추가, 크기 조절, 균등 분할, 자유 자르기, 이미지·GIF 합치기를 한 곳에서 처리합니다.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 rounded-xl border border-white/5 bg-[#121318] p-1.5 sm:grid-cols-2 lg:grid-cols-5">
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
          <button
            type="button"
            onClick={() => setMode('crop')}
            className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
              mode === 'crop'
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            <Crop className="h-4 w-4" />
            자유 자르기
          </button>
          <button
            type="button"
            onClick={() => setMode('merge')}
            className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
              mode === 'merge'
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            <PanelsTopLeft className="h-4 w-4" />
            합치기
          </button>
        </div>
      </div>

      {notice?.target === mode && <p role="status" className="rounded-xl border border-purple-500/20 bg-purple-500/10 p-3 text-sm text-purple-200">{notice.message}</p>}

      <div className={mode === 'padding' ? 'block' : 'hidden'}>
        <ImagePadding onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
      <div className={mode === 'resize' ? 'block' : 'hidden'}>
        <ImageResizer onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
      <div className={mode === 'split' ? 'block' : 'hidden'}>
        <ImageSplitter onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
      <div className={mode === 'crop' ? 'block' : 'hidden'}>
        <ImageCropper onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
      <div className={mode === 'merge' ? 'block' : 'hidden'}>
        <MediaMerger onSuccess={onSuccess} discordWebhookUrl={discordWebhookUrl} />
      </div>
    </div>
  );
};
