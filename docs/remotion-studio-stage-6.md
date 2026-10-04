# 포스터 메이커 6단계 검증 기록

검증일: 2026-10-04  
상태: **로컬 전체 흐름·회귀 검증 완료, 사용자 검토 대기. HTTPS 내장 브라우저 연결은 추가 확인 필요.**

## 확인할 화면과 파일

- [로컬 포스터 메이커](http://127.0.0.1:5173/?studio=1): **6단계 전체 흐름 확인** 프로젝트를 엽니다.
- [HTTPS 검토 화면](https://studio-proof.vyvyd.pages.dev/?studio=1): 최신 정적 빌드를 기존 `studio-proof` 미리보기 배포에 올렸습니다. 이번 업로드는 운영 `main` 배포를 바꾸지 않았습니다.
- [사용 안내](remotion-studio-guide.md): 설치·실행·Codex 연결·저장·출력·복구 방법입니다.

실제 결과는 Git에서 제외하는 `artifacts/studio-stage-6/`에 보관했습니다.

| 파일 | 실제 확인 |
| --- | --- |
| `poster-v5-f24.png` | 저장 버전 5, 24프레임, 360×480, 43,437바이트 |
| `poster-v5.gif` | 저장 버전 5, 720×960, 24 FPS, 48프레임, 2초, 무한 반복, 2,641,482바이트 |
| `poster-v5.mp4` | 저장 버전 5, 360×480, H.264, 24 FPS, 48프레임, 2초, 157,951바이트 |
| `browser-review.jpg` | 실제 브라우저의 캔버스·편집 모드·수동 제목 확인 화면 |
| `image-regression.jpg` | 출력 GIF를 기존 도구에서 50% 축소한 완료 화면 |
| `https-connection.jpg` | HTTPS 화면의 연결 실패·복구 안내 |

## 처음부터 출력까지

프로젝트 ID는 `91d9f64c-540b-4196-9ca5-e5e0f01cffa6`입니다. 앞 단계의 원본 프로젝트는 수정하지 않았습니다.

1. 실제 브라우저에서 빈 프로젝트를 만들었습니다. 360×480, 24 FPS, 48프레임/2초의 버전 1입니다.
2. **이미지 추가**로 앞 단계의 검증용 PNG를 보관했습니다. 안정적인 asset ID `92b542d3-d301-464a-ba06-7b4e64060e50`과 버전 2가 생겼습니다.
3. 현재 Codex 대화의 실제 `studio_read_project`·`studio_apply_source` MCP 도구로 새 Remotion 소스를 작성했습니다. 제목·설명·이미지 레이어를 등록한 버전 3이 브라우저에 자동 반영됐습니다.
4. 브라우저에서 제목을 **내 생각을 / 내 포스터로.**로 바꾸고 기준 위치를 **x=34, y=110**으로 저장했습니다. 버전 4입니다.
5. Codex가 실제 MCP로 수동 값을 읽고 이미지 애니메이션만 수정했습니다. 버전 5의 `edits.layers.headline`은 문구·x·y가 그대로였습니다. MCP의 24프레임 PNG도 확인했습니다.
6. **저장본 다시 열기**로 버전 5·이미지·문구·좌표가 유지되는 것을 확인했습니다. 연결 코드 적용을 위한 서비스 재시작 때도 열린 화면과 편집 값을 유지했고 **다시 연결**로 복원됐습니다.
7. 실제 브라우저에서 PNG·GIF·MP4 출력을 시작하고 완료 이력과 파일을 확인했습니다. 세 형식 모두 버전 5를 사용합니다.

이미지는 프로젝트에 복사돼 있으며 미리보기·출력은 같은 asset ID를 사용합니다. 원본 프로젝트와 별개인 검증용 프로젝트가 로컬 목록에 남습니다.

## 기존 도구와 동시 취소

실제 브라우저에서 두 방향을 확인했습니다.

- Remotion GIF 출력이 59%로 진행될 때 기존 WASM 영상 변환도 실행 중이었습니다. 포스터의 **작업 취소**를 누른 뒤 영상 변환은 계속 GIF 렌더링 중으로 표시됐고, 1200×1600·7.18 MB 결과로 완료됐습니다.
- 다시 두 작업을 실행해 영상 도구의 색상 팔레트 생성 중 **작업 취소**를 눌렀습니다. 포스터 출력은 50% 진행 상태를 유지한 뒤 720×960 GIF로 완료됐습니다.
- 포스터 GIF를 **크기 줄이기**로 전달했습니다. 720×960 → 360×480, 2.52 MB → 807.13 KB로 완료됐고, 탭을 이동해도 파일·설정·결과가 남았습니다. 이 축소와 MP4 출력도 함께 완료됐습니다.

실제 화면 증거는 `wasm-after-remotion-cancel.jpg`, `wasm-completed.jpg`, `wasm-cancelled.jpg`, `remotion-after-wasm-cancel.jpg`, `image-regression.jpg`입니다. 자동 검사 `studioMediaIsolation.test.mjs`도 실제 두 스케줄러를 함께 실행해 양방향 취소를 검증합니다. 자동 검사에서는 WASM core와 Chrome 렌더러를 테스트 대체물로 사용하며 실제 브라우저 검증과 구분합니다.

## 연결 구현 보완

- 허용된 부모 Origin 목록이 바뀌면 이전 목록을 가진 미리보기 캐시를 재사용하지 않습니다. 기존 캐시도 `snapshot.json`의 목록을 확인합니다. 주소 추가·제거·순서·중복·손상된 기존 기록의 회귀 검사를 추가했습니다.
- `/previews/*`의 PNA 사전 요청에 응답합니다. 정확히 허용된 Origin과 GET·HEAD만 지원하며 `null`·외부 Origin·수정 메서드를 거부합니다.
- iframe의 `referrerPolicy="origin"`을 명시했습니다. `sandbox="allow-scripts"`와 부모 창·Origin 검사는 유지합니다.
- 연결 실패 안내에 로컬 네트워크 권한 확인과 로컬 편집기 링크를 추가했습니다. 앱 안내도 기존 브라우저 처리, 포스터의 로컬 디스크 저장·출력, 현재 Codex의 AI 처리 범위를 구분합니다.

## HTTPS 검증 결과와 남은 범위

Wrangler 4.147.0으로 최신 빌드를 `studio-proof` 미리보기 배포에 업로드했습니다. 고정 배포 주소는 `https://cdf21ed0.vyvyd.pages.dev`이며 검토 주소는 `https://studio-proof.vyvyd.pages.dev`입니다. 업로드한 것은 정적 화면이며 로컬 프로젝트·이미지·출력 파일은 포함하지 않습니다. [Cloudflare Direct Upload 안내](https://developers.cloudflare.com/pages/get-started/direct-upload/)

검토 주소의 실제 HTTP 응답은 200이며 `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`가 적용됐습니다. `deployed-headers.json`에 기록했습니다.

서비스를 `STUDIO_ALLOWED_ORIGIN=https://studio-proof.vyvyd.pages.dev`로 재시작한 뒤, 이 정확한 Origin을 넣은 실제 HTTP 요청 44건을 검사했습니다. 프로젝트·이미지·소스 상태·미리보기·출력 목록·출력 다운로드·프로젝트 파일과 PNA 사전 요청이 정상입니다. 프로젝트 파일의 문서·소스·이미지 해시는 저장 버전 5와 일치합니다. 비공개 API는 외부 Origin과 `null`을 거부합니다. 불변 미리보기 GET은 opaque sandbox의 로딩을 위해 공개 읽기가 가능하며 사전 요청은 허용 Origin으로 제한합니다. 결과는 `http-validation.json`입니다.

**이 서버 검사가 HTTPS 브라우저 연결 성공을 뜻하지는 않습니다.** 실제 Codex 내장 브라우저의 HTTPS 화면에서는 최초 연결과 **다시 연결** 모두 `CONNECTION_FAILED`로 끝났습니다. 로컬 화면은 같은 서비스를 정상적으로 사용했고, HTTPS 화면의 콘솔 오류·경고는 수집되지 않았으며 사용자에게 보이는 권한 요청도 없었습니다. 이 관찰만으로 LNA 거부·CORS·내장 브라우저 구현 중 어느 것이 원인인지 확정할 수 없습니다.

현재 Chrome은 공개 사이트의 로컬 네트워크 요청에 사용자 권한을 사용합니다. 일반 Chrome·Edge에서 의도한 vyvyd 사이트의 로컬 네트워크 권한과 정책을 확인한 뒤 연결·이미지·iframe 미리보기·재연결·다운로드를 다시 검사해야 합니다. 이 브라우저 조합의 성공은 아직 확인하지 않았습니다. 보안 설정을 끄거나 서비스를 외부에 공개하는 우회는 하지 않았습니다. [Chrome 공식 LNA 안내](https://developer.chrome.com/blog/local-network-access), [Edge 공식 안내](https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access)

지금 사용할 수 있는 경로는 **로컬 vyvyd + 로컬 서비스 + 현재 Codex MCP**입니다. HTTPS 미리보기 연결 검증이 남아 있다는 상태를 계획에도 유지합니다. 자동 브라우저 다운로드의 실제 저장 완료도 앞 단계와 동일하게 미확인입니다. 이번 기록의 파일은 실제 HTTP 다운로드 응답으로 확보하고 내용·규격을 검사했습니다.

## 정적 검사와 자동 검사

- `npm test`: 총 242개, **241 통과 · 선택 렌더 검사 1개 제외 · 실패 0**.
- `npm run lint`: 통과.
- `npm run build`: 통과. 개발용 브라우저 컴파일러를 앱 번들에 포함하지 않습니다.
- PNG·GIF는 Pillow로 규격·프레임·재생 시간을 검사했고 MP4는 ffprobe로 코덱·크기·FPS·길이를 확인했습니다.

로그는 `test-report.txt`, `lint-report.txt`, `media-metadata.json`, `video-metadata.json`입니다. 이번 단계의 완료 범위는 로컬 전체 흐름·회귀 검사·안내 제공이며, HTTPS 브라우저 연결을 완료 처리하지 않습니다.
