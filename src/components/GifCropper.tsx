import React, { useState, useRef, useEffect } from 'react';
import { formatBytes } from '@/lib/utils';
import { fetchFile } from '@ffmpeg/util';
import { Image as ImageIcon, Download, Sparkles, AlertCircle, RefreshCw, Loader2, Send } from 'lucide-react';
import confetti from 'canvas-confetti';
import { CropOverlay } from './CropOverlay';
import { DiscordSendStatus } from './DiscordSendStatus';
import ffmpeg, { loadFFmpeg as initFFmpeg } from '@/lib/ffmpeg';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';

interface GifCropperProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
}

export const GifCropper: React.FC<GifCropperProps> = ({ onSuccess, discordWebhookUrl }) => {
  const [gifFile, setGifFile] = useState<File | null>(null);
  const [gifSrc, setGifSrc] = useState<string>('');
  const [gifWidth, setGifWidth] = useState<number>(0);
  const [gifHeight, setGifHeight] = useState<number>(0);

  // Settings
  const [scale, setScale] = useState<number>(1.0);
  
  // Processing states
  const [isWasmLoading, setIsWasmLoading] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [gifResult, setGifResult] = useState<string>('');
  const [gifSize, setGifSize] = useState<number>(0);

  // Crop State
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const imageRef = useRef<HTMLImageElement>(null);
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);

  // Cleanup Object URL on unmount
  useEffect(() => {
    return () => {
      if (gifSrc) URL.revokeObjectURL(gifSrc);
      if (gifResult) URL.revokeObjectURL(gifResult);
    };
  }, [gifSrc, gifResult]);

  const loadFFmpeg = async () => {
    if (ffmpeg.loaded) return;
    setIsWasmLoading(true);
    setProgressMsg('Loading FFmpeg WebAssembly...');
    try {
      await initFFmpeg(
        (msg) => setProgressMsg(msg),
        () => {}
      );
    } catch (err: any) {
      console.error('Failed to load FFmpeg WASM', err);
      alert(`Failed to load FFmpeg: ${err?.message || err}. Please ensure the Vite server was restarted to apply Cross-Origin Isolation headers.`);
    } finally {
      setIsWasmLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setGifFile(file);
    const url = URL.createObjectURL(file);
    setGifSrc(url);
    setGifResult('');
    setGifSize(0);

    // Eager load FFmpeg when file is selected
    await loadFFmpeg();
  };

  const handleImageLoad = () => {
    const img = imageRef.current;
    if (!img) return;

    setGifWidth(img.naturalWidth);
    setGifHeight(img.naturalHeight);

    // Initial Crop (full size)
    setCrop({
      x: 0,
      y: 0,
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  };

  const cropGif = async () => {
    if (!gifFile || isProcessing) return;

    // Ensure FFmpeg is loaded
    if (!ffmpeg.loaded) {
      await loadFFmpeg();
    }

    setIsProcessing(true);
    setGifResult('');

    const targetW = Math.round(crop.width * scale);
    const targetH = Math.round(crop.height * scale);

    try {
      setProgressMsg('Step 1/2: Loading GIF file...');
      const gifData = await fetchFile(gifFile);
      await ffmpeg.writeFile('input.gif', gifData);

      // FFmpeg filter string representing cropping and scaling operations
      setProgressMsg('Step 2/2: Cropping and resizing GIF...');
      const filterString = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${targetW}:${targetH}`;

      // Run FFmpeg to crop and preserve quality. 
      // Since input is already a GIF, FFmpeg processes it natively frame-by-frame.
      await ffmpeg.exec([
        '-i', 'input.gif',
        '-vf', filterString,
        'output.gif',
      ]);

      setProgressMsg('Finalizing...');
      const data = await ffmpeg.readFile('output.gif');
      const croppedBlob = new Blob([data as any], { type: 'image/gif' });
      const croppedUrl = URL.createObjectURL(croppedBlob);

      setGifResult(croppedUrl);
      setGifSize(croppedBlob.size);
      onSuccess(croppedBlob.size);

      // Clean up files in virtual FS
      await ffmpeg.deleteFile('input.gif');
      await ffmpeg.deleteFile('output.gif');

      // Celebration confetti
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.8 },
      });
    } catch (err) {
      console.error(err);
      alert('Error during cropping. Check console.');
    } finally {
      setIsProcessing(false);
      setProgressMsg('');
    }
  };

  const resetCrop = () => {
    setCrop({
      x: 0,
      y: 0,
      width: gifWidth,
      height: gifHeight,
    });
  };

  const sendResultToDiscord = () => {
    if (!gifResult) return;
    void sendToDiscord('cropped-gif', [{
      url: gifResult,
      name: `cropped_${gifFile?.name || 'result.gif'}`,
    }]);
  };

  return (
    <div className="space-y-8">
      {/* File Selector */}
      {!gifSrc ? (
        <div className="flex flex-col items-center justify-center border-2 border-dashed border-purple-500/20 hover:border-purple-500/50 rounded-2xl p-12 bg-white/5 transition duration-300">
          <ImageIcon className="w-16 h-16 text-purple-400 mb-4 animate-pulse" />
          <h3 className="text-xl font-medium mb-1">Upload Animated GIF</h3>
          <p className="text-gray-400 text-sm mb-6 text-center max-w-xs">
            Select an animated GIF file to crop or scale entirely inside your browser using FFmpeg WASM.
          </p>
          <label className="px-6 py-3 bg-purple-600 hover:bg-purple-700 font-medium rounded-xl cursor-pointer shadow-lg hover:shadow-purple-500/20 transition">
            Choose GIF File
            <input type="file" accept="image/gif" onChange={handleFileChange} className="hidden" />
          </label>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column - GIF Preview & Cropper */}
          <div className="lg:col-span-7 space-y-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center space-x-2">
                <span className="text-sm font-semibold px-2.5 py-1 bg-purple-500/10 text-purple-400 rounded-md border border-purple-500/20">
                  Step 1
                </span>
                <span className="font-medium text-gray-200">Adjust borders/drag box to crop GIF</span>
              </div>
              <button
                onClick={resetCrop}
                className="text-xs text-purple-400 hover:text-purple-300 flex items-center space-x-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Reset Crop</span>
              </button>
            </div>

            {/* GIF Preview Container with New CropOverlay */}
            <div
              className="relative rounded-2xl overflow-hidden glass-panel select-none flex items-center justify-center bg-black"
              style={{ minHeight: '300px' }}
            >
              <img
                ref={imageRef}
                src={gifSrc}
                onLoad={handleImageLoad}
                className="max-h-[500px] w-auto max-w-full relative z-0"
                alt="Original GIF"
              />

              {/* CropOverlay Wrapper */}
              {gifWidth > 0 && (
                <CropOverlay
                  mediaWidth={gifWidth}
                  mediaHeight={gifHeight}
                  crop={crop}
                  setCrop={setCrop}
                  mediaRef={imageRef}
                />
              )}
            </div>
            <div className="text-xs text-gray-500 flex justify-between px-1">
              <span>Original size: {gifWidth}x{gifHeight}</span>
              <span>Crop: X:{crop.x}, Y:{crop.y}, {crop.width}x{crop.height}</span>
            </div>
          </div>

          {/* Right Column - Controls */}
          <div className="lg:col-span-5 space-y-6">
            <div className="glass-panel-glow rounded-2xl p-6 space-y-6">
              <h3 className="text-lg font-semibold flex items-center space-x-2 border-b border-white/5 pb-3">
                <Sparkles className="w-5 h-5 text-purple-400" />
                <span>Crop Settings (FFmpeg)</span>
              </h3>

              <div className="space-y-5">
                {/* Scale Slider */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-semibold uppercase text-gray-400">Scale (Resize Factor)</label>
                    <span className="text-xs font-mono text-purple-400">{Math.round(scale * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={1.5}
                    step={0.05}
                    value={scale}
                    onChange={(e) => setScale(Number(e.target.value))}
                    className="w-full accent-purple-500 bg-white/5 h-1.5 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-[10px] text-gray-500 block mt-1">
                    Output GIF Size: {Math.round(crop.width * scale)}x{Math.round(crop.height * scale)} px
                  </span>
                </div>
              </div>

              {/* Action Button */}
              {isWasmLoading ? (
                <div className="w-full py-4 bg-[#121318] border border-white/10 rounded-xl flex items-center justify-center space-x-3 text-purple-400 font-medium">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Loading FFmpeg WebAssembly...</span>
                </div>
              ) : !isProcessing ? (
                <button
                  onClick={cropGif}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 font-medium rounded-xl shadow-lg shadow-purple-500/10 hover:shadow-purple-500/25 transition duration-300 flex items-center justify-center space-x-2"
                >
                  <Sparkles className="w-5 h-5 animate-pulse" />
                  <span>Crop using FFmpeg</span>
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-3 flex flex-col items-center justify-center space-y-2">
                    <div className="flex items-center space-x-2">
                      <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />
                      <span className="text-sm font-medium text-purple-400">Processing in Browser</span>
                    </div>
                    <span className="text-xs text-gray-400 text-center">{progressMsg}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Results Render Box */}
            {gifResult && (
              <div className="glass-panel rounded-2xl p-6 space-y-4 border border-green-500/20">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-semibold text-green-400 flex items-center space-x-1.5">
                    <AlertCircle className="w-4 h-4" />
                    <span>Cropped GIF Ready!</span>
                  </span>
                  <span className="text-xs font-mono text-gray-400 bg-white/5 px-2 py-0.5 rounded">
                    {formatBytes(gifSize)}
                  </span>
                </div>
                <div className="rounded-xl overflow-hidden bg-black/40 p-2 flex justify-center border border-white/5 max-h-[300px]">
                  <img src={gifResult} alt="Cropped GIF" className="max-h-[280px] object-contain rounded" />
                </div>
                <DiscordSendStatus status={discordStatus} />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <a
                    href={gifResult}
                    download={`cropped_${gifFile?.name || 'result.gif'}`}
                    className="w-full py-3.5 bg-green-600 hover:bg-green-500 font-medium rounded-xl text-center flex items-center justify-center space-x-2 shadow-lg shadow-green-500/10 hover:shadow-green-500/20 transition"
                  >
                    <Download className="w-5 h-5" />
                    <span>Download GIF</span>
                  </a>
                  <button
                    type="button"
                    onClick={sendResultToDiscord}
                    disabled={activeRequestId !== null}
                    className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 font-medium rounded-xl text-center flex items-center justify-center space-x-2 shadow-lg shadow-indigo-500/10 hover:shadow-indigo-500/20 transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {activeRequestId === 'cropped-gif'
                      ? <Loader2 className="w-5 h-5 animate-spin" />
                      : <Send className="w-5 h-5" />}
                    <span>Discord로 보내기</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
