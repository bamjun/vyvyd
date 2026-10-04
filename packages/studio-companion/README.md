# vyvyd 포스터 메이커 로컬 서비스

`@bamjun/vyvyd-studio`는 [vyvyd 포스터 메이커](https://vyvyd.pages.dev/?studio=1)의 프로젝트·이미지·수정 이력을 컴퓨터에 보관하고, Remotion 미리보기와 PNG/GIF/MP4 출력을 실행하는 npm CLI입니다. MCP 도구를 통해 현재 Codex 대화에서 같은 프로젝트의 디자인을 작성·수정할 수 있습니다.

## 설치 및 실행

Node.js **22.14 이상**과 Chrome 또는 Edge가 필요합니다. Windows에서 실제 저장·미리보기·출력을 검증했습니다. macOS/Linux의 브라우저 경로도 탐색하지만 동일한 전체 검증을 완료한 환경은 Windows입니다.

```sh
npm install -g @bamjun/vyvyd-studio
vyvyd-studio setup
vyvyd-studio start
```

서비스를 실행한 터미널을 열어 둔 채 [포스터 메이커](https://vyvyd.pages.dev/?studio=1)에 접속합니다. 브라우저에서 로컬 네트워크 접근 권한을 요청하면 허용하고 **다시 연결**을 누릅니다. 브라우저나 조직 정책에서 이 접근을 막으면 연결할 수 없습니다. 연결이 안 되면 다른 터미널에서 `vyvyd-studio doctor`로 실행 환경·서비스·Codex 설정을 확인합니다. 필요한 항목이 없으면 doctor는 종료 코드 1과 안내를 출력합니다.

저장소 전체를 내려받을 필요가 없습니다. 간단히 실행해 보려면 다음 명령도 사용할 수 있습니다.

```sh
npx @bamjun/vyvyd-studio@latest start
```

서버는 `127.0.0.1:4180`에서만 실행됩니다. 다른 컴퓨터에 공개되는 클라우드 서버가 아닙니다. 영상 변환·이미지 편집 도구는 이 서비스 없이도 브라우저에서 사용할 수 있습니다.

## 현재 Codex 대화 연결

`vyvyd-studio setup`은 사용자 Codex 설정의 `vyvyd-studio` MCP 항목을 등록합니다. 기존 설정을 보존하고 변경 전에 백업합니다. 설정이 이미 있으면 안내에 따라 확인합니다. Codex의 MCP 연결을 다시 시작한 뒤 같은 대화를 이어갑니다. 특정 프로젝트에만 등록하려면 다음 명령을 사용합니다.

```sh
vyvyd-studio setup --project /path/to/project
```

`setup`은 설치된 CLI의 절대 경로를 등록하므로 **전역 설치 후 설정하는 방식**을 권장합니다. `npx` 캐시에서 설정했다면 캐시 삭제 후 연결 경로가 사라질 수 있으며 전역 설치 후 다시 설정해야 합니다.

사이트에서 프로젝트를 열고 **현재 Codex에 작업 요청**에 원하는 디자인을 적은 뒤 **프로젝트 요청 문구 복사**로 현재 대화에 붙여넣습니다. 이 버튼은 문구를 복사하고 대화를 자동 실행하지 않습니다. 이 패키지는 AI API를 호출하지 않으며 AI 작업은 연결한 Codex에서 처리합니다.

## 데이터 저장

CLI로 실행한 프로젝트·이미지·이력·출력 파일은 설치 폴더나 npm 캐시 밖에 저장됩니다.

| 환경 | 기본 저장 폴더 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/vyvyd/studio` |
| macOS | `~/Library/Application Support/vyvyd/studio` |
| Linux | `$XDG_DATA_HOME/vyvyd/studio` 또는 `~/.local/share/vyvyd/studio` |

별도 위치를 지정하려면 `vyvyd-studio start --data-dir /path/to/studio`를 사용합니다. 해당 폴더 아래 `projects`, `previews`, `exports`를 만듭니다. 기존 개발 서버의 `STUDIO_DATA_DIR` 환경 변수는 **projects 폴더 자체**를 가리키므로 `--data-dir`의 기준과 다릅니다.

개발 저장소의 `.local/studio` 데이터는 자동으로 옮기지 않습니다. 기존 화면에서 `.vyvyd.json` 프로젝트 파일을 내려받아 새 서비스에 가져오거나, 서비스를 끈 상태에서 해당 studio 폴더를 별도로 보관해 `--data-dir`로 지정하세요.

## 브라우저 및 연결 설정

Chrome/Edge를 찾지 못하면 `CHROME_EXECUTABLE` 환경 변수에 브라우저 실행 파일의 절대 경로를 지정합니다. Linux는 브라우저가 필요로 하는 시스템 라이브러리도 설치되어 있어야 합니다.

`--origin https://your-vyvyd-site.example`로 허용할 vyvyd 화면 주소를 추가할 수 있습니다. 포스터 메이커는 기본 포트 4180에 연결하므로 일상 사용에서는 포트를 바꾸지 마세요. `start --port`와 `mcp --url`은 별도 개발·검증 환경을 위한 옵션입니다.

미리보기와 출력은 로컬 컴퓨터의 CPU·메모리·디스크를 사용합니다. 작업을 끝내면 Ctrl+C로 서비스를 종료합니다. 중요한 프로젝트는 화면의 프로젝트 파일 내보내기로 별도 보관하세요.

## 개발 및 라이선스

소스는 [vyvyd 저장소](https://github.com/bamjun/vyvyd)의 `packages/studio-companion`에서 관리합니다. 저장소 루트에서 `npm run studio:package` 또는 `npm run studio:pack`으로 배포 파일을 준비할 수 있습니다. npm 패키지에는 서비스 코드와 필요한 공유 런타임만 포함하며 개인 프로젝트·출력 결과·Codex 설정은 포함하지 않습니다.

이 패키지의 자체 코드는 MIT 라이선스입니다. 의존성은 각 패키지의 라이선스를 따릅니다. Remotion의 이용 조건은 [Remotion 라이선스](https://www.remotion.dev/license)를 참고하세요.
