# Market Pulse KR - GitHub Pages

## 업로드 방법

1. 이 폴더의 파일을 GitHub 저장소 루트에 업로드합니다.
2. 저장소 Settings > Pages에서 배포 브랜치와 루트 폴더를 선택합니다.
3. 저장소 Settings > Actions > General에서 Workflow permissions를 `Read and write permissions`로 설정합니다.
4. Actions 탭에서 `Update Korean Index Cache` 워크플로를 한 번 `Run workflow`로 직접 실행합니다.

## 코스피/코스닥 방식

브라우저에서 네이버/다음 금융 API를 직접 읽으면 CORS 때문에 실패할 수 있습니다.
그래서 GitHub Actions가 서버 측에서 `Naver 1순위 -> Daum 2순위`로 지수를 가져와 `data/korean-index.json`에 저장합니다.
대시보드는 같은 저장소의 JSON을 읽기 때문에 GitHub Pages에서 안정적으로 표시됩니다.

Yahoo Finance 지수 백업은 제거했습니다.
