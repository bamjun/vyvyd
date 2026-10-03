# Remotion 제작 기능: 0단계 검증 기록

검증일: 2026-10-02  
결과: 로컬 실행·소스 컴파일·편집 값 반영·PNG/MP4 출력 확인. 배포된 HTTPS 화면의 로컬 연결은 추가 확인 필요.

## 확인한 결과

| 검증 항목 | 결과와 근거 |
| --- | --- |
| vyvyd 안에서 실행 | 개발 서버의 `포스터 메이커` 화면에 Remotion Player 표시 |
| 한글·폰트·이미지 | 로컬 Noto Sans KR 로딩, 궤도 SVG 로딩과 화면 표시 확인 |
| 애니메이션 | 재생 시 프레임과 이미지의 이동·회전 값이 변경됨 |
| 편집 값 반영 | 제목 `title`의 문구와 X=120, Y=140이 브라우저와 PNG에 반영됨 |
| 탭 이동 | 편집 값을 유지하고 미리보기 재생을 멈춤 |
| 새 TSX 실행 | 가상 프로젝트를 브라우저에서 컴파일하고 Player로 실행 |
| 소스 갱신 | 문구를 변경한 새 TSX 컴파일 후 미리보기 갱신 |
| 문법 오류 | 잘못된 TSX의 진단 표시, 이전 미리보기 유지, 정상 소스로 복구 |
| 초기 실행 오류 | `Video`가 오류를 던지는 코드에서 이전 컴포지션 복원 확인 |
| PNG | 기본값·수정 예시를 45프레임에서 출력하고 서로 다른 결과 확인 |
| MP4 | 수정 예시를 960×540, 30 FPS, 3초 H.264/yuv420p로 실제 출력 |
| 로컬 연결 | 브라우저 → loopback 서비스의 HTTP 응답·iframe·이미지 표시 확인 |
| HTTPS 연결 | 별도 Pages 미리보기의 HTTPS·crossOriginIsolated 확인. 로컬 HTTP 요청은 시간 초과, iframe 내용도 표시되지 않아 성공 판정 제외 |
| 기존 기능 | 기존 테스트 119개 통과, lint·TypeScript·production build 통과 |

기존 `ad-mage` 디자인이나 템플릿은 사용하지 않았다. 검증 장면과 이미지는 이 단계에서 새로 작성했다. 현재 화면은 프로젝트 편집기 완성본이 아니라 실행 방식과 편집 값의 전달을 확인하는 실험 화면이다. MCP 연결은 2단계 작업이다.

## 실행과 검토

```powershell
npm run studio:proof:prepare
npm run dev
```

검토 주소: [로컬 포스터 메이커](http://127.0.0.1:5173/?studioProof=1)

1. `수정 예시 적용`을 누르고 제목·위치를 확인한다.
2. 재생 후 `출력 비교 프레임 45로 이동`을 눌러 PNG와 비교한다.
3. 브라우저 컴파일 시험을 펼쳐 문구 수정, 잘못된 소스, 정상 소스 복구를 확인한다.
4. 탭을 바꿨다가 돌아와 편집 값과 정지 상태를 확인한다.

출력:

```powershell
npm run studio:proof:render
```

현재 편집 값을 JSON으로 저장했다면 다음과 같이 같은 값을 출력에 전달할 수 있다.

```powershell
node scripts/studio-proof-render.mjs --props "C:/path/to/vyvyd-proof-props.json"
```

출력 파일은 `artifacts/studio-proof/`에 저장한다.

- `baseline-frame-45.png`: 기본 편집 값
- `edited-frame-45.png`: 수정 예시 또는 전달한 JSON 값
- `edited.mp4`: 같은 수정 값을 사용하는 3초 영상
- `edited-props.json`: 출력에 사용한 값
- `render-report.json`: 소스 해시, 설정, 출력 해시·크기, 영상 메타데이터
- `browser-preview.png`: 실제 브라우저 검토 화면

## 실행 방식에 대한 결정

**첫 구현은 로컬 vyvyd + 로컬 실행 서비스를 기준으로 한다.** Codex 연결과 프로젝트 파일 관리에 필요한 로컬 서비스는 유지하고, 제작 탭의 미리보기와 렌더러가 같은 프로젝트 소스·편집 값·파일을 사용하도록 확장한다.

브라우저 번들러는 실제로 동작했다. 첫 실행은 이번 환경에서 약 7.6~18초, 작은 소스의 반복 컴파일은 약 0.04~0.15초였다. 고정된 성능 보장 수치가 아니라 이 검증 장면의 관측값이다. WASM은 29,260,484바이트(약 27.9 MiB)를 내려받았다.

API가 실험 단계이며 파일 저장과 출력은 별도로 구현해야 한다. 따라서 브라우저 번들러는 격리된 미리보기 실행 모듈의 후보로 유지하고, 로컬 컴파일 경로를 교체할 수 있게 구성한다. [Remotion 공식 문서](https://www.remotion.dev/docs/browser-bundler)

현재 Pages의 단일 파일 제한은 25 MiB여서 이 WASM을 그대로 기존 정적 빌드에 포함할 수 없다. 0단계 컴파일러는 개발 화면에서만 사용하고 production build에서는 제외했다. 이후 컴파일러를 사용할 때는 로컬 미리보기 서비스에서 제공하는 방식부터 검토한다. [Cloudflare Pages 파일 제한](https://developers.cloudflare.com/pages/platform/limits/)

## 발견하고 처리한 문제

- **출력 설정 재사용:** 기본값으로 선택한 Remotion 컴포지션을 그대로 재사용하면 새 편집 값이 출력되지 않았다. 설정마다 `selectComposition()`을 다시 실행하도록 수정했고, 기본·수정 PNG의 해시가 다른 것을 확인했다.
- **React 18 ref 경고:** 설치한 Remotion 4.0.532의 `AbsoluteFillWithTiming`이 `ref`를 일반 속성으로 받아 React 18에서 경고가 발생했다. 시간 배치 기능을 사용하지 않는 검증 장면에서는 같은 CSS를 가진 기본 `div`로 교체했다. 경고 제거와 기존 출력의 동일성을 확인했다. React 자체는 업그레이드하지 않았다.
- **로컬 폰트:** 폰트는 프로젝트의 고정 URL로 제공하고 렌더링 전에 로딩 완료를 기다린다. 폰트 파일은 SIL OFL 라이선스와 함께 보관한다.
- **초기 실행 오류:** 컴파일 성공 후 컴포넌트 실행이 실패하는 경우도 별도로 확인했다. Player 오류 경계를 초기화하고 이전 컴포지션으로 복원한다. 모든 프레임의 실행 안전성과 재생 위치 보존은 이후 프로젝트 검증 흐름에서 다룬다.

Canvas는 공식 API와 peer dependency를 검토했다. 직접 드래그는 등록된 소스 노드·편집 가능한 속성이 필요하고 계산된 위치에는 제한이 있다. 이 단계에서 Canvas의 전체 드래그 기능을 검증했다고 처리하지 않는다. 우선 안정적인 레이어 ID와 별도 편집 값 계약으로 진행한다. [Canvas 공식 문서](https://www.remotion.dev/docs/canvas/canvas)

## HTTPS 연결 검증과 남은 점

검증 페이지: [studio-proof 미리보기](https://studio-proof.vyvyd.pages.dev/)

운영 `main` 배포와 별도인 `studio-proof` preview에 연결 검증 페이지만 배포했다. 이 페이지는 프로젝트 파일을 요청하지 않고 연결 상태·검증 이미지만 확인한다.

로컬 검증 서비스:

```powershell
$env:STUDIO_PROOF_ALLOWED_ORIGIN='https://studio-proof.vyvyd.pages.dev'
npm run studio:proof:server
```

서비스는 `127.0.0.1:4179`에만 바인딩하고 `/health`, `/preview`, `/assets/orbit.svg`만 제공한다. 정확한 Origin 허용 목록, CORS·CORP·COEP·iframe CSP를 적용했다. 허용 Origin 응답, 다른 Origin 거부, preflight, 임의 파일 경로 거부 등 HTTP 검사 14개를 통과했다.

Codex 내장 브라우저에서 HTTPS 페이지의 로컬 `fetch`가 10초 내 응답하지 않았고, iframe도 내용 표시를 확인하지 못했다. 헤더만으로 연결 성공을 보장할 수 없다는 결과다. 브라우저의 로컬 네트워크 권한·내장 브라우저 동작을 추가 확인해야 하며, 이번 검증만으로 정확한 차단 원인을 단정하지 않는다. 다른 브라우저에서의 성공도 아직 검증하지 않았다.

따라서 배포된 화면과 로컬 서비스의 실제 연결은 미완료로 기록한다. 로컬 제작 기능의 다음 단계는 진행 가능한 것으로 판단하며, 배포 연결은 6단계까지 해결·실증해야 한다.

## 사용 범위

이번 작업은 Remotion 적합성 평가용이다. 배포·상용화 시에는 실제 사용 주체에 해당하는 라이선스 조건을 확인한다. Remotion은 사용 주체별 라이선스를 구분하며, Noto Sans KR의 라이선스 파일은 `public/studio-proof/FONT-LICENSE.txt`에 포함했다. [Remotion 라이선스](https://www.remotion.dev/license)

## 다음 검토 지점

사용자 확인 후 1단계에서 제작 탭과 빈 프로젝트 생성·파일 추가·저장/다시 열기를 구현한다. 이 검증 화면의 장면을 디자인 템플릿으로 고정하지 않고, 새 프로젝트의 Remotion 소스를 Codex가 작성하는 흐름으로 확장한다.
