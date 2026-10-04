# 포스터 메이커 npm 배포 기록

2026-10-04에 독립 CLI 패키지 **`@bamjun/vyvyd-studio@0.1.0`의 npm 공개 배포와 vyvyd 운영 사이트 배포를 완료했습니다.** npm registry의 공개 버전과 `latest` 태그는 모두 `0.1.0`이며, 공개 tarball의 무결성은 아래 검증 파일과 일치합니다.

- [공개 npm 패키지](https://www.npmjs.com/package/@bamjun/vyvyd-studio)
- [포스터 메이커](https://vyvyd.pages.dev/?studio=1)

## 배포 파일

- 패키지: `@bamjun/vyvyd-studio@0.1.0`
- 실행 명령: `vyvyd-studio`
- 패키지 위치: `packages/studio-companion`
- 검증한 고정 파일: `artifacts/studio-package/bamjun-vyvyd-studio-0.1.0-release.tgz`
- 크기: 57,612바이트 / 압축 해제 후 203,848바이트
- 포함 파일: 25개. CLI, 서비스, worker 진입점, 필요한 공유 런타임, README, LICENSE, package.json만 포함합니다.
- SHA-1: `b7b7836d031fd05930c0554a00e4ae974699afbc`
- 무결성: `sha512-ZXeKCIQJ32Gc08JmGXAR3EmWghJprvPDlctMkVwwEZr3s4MMz0la/f+RqbOGm0Z4Dqb73gvsw0Gq1EQTGZfCBA==`

개인 프로젝트·업로드 이미지·출력 결과·Codex 설정·npm 인증 파일·개발 검증 자료는 패키지에 포함하지 않았습니다. 프로젝트·미리보기·출력은 CLI 실행 시 사용자 데이터 폴더에 저장하며 npm 설치 폴더 및 npx 캐시와 분리했습니다.

## 검증

- `npm test`: 264개 통과, 3개 건너뜀, 실패 없음. Windows에서 파일 심볼릭 링크 권한이 없는 테스트 2개와 선택 실행하는 실제 브라우저 테스트 1개를 기본 실행에서 건너뜁니다.
- 실제 Chrome 미리보기 검증을 별도로 실행해 5개 통과했습니다.
- `npm run lint`, `npm run build`: 통과.
- 새 CLI·패키지 빌드 스크립트·검증 스크립트의 ESLint: 통과.
- 최종 tarball을 저장소 밖의 새 임시 설치 환경에 설치했습니다. 공유 코드와 의존성은 설치된 패키지에서만 사용했습니다.
- `scripts/verify-studio-package.mjs`: 11개 실제 통합 확인 통과. help/setup/doctor/start, 한글·Noto Sans KR·이미지 소스, 시작·중간·마지막 프레임, stdio MCP 읽기·레이어 수정·미리보기, PNG/GIF/MP4, 취소, 서비스 재시작 후 프로젝트·이력·미리보기·출력 복구를 확인했습니다.
- 실제 결과물과 보고서: `artifacts/studio-package/release-smoke/`.

새 설치 환경에서 발견한 외부 작업 폴더의 의존성 충돌을 수정했습니다. 프로젝트의 브라우저 import는 설치된 companion의 의존성 위치에서 찾고, 의존성 내부 import는 각 패키지의 위치를 사용해 Remotion 내부 Zod 버전을 유지합니다. 허용된 의존성 트리 밖의 파일이나 Node 호스트 모듈은 계속 거부합니다.

검증 스크립트는 오래 걸리는 렌더 작업 사이의 Node/Undici 유휴 소켓 재사용 영향을 피하기 위해 HTTP 검증 요청에 `Connection: close`를 사용합니다. 설치된 MCP 클라이언트와 서버의 fetch 구현은 그대로 검증했습니다.

## npm 공개 배포

로그인 계정 `bamjun`을 확인했습니다. 최초 직접 배포 시 npm이 본인 인증을 요구하며 HTTP 403을 반환해, staged publishing으로 검증 파일을 업로드한 뒤 계정 소유자가 승인했습니다. 인증 코드나 npm 인증 파일은 저장소에 넣지 않았습니다.

시스템 npm은 그대로 두고 `.cache/npm-release-cli`에 npm 11.21.0을 준비해 **검증한 고정 tarball**을 검토 대기로 업로드했습니다. 다음 값은 당시 업로드 기록입니다.

- Stage ID: `af46b70f-9bbf-46eb-982a-0ae32d1ffd41`
- 버전: `0.1.0`
- 태그: `latest`
- 공개 범위: `public`
- 업로드 당시 상태: `staged` (이후 사용자 승인 및 공개 버전 확인 완료)
- 서버 SHA-1은 위 고정 파일의 값과 일치합니다.

승인 후 공개 registry에서 `0.1.0`, `latest: 0.1.0`, SHA-1과 SHA-512 무결성을 확인했습니다. 저장소 밖 임시 폴더에 공개 registry 패키지를 격리한 글로벌 prefix로 설치하고, 실제 생성된 `vyvyd-studio.cmd`의 version/help와 설치된 CLI의 서비스 시작·health(protocol 2)·프로젝트 목록 응답을 확인했습니다. 이 설치에는 `--ignore-scripts`를 사용했으며, 검증용 서비스는 종료했습니다. 보고서는 `artifacts/studio-package/public-registry-smoke-report.json`에 보관합니다.

별도 임시 작업 폴더와 독립 npm 캐시에서 설치 스크립트를 허용하는 기본 설치 방식으로 `npm exec --yes --package=@bamjun/vyvyd-studio@latest -- vyvyd-studio version`도 실행했습니다. 공개 `latest`의 `0.1.0` 출력과 종료 코드 0을 확인했으며, 사용자 Codex 설정을 변경하지 않고 검증에 사용한 Node 프로세스가 남지 않았음을 확인했습니다. 보고서는 `artifacts/studio-package/public-registry-npx-report.json`에 보관합니다.

## 사이트 운영 배포

Cloudflare Pages의 기존 `vyvyd` 프로젝트와 `main` production 브랜치를 확인한 뒤, 검증한 `dist`를 Wrangler 4.147.0으로 배포했습니다.

- 운영 주소: <https://vyvyd.pages.dev/?studio=1>
- 이번 배포 주소: <https://4f6ed550.vyvyd.pages.dev>
- 실행한 배포: `npx --yes wrangler@4.147.0 pages deploy dist --project-name=vyvyd --branch=main --commit-dirty=true`
- 공개 HTML과 포스터 메이커 JS의 HTTP 200, SHA-256 일치, `npx @bamjun/vyvyd-studio@latest start` 포함 여부를 확인했습니다.
- 공개 사이트 브라우저 화면에서 포스터 메이커 탭·Node/브라우저 요구사항·새 npm 명령·패키지 사용 안내 링크 표시를 확인했습니다.
- 확인 자료: `artifacts/studio-package/public-site-report.json`, `artifacts/studio-package/public-site.jpg`.

이 배포는 로컬 companion을 npm으로 제공하는 방식입니다. 저장·미리보기·출력은 사용자가 실행한 서비스가 처리합니다. 내장 브라우저에서는 로컬 서비스 연결이 되지 않아 연결 안내 화면을 확인했으며, HTTPS 사이트와 사용자 로컬 서비스의 연결에는 브라우저의 로컬 네트워크 접근 허용이 필요합니다.

자세한 사용자 명령과 저장 경로는 [패키지 사용 안내](../packages/studio-companion/README.md)를 참고하세요.
