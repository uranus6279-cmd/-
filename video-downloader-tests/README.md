# 영상 다운로더 하드 조건 테스트

실제 크롬에 확장을 올려, 까다로운 사이트 동작을 흉내 낸 테스트 서버를 상대로 실사용처럼 조작합니다.
받은 파일은 `ffprobe`로 길이/영상/음성을 확인하고, 대용량은 SHA-256 해시로 한 바이트도 틀리지 않았는지 확인합니다.

## 실행

```bash
./gen-media.sh          # 테스트 영상 생성 (ffmpeg, openssl 필요)
npm i playwright        # 또는 PLAYWRIGHT=모듈경로 지정
node run.mjs            # 전체 실행
node run.mjs hang big   # 일부만 실행
```

환경 변수: `CHROME`(크롬 실행 파일), `PLAYWRIGHT`(playwright 모듈 경로), `HUGE_N`(초대용량 조각 수, 기본 3000 = 1.5GB).
결과는 `out/` 폴더(받은 파일, results.json)에 남습니다.

## 케이스 (26개, 전부 통과)

| 이름 | 조건 |
|---|---|
| basic / fmp4 / crlf | 기본 TS, fMP4, Windows 줄바꿈 + BOM |
| redirect | 재생목록이 302로 다른 폴더로 이동 (상대 경로) |
| cdn | 조각이 다른 도메인 + 토큰 쿼리 |
| flaky | 500 에러, 연결이 중간에 끊김 |
| hang | 조각 하나가 5분간 응답 없음 → 20초 후 재시도 |
| referer / cookie | 핫링크 차단, 로그인 쿠키 필요 |
| byterange | 한 파일을 바이트 범위로 나눔 |
| alt | 영상/음성 분리 → 두 파일로 저장 |
| disguised / pngwrap | text/plain 재생목록 + .jpg 조각 / 조각 앞에 가짜 PNG 머리 |
| aes / live | 암호화·라이브 → 거부 메시지 확인 |
| title | 이모지·특수문자·300자 제목 → 안전한 파일 이름 |
| big / huge | 300MB, 1.5GB (해시 비교) |
| prog / iframe / progref | 일반 mp4: 확장자 없음 + 64KB 분할 전송 / 다른 도메인 iframe / 핫링크 차단 |
| gone / once / authheader | 실패 시 팝업에 원인(404/403)이 표시되는지 |
| player | 플레이어가 조각을 모두 받아도 목록에는 m3u8 하나만 |
| swkill | 서비스 워커가 강제 종료돼도 목록 유지 |

## 측정 결과 (같은 컴퓨터의 테스트 서버 기준)

- 속도: 1.5GB를 약 43초 (≈35MB/s). 실제로는 인터넷 속도가 한계입니다.
- 메모리: 4GB 영상에서 최대 약 0.6GB (임시 파일 방식 적용 전에는 9.4GB).
