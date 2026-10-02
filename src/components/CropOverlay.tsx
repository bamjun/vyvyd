import React, { useEffect, useMemo, useRef, useState } from 'react';
import { centerCrop, constrainCrop, CropDragMode, getDraggedCrop } from '@/lib/cropPresets';

interface CropOverlayProps {
  mediaWidth: number;
  mediaHeight: number;
  crop: { x: number; y: number; width: number; height: number };
  setCrop: (crop: { x: number; y: number; width: number; height: number }) => void;
  mediaRef: React.RefObject<HTMLElement>;
  aspectRatio?: number;
}

interface DragState {
  mode: CropDragMode;
  startClientX: number;
  startClientY: number;
  startCrop: { x: number; y: number; width: number; height: number };
}

interface MediaRect {
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export const CropOverlay: React.FC<CropOverlayProps> = ({
  mediaWidth,
  mediaHeight,
  crop,
  setCrop,
  mediaRef,
  aspectRatio,
}) => {
  const [mediaRect, setMediaRect] = useState<MediaRect>({ width: 0, height: 0 });
  const dragRef = useRef<DragState | null>(null);

  const updateMediaDimensions = () => {
    const media = mediaRef.current;
    if (!media) return;

    const rect = media.getBoundingClientRect();
    setMediaRect({ width: rect.width, height: rect.height });
  };

  useEffect(() => {
    const frameId = window.requestAnimationFrame(updateMediaDimensions);
    window.addEventListener('resize', updateMediaDimensions);

    const media = mediaRef.current;
    const resizeObserver = typeof ResizeObserver !== 'undefined' && media
      ? new ResizeObserver(updateMediaDimensions)
      : null;
    if (resizeObserver && media) {
      resizeObserver.observe(media);
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updateMediaDimensions);
      resizeObserver?.disconnect();
    };
  }, [mediaRef, mediaWidth, mediaHeight]);

  const scaleX = mediaWidth > 0 ? mediaRect.width / mediaWidth : 0;
  const scaleY = mediaHeight > 0 ? mediaRect.height / mediaHeight : 0;
  const uiBox = useMemo(() => ({
    left: crop.x * scaleX,
    top: crop.y * scaleY,
    width: crop.width * scaleX,
    height: crop.height * scaleY,
  }), [crop, scaleX, scaleY]);

  const getNaturalPoint = (clientX: number, clientY: number) => {
    const media = mediaRef.current;
    if (!media || scaleX === 0 || scaleY === 0) return { x: 0, y: 0 };

    const rect = media.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / scaleX, 0, mediaWidth),
      y: clamp((clientY - rect.top) / scaleY, 0, mediaHeight),
    };
  };

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, mode: CropDragMode) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (mode === 'create') {
      const point = getNaturalPoint(event.clientX, event.clientY);
      dragRef.current = {
        mode,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startCrop: { x: point.x, y: point.y, width: 0, height: 0 },
      };
      setCrop(getDraggedCrop(dragRef.current.startCrop, { width: mediaWidth, height: mediaHeight }, 'create', { x: 0, y: 0 }, aspectRatio));
      return;
    }

    dragRef.current = {
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: { ...crop },
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || scaleX === 0 || scaleY === 0) return;
    event.preventDefault();
    event.stopPropagation();

    const dx = (event.clientX - drag.startClientX) / scaleX;
    const dy = (event.clientY - drag.startClientY) / scaleY;
    setCrop(getDraggedCrop(drag.startCrop, { width: mediaWidth, height: mediaHeight }, drag.mode, { x: dx, y: dy }, aspectRatio));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (drag.mode === 'create' && (crop.width < 15 || crop.height < 15)) {
      const source = { width: mediaWidth, height: mediaHeight };
      setCrop(centerCrop(constrainCrop({ x: 0, y: 0, ...source }, source, aspectRatio), source));
    }
    dragRef.current = null;
  };

  if (mediaRect.width === 0 || mediaRect.height === 0) return null;

  return (
    <div
      className="absolute select-none touch-none cursor-crosshair"
      style={{
        width: `${mediaRect.width}px`,
        height: `${mediaRect.height}px`,
        // The media is centered inside its flex parent. Match that exact center.
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
      }}
      onPointerDown={(event) => beginDrag(event, 'create')}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {uiBox.width > 0 && uiBox.height > 0 && (
        <div
          className="absolute border-2 border-dashed border-purple-400 bg-purple-500/5 group"
          style={{
            left: `${uiBox.left}px`,
            top: `${uiBox.top}px`,
            width: `${uiBox.width}px`,
            height: `${uiBox.height}px`,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div
            className="w-full h-full cursor-move"
            onPointerDown={(event) => beginDrag(event, 'move')}
          />

          <div className="absolute top-0 left-0 bg-purple-500 text-white text-[10px] px-1 font-mono select-none pointer-events-none">
            {crop.width}x{crop.height}
          </div>

          <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-purple-500 rounded-full border border-white cursor-nwse-resize z-10" onPointerDown={(event) => beginDrag(event, 'tl')} />
          <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-purple-500 rounded-full border border-white cursor-nesw-resize z-10" onPointerDown={(event) => beginDrag(event, 'tr')} />
          <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-purple-500 rounded-full border border-white cursor-nesw-resize z-10" onPointerDown={(event) => beginDrag(event, 'bl')} />
          <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-purple-500 rounded-full border border-white cursor-nwse-resize z-10" onPointerDown={(event) => beginDrag(event, 'br')} />
          <div className="absolute -top-1 left-1.5 right-1.5 h-2 cursor-ns-resize" onPointerDown={(event) => beginDrag(event, 't')} />
          <div className="absolute -bottom-1 left-1.5 right-1.5 h-2 cursor-ns-resize" onPointerDown={(event) => beginDrag(event, 'b')} />
          <div className="absolute -left-1 top-1.5 bottom-1.5 w-2 cursor-ew-resize" onPointerDown={(event) => beginDrag(event, 'l')} />
          <div className="absolute -right-1 top-1.5 bottom-1.5 w-2 cursor-ew-resize" onPointerDown={(event) => beginDrag(event, 'r')} />
        </div>
      )}
    </div>
  );
};
