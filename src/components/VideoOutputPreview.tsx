import { useEffect, useRef } from 'react';
import { getVideoOutputGeometry } from '@/lib/videoGeometry';
import type { VideoCrop, VideoFitMode } from '@/lib/videoGeometry';

interface VideoOutputPreviewProps {
  sourceId: string;
  videoRef: React.RefObject<HTMLVideoElement>;
  crop: VideoCrop;
  outputWidth: string;
  outputHeight: string;
  fitMode: VideoFitMode;
}

export const VideoOutputPreview = ({ sourceId, videoRef, crop, outputWidth, outputHeight, fitMode }: VideoOutputPreviewProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = Number(outputWidth);
  const height = Number(outputHeight);
  const valid = Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !valid) return;
    const geometry = getVideoOutputGeometry(crop, { width, height }, fitMode);
    const previewScale = Math.min(320 / width, 220 / height, 1);
    canvas.width = Math.max(1, Math.round(width * previewScale));
    canvas.height = Math.max(1, Math.round(height * previewScale));
    const context = canvas.getContext('2d');
    if (!context) return;
    const draw = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (video.readyState < 2) return;
      context.drawImage(video, crop.x, crop.y, crop.width, crop.height,
        geometry.offsetX * previewScale, geometry.offsetY * previewScale,
        geometry.scaledWidth * previewScale, geometry.scaledHeight * previewScale);
    };
    const events = ['loadeddata', 'seeked', 'timeupdate', 'pause'] as const;
    events.forEach((event) => video.addEventListener(event, draw));
    draw();
    return () => events.forEach((event) => video.removeEventListener(event, draw));
  }, [sourceId, videoRef, crop, width, height, fitMode, valid]);

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex flex-wrap justify-between gap-2 text-xs text-gray-400">
        <span>출력 구도 미리보기 · 현재 프레임</span>
        {valid && <span>{width} × {height}px</span>}
      </div>
      {valid ? (
        <div className="flex min-h-24 items-center justify-center overflow-hidden rounded-lg">
          <canvas ref={canvasRef} role="img" aria-label={`${fitMode === 'contain' ? '전체 맞춤' : '영역 채우기'} 출력 미리보기`} className="max-w-full object-contain" style={{ backgroundColor: '#252733', backgroundImage: 'conic-gradient(#3a3c49 25%, transparent 0 50%, #3a3c49 0 75%, transparent 0)', backgroundSize: '16px 16px' }} />
        </div>
      ) : <p className="text-xs text-amber-300">출력 가로와 세로를 1 이상의 정수로 입력해 주세요.</p>}
    </div>
  );
};
