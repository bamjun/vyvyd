import { lazy, Suspense, useState } from 'react';
import { VideoToGif } from './components/VideoToGif';
import { ImageEditor } from './components/ImageEditor';
import { DiscordWebhookField } from './components/DiscordWebhookField';
import { DiscordUrlFormatter } from './components/DiscordUrlFormatter';
import { getDiscordWebhookFromSearch, getStoredDiscordWebhooks } from './lib/discordWebhook';
import { MediaTransferProvider } from './hooks/useMediaTransfer';
import type { EditorMode } from './components/ImageEditor';
import { Film, Images, Link2, ShieldAlert, Sparkles, Zap, HardDrive, CheckCircle } from 'lucide-react';

const StudioProofPanel = lazy(() => import('./features/studio/StudioProofPanel'));
const StudioPanel = lazy(() => import('./features/studio/StudioPanel'));

function App() {
  const showProof = import.meta.env.DEV && new URLSearchParams(window.location.search).has('studioProof');
  const [activeTab, setActiveTab] = useState<'video' | 'editor' | 'formatter' | 'studio'>(
    () => new URLSearchParams(window.location.search).has('studio') || showProof ? 'studio' : 'editor',
  );
  const [studioVisited, setStudioVisited] = useState(activeTab === 'studio');
  const [editorMode, setEditorMode] = useState<EditorMode>('resize');
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
    <MediaTransferProvider onNavigate={(target) => {
      if (target === 'video') setActiveTab('video');
      else {setEditorMode(target); setActiveTab('editor');}
      requestAnimationFrame(() => document.getElementById(target === 'video' ? 'video-panel' : 'editor-panel')?.scrollIntoView({ block: 'start' }));
    }}>
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
              <p className="text-[10px] text-gray-400 font-medium">이미지 · 영상 · 포스터 작업 공간</p>
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
            {activeTab === 'studio' ? '포스터 메이커' : 'Convert, Resize, Crop & Merge'}
          </h2>
          <p className="text-gray-400 text-sm md:text-base">
            {activeTab === 'studio' ? '브라우저에서 편집하고, 이 컴퓨터의 로컬 서비스에 저장·출력하세요. 새로운 디자인은 현재 Codex 대화에서 요청할 수 있습니다.' : '영상 변환과 이미지 편집은 브라우저에서 처리합니다. 결과는 다운로드하거나 선택해 Discord로 보낼 수 있습니다.'}
          </p>
        </div>

        {/* Tab Selection */}
        <div className="flex justify-center">
          <div className="grid w-full max-w-3xl grid-cols-1 gap-2 rounded-2xl border border-white/5 bg-[#121318] p-1.5 shadow-inner sm:grid-cols-4">
            <button
              onClick={() => setActiveTab('video')}
              aria-pressed={activeTab === 'video'}
              aria-controls="video-panel"
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
              aria-pressed={activeTab === 'editor'}
              aria-controls="editor-panel"
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
              aria-pressed={activeTab === 'formatter'}
              aria-controls="formatter-panel"
              className={`flex items-center justify-center space-x-2 rounded-xl px-4 py-3 text-sm font-medium transition duration-200 ${
                activeTab === 'formatter'
                  ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Link2 className="w-4 h-4" />
              <span>Discord URL</span>
            </button>
            <button
              onClick={() => {setStudioVisited(true); setActiveTab('studio');}}
              aria-pressed={activeTab === 'studio'} aria-controls="studio-panel"
              className={`flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition duration-200 ${activeTab === 'studio' ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'}`}
            ><Sparkles className="w-4 h-4" /><span>포스터 메이커</span></button>
          </div>
        </div>

        {(activeTab === 'video' || activeTab === 'editor') && (
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

          {/* Keep each tool mounted so switching tabs preserves files and running jobs. */}
          <div id="formatter-panel" hidden={activeTab !== 'formatter'}>
            <DiscordUrlFormatter />
          </div>
          <div id="video-panel" hidden={activeTab !== 'video'}>
            <VideoToGif onSuccess={handleConversionSuccess} discordWebhookUrl={discordWebhookUrl} isActive={activeTab === 'video'} />
          </div>
          <div id="editor-panel" hidden={activeTab !== 'editor'} className="scroll-mt-24">
            <ImageEditor onSuccess={handleConversionSuccess} discordWebhookUrl={discordWebhookUrl} mode={editorMode} onModeChange={setEditorMode} />
          </div>
          {studioVisited && <div id="studio-panel" hidden={activeTab !== 'studio'}>
            <Suspense fallback={<p className="text-gray-400">포스터 메이커를 불러오는 중…</p>}>{showProof ? <StudioProofPanel isActive={activeTab === 'studio'} /> : <StudioPanel isActive={activeTab === 'studio'} />}</Suspense>
          </div>}
        </div>

        {/* Privacy Note Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="glass-panel rounded-2xl p-6 flex space-x-4">
            <div className="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
              <Zap className="w-6 h-6 text-purple-400" />
            </div>
            <div>
              <h4 className="font-semibold text-gray-200 mb-1">{activeTab === 'studio' ? '저장 버전으로 출력' : '탭을 옮겨도 작업 유지'}</h4>
              <p className="text-xs text-gray-400 leading-relaxed">
                {activeTab === 'studio' ? 'PNG·GIF·MP4는 출력 시작 때의 저장본을 사용합니다. 출력 중에도 편집을 이어가고 작업별로 취소·재시도할 수 있습니다.' : '다른 도구로 이동해도 파일·설정·결과를 유지합니다. 진행 중인 작업은 계속되며 처리 화면에서 취소할 수 있습니다.'}
              </p>
            </div>
          </div>

          <div className="glass-panel rounded-2xl p-6 flex space-x-4">
            <div className="w-12 h-12 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center flex-shrink-0">
              <ShieldAlert className="w-6 h-6 text-green-400" />
            </div>
            <div>
              <h4 className="font-semibold text-gray-200 mb-1">{activeTab === 'studio' ? '이 컴퓨터에 보관' : '브라우저에서 처리'}</h4>
              <p className="text-xs text-gray-400 leading-relaxed">
                {activeTab === 'studio' ? '프로젝트·이미지·저장 이력·출력 파일은 로컬 서비스가 디스크에 보관합니다. 프로젝트 파일을 다운로드해 다른 컴퓨터로 옮길 수 있습니다.' : '영상·이미지 변환은 브라우저 안에서 실행합니다. Discord 전송은 선택할 때만 실행하며, 페이지를 닫기 전 결과를 다운로드하세요.'}
              </p>
            </div>
          </div>

          <div className="glass-panel rounded-2xl p-6 flex space-x-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
              <Film className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <h4 className="font-semibold text-gray-200 mb-1">{activeTab === 'studio' ? '현재 Codex와 함께' : '결과 이어 편집'}</h4>
              <p className="text-xs text-gray-400 leading-relaxed">
                {activeTab === 'studio' ? '작업 요청을 복사해 현재 Codex 대화에 붙여넣으세요. Codex가 읽은 소스·이미지·편집 값은 그 대화의 AI 처리에 사용될 수 있습니다.' : '결과를 크기 줄이기·분할·합치기로 전달하세요. 대상 도구의 기존 파일과 설정을 유지하며 편집을 이어갈 수 있습니다.'}
              </p>
            </div>
          </div>
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 text-center text-xs text-gray-500 bg-[#07080b]">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
          <div>
            © {new Date().getFullYear()} vyvyd. 영상·이미지 편집은 브라우저에서, 포스터 저장·출력은 이 컴퓨터의 로컬 서비스에서 처리합니다.
          </div>
          <div className="flex space-x-4">
            <span>Discord 전송 · Codex 요청은 선택할 때 사용합니다.</span>
          </div>
        </div>
      </footer>
    </div>
    </MediaTransferProvider>
  );
}

export default App;
