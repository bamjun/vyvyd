import { useState } from 'react';
import { VideoToGif } from './components/VideoToGif';
import { ImageEditor } from './components/ImageEditor';
import { DiscordWebhookField } from './components/DiscordWebhookField';
import { DiscordUrlFormatter } from './components/DiscordUrlFormatter';
import { getDiscordWebhookFromSearch, getStoredDiscordWebhooks } from './lib/discordWebhook';
import { Film, Images, Link2, ShieldAlert, Sparkles, Zap, HardDrive, CheckCircle } from 'lucide-react';

function App() {
  const [activeTab, setActiveTab] = useState<'video' | 'editor' | 'formatter'>('editor');
  const discordWebhookFromUrl = getDiscordWebhookFromSearch(window.location.search);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState(
    () => discordWebhookFromUrl || getStoredDiscordWebhooks()[0] || '',
  );
  const [sessionConversions, setSessionConversions] = useState<number>(0);
  const [sessionBytesSaved, setSessionBytesSaved] = useState<number>(0);

  const handleConversionSuccess = (size: number) => {
    setSessionConversions((prev) => prev + 1);
    setSessionBytesSaved((prev) => prev + size);
  };

  const formatMegaBytes = (bytes: number) => {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  return (
    <div className="min-h-screen gradient-bg flex flex-col justify-between">
      {/* Top Banner / Header */}
      <header className="border-b border-white/5 bg-[#0b0c10]/40 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-500/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-purple-400 to-indigo-300 bg-clip-text text-transparent">
                vyvyd
              </h1>
              <p className="text-[10px] text-gray-400 font-medium">BROWSER-ONLY MULTIMEDIA TOOL</p>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="hidden md:flex items-center space-x-6 text-sm">
            <div className="flex items-center space-x-2 bg-white/5 border border-white/5 px-3 py-1.5 rounded-xl">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-gray-300 font-medium">{sessionConversions} Session Exports</span>
            </div>
            <div className="flex items-center space-x-2 bg-white/5 border border-white/5 px-3 py-1.5 rounded-xl">
              <HardDrive className="w-4 h-4 text-purple-400" />
              <span className="text-gray-300 font-medium">{formatMegaBytes(sessionBytesSaved)} Saved</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-6 py-12 flex-grow w-full space-y-8">
        
        {/* Visual Hero Tagline */}
        <div className="text-center max-w-2xl mx-auto space-y-4">
          <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight bg-gradient-to-b from-white to-gray-400 bg-clip-text text-transparent">
            Convert, Resize, Crop & Merge
          </h2>
          <p className="text-gray-400 text-sm md:text-base">
            Processing happens 100% on your device. Results are uploaded only when you choose to send them to Discord.
          </p>
        </div>

        {/* Tab Selection */}
        <div className="flex justify-center">
          <div className="grid w-full max-w-3xl grid-cols-1 gap-2 rounded-2xl border border-white/5 bg-[#121318] p-1.5 shadow-inner sm:grid-cols-3">
            <button
              onClick={() => setActiveTab('video')}
              className={`flex items-center justify-center space-x-2 px-6 py-3 rounded-xl font-medium text-sm transition duration-200 ${
                activeTab === 'video'
                  ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Film className="w-4 h-4" />
              <span>MP4 to GIF</span>
            </button>
            <button
              onClick={() => setActiveTab('editor')}
              className={`flex items-center justify-center space-x-2 px-6 py-3 rounded-xl font-medium text-sm transition duration-200 ${
                activeTab === 'editor'
                  ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Images className="w-4 h-4" />
              <span>Image Editor</span>
            </button>
            <button
              onClick={() => setActiveTab('formatter')}
              className={`flex items-center justify-center space-x-2 rounded-xl px-4 py-3 text-sm font-medium transition duration-200 ${
                activeTab === 'formatter'
                  ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Link2 className="w-4 h-4" />
              <span>Discord URL</span>
            </button>
          </div>
        </div>

        {activeTab !== 'formatter' && (
          <DiscordWebhookField
            value={discordWebhookUrl}
            onChange={setDiscordWebhookUrl}
            loadedFromUrl={discordWebhookFromUrl.length > 0}
          />
        )}

        {/* Dynamic Panel Grid */}
        <div className="glass-panel rounded-3xl p-8 shadow-2xl relative overflow-hidden">
          {/* Subtle Ambient Light Effects */}
          <div className="absolute top-0 right-1/4 w-80 h-80 bg-purple-600/10 rounded-full blur-[100px] pointer-events-none" />
          <div className="absolute bottom-0 left-1/4 w-80 h-80 bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none" />

          {activeTab === 'formatter' ? (
            <DiscordUrlFormatter />
          ) : activeTab === 'video' ? (
            <VideoToGif onSuccess={handleConversionSuccess} discordWebhookUrl={discordWebhookUrl} />
          ) : (
            <ImageEditor onSuccess={handleConversionSuccess} discordWebhookUrl={discordWebhookUrl} />
          )}
        </div>

        {/* Privacy Note Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="glass-panel rounded-2xl p-6 flex space-x-4">
            <div className="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
              <Zap className="w-6 h-6 text-purple-400" />
            </div>
            <div>
              <h4 className="font-semibold text-gray-200 mb-1">Instant Performance</h4>
              <p className="text-xs text-gray-400 leading-relaxed">
                Utilizes Web Workers and Canvas acceleration inside your browser. No queue times, no lag.
              </p>
            </div>
          </div>

          <div className="glass-panel rounded-2xl p-6 flex space-x-4">
            <div className="w-12 h-12 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center flex-shrink-0">
              <ShieldAlert className="w-6 h-6 text-green-400" />
            </div>
            <div>
              <h4 className="font-semibold text-gray-200 mb-1">Local by Default</h4>
              <p className="text-xs text-gray-400 leading-relaxed">
                Processing stays on your computer. Files leave your device only when you choose to send them to Discord.
              </p>
            </div>
          </div>

          <div className="glass-panel rounded-2xl p-6 flex space-x-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
              <Film className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h4 className="font-semibold text-gray-200 mb-1">Scale Control</h4>
              <p className="text-xs text-gray-400 leading-relaxed">
                Easily optimize dimensions and frame rates to control the final output file sizes.
              </p>
            </div>
          </div>
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 text-center text-xs text-gray-500 bg-[#07080b]">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
          <div>
            © {new Date().getFullYear()} vyvyd. All processing occurs locally; Discord upload is always optional.
          </div>
          <div className="flex space-x-4">
            <span className="hover:text-gray-400 transition cursor-help">HTML5 Canvas</span>
            <span>•</span>
            <span className="hover:text-gray-400 transition cursor-help">gifshot</span>
            <span>•</span>
            <span className="hover:text-gray-400 transition cursor-help">gifuct-js</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
