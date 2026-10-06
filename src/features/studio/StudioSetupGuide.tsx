const commandClass = 'mt-2 block select-all overflow-x-auto whitespace-pre rounded-lg bg-black/25 p-3 font-mono text-xs leading-6 text-purple-200';
const claudeWindowsConfig = JSON.stringify({mcpServers: {'vyvyd-studio': {command: 'cmd', args: ['/d', '/c', 'vyvyd-studio', 'mcp']}}}, null, 2);

export default function StudioSetupGuide({connected}: {connected: boolean}) {
  return <details open={!connected} className="rounded-xl border border-purple-400/20 bg-purple-500/5 text-sm text-gray-300">
    <summary className="cursor-pointer rounded-xl px-4 py-3 font-medium text-purple-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400">설치·실행 및 AI 연결 안내</summary>
    <div className="space-y-5 border-t border-purple-400/10 p-4">
      <p className="leading-relaxed">Node.js 22.14 이상과 Chrome 또는 Edge가 필요합니다. 아래 명령은 이 컴퓨터의 터미널에서 실행하세요.</p>
      <div>
        <h3 className="font-semibold text-white">처음 설치·서비스 실행</h3>
        <pre className={commandClass}><code>{'npm install -g @bamjun/vyvyd-studio\nvyvyd-studio start'}</code></pre>
        <p className="mt-2 text-xs leading-relaxed">설치는 처음 한 번 진행합니다. <code className="text-purple-200">start</code>는 프로젝트 저장·미리보기·출력 서비스를 실행합니다. 사용하는 동안 이 터미널을 켜 두고, 아래에서 사용하는 AI 앱의 연결 방법을 확인하세요.</p>
      </div>
      <div className="space-y-3">
        <h3 className="font-semibold text-white">AI 앱 연결 · 처음 한 번</h3>
        <details className="rounded-lg border border-purple-400/15 p-3">
          <summary className="cursor-pointer font-medium text-purple-200">Codex 연결</summary>
          <pre className={commandClass}><code>vyvyd-studio setup</code></pre>
          <p className="mt-2 text-xs leading-relaxed">서비스가 실행 중인 터미널은 그대로 두고, 새 터미널에서 실행하세요. <code className="text-purple-200">setup</code>은 Codex의 MCP 설정에 연결을 등록하는 명령입니다. 패키지 설치는 위의 <code className="text-purple-200">npm install</code>이 담당합니다. Codex의 MCP 설정에서 <code className="text-purple-200">vyvyd-studio</code> 연결을 다시 시작하고, 이 화면에서 다시 연결을 누르세요.</p>
        </details>
        <details className="rounded-lg border border-purple-400/15 p-3">
          <summary className="cursor-pointer font-medium text-purple-200">Claude Desktop 연결 · Windows</summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-xs leading-relaxed">
            <li>Claude Desktop에서 <strong className="font-medium text-purple-200">Settings → Developer → Edit Config</strong>를 여세요.</li>
            <li>아래 설정을 추가하세요. 기존 설정이 있다면 <code className="text-purple-200">mcpServers</code> 안에 <code className="text-purple-200">vyvyd-studio</code> 항목만 추가하고 다른 항목은 유지하세요.</li>
            <li>저장한 뒤 Claude Desktop을 완전히 종료하고 다시 실행하세요. <code className="text-purple-200">vyvyd-studio start</code> 터미널을 켜 둔 채 이 화면에서 다시 연결을 누르세요.</li>
          </ol>
          <pre className={commandClass}><code>{claudeWindowsConfig}</code></pre>
          <p className="mt-2 text-xs leading-relaxed">Claude Desktop은 등록된 <code className="text-purple-200">mcp</code> 명령을 자동 실행합니다. <code className="text-purple-200">setup</code>은 Codex 전용이므로 Claude 연결에는 필요하지 않습니다. 작업 요청 문구를 복사해 Claude 대화에 붙여넣으세요.</p>
          <p className="mt-2 text-xs leading-relaxed">연결에 실패하면 Node.js와 패키지 설치를 확인하고 Claude Desktop을 다시 실행하세요. 설정의 명령을 찾지 못하면 <a href="https://modelcontextprotocol.io/docs/develop/connect-local-servers" target="_blank" rel="noopener noreferrer" className="text-purple-300 underline">공식 MCP 연결 안내</a>에서 경로·로그 확인 방법을 참고하세요.</p>
        </details>
      </div>
      <div>
        <h3 className="font-semibold text-white">이후 실행</h3>
        <pre className={commandClass}><code>vyvyd-studio start</code></pre>
        <p className="mt-2 text-xs leading-relaxed">설치·AI 연결을 완료했다면 이후에는 이 명령만 실행하면 됩니다. 사용하는 동안 서비스 터미널을 켜 두세요. 이미 서비스가 실행 중이면 추가로 실행할 필요가 없습니다.</p>
      </div>
      <div>
        <h3 className="font-semibold text-white">전역 설치 없이 빠르게 실행</h3>
        <pre className={commandClass}><code>npx @bamjun/vyvyd-studio@latest start</code></pre>
        <p className="mt-2 text-xs leading-relaxed">프로젝트 저장·미리보기·PNG/GIF/MP4 출력 서비스를 실행합니다. AI 앱과 연결하려면 위의 전역 설치와 해당 앱의 연결 설정도 완료하세요.</p>
      </div>
      {window.location.protocol === 'https:' && <p className="text-xs leading-relaxed">브라우저가 이 사이트의 로컬 네트워크 접근 권한을 요청하면 허용한 뒤 다시 연결하세요. 내장 브라우저에서 권한을 확인할 수 없으면 Chrome 또는 Edge에서 이 사이트를 여세요.</p>}
      <p className="text-xs leading-relaxed">자세한 설치·연결 문제 해결은 <a href="https://www.npmjs.com/package/@bamjun/vyvyd-studio" target="_blank" rel="noopener noreferrer" className="text-purple-300 underline">패키지 사용 안내</a>에서 확인할 수 있습니다.</p>
    </div>
  </details>;
}
