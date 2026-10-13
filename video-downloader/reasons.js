// 다운로드 실패 원인을 사용자가 이해할 수 있는 문장으로 바꾼다.
// background.js(importScripts), popup.html, hls.html에서 함께 쓴다.

const EXPIRED_HINT = "페이지를 새로고침하고 영상을 다시 재생한 뒤 시도해 보세요.";

// chrome.downloads의 InterruptReason 코드 → 설명
const DOWNLOAD_ERRORS = {
  FILE_FAILED: "파일을 저장하지 못했습니다.",
  FILE_ACCESS_DENIED: "저장 폴더에 쓸 권한이 없습니다. 다운로드 폴더 설정을 확인하세요.",
  FILE_NO_SPACE: "디스크 공간이 부족합니다.",
  FILE_NAME_TOO_LONG: "파일 이름 또는 저장 경로가 너무 깁니다.",
  FILE_TOO_LARGE: "파일이 너무 커서 저장할 수 없습니다.",
  FILE_VIRUS_INFECTED: "백신 프로그램이 파일을 차단했습니다.",
  FILE_TRANSIENT_ERROR: "파일 저장 중 일시적인 오류가 발생했습니다. 다시 시도해 보세요.",
  FILE_BLOCKED: "크롬 또는 보안 정책이 이 파일을 차단했습니다.",
  FILE_SECURITY_CHECK_FAILED: "크롬 보안 검사에서 차단됐습니다.",
  FILE_TOO_SHORT: "받은 파일이 예상보다 짧습니다. 다시 시도해 보세요.",
  FILE_HASH_MISMATCH: "파일 내용이 손상됐습니다. 다시 시도해 보세요.",
  FILE_SAME_AS_SOURCE: "원본과 같은 위치에 저장할 수 없습니다.",
  NETWORK_FAILED: "네트워크 오류로 중단됐습니다.",
  NETWORK_TIMEOUT: "서버 응답이 너무 늦어 시간이 초과됐습니다.",
  NETWORK_DISCONNECTED: "인터넷 연결이 끊겼습니다.",
  NETWORK_SERVER_DOWN: "서버에 연결할 수 없습니다.",
  NETWORK_INVALID_REQUEST: "잘못된 요청이라 서버가 거절했습니다.",
  SERVER_FAILED: "서버 오류로 받지 못했습니다.",
  SERVER_NO_RANGE: "서버가 이어받기를 지원하지 않습니다.",
  SERVER_BAD_CONTENT: `서버에 파일이 없습니다(404). 주소가 만료됐을 수 있습니다. ${EXPIRED_HINT}`,
  SERVER_UNAUTHORIZED: "로그인이 필요한 파일입니다(401). 사이트에 로그인한 뒤 다시 시도하세요.",
  SERVER_CERT_PROBLEM: "서버 보안 인증서에 문제가 있어 받지 못했습니다.",
  SERVER_FORBIDDEN: `서버가 접근을 거부했습니다(403). 주소가 만료됐거나 사이트가 외부 다운로드를 막고 있습니다. ${EXPIRED_HINT}`,
  SERVER_UNREACHABLE: "서버에 연결할 수 없습니다.",
  SERVER_CONTENT_LENGTH_MISMATCH: "받는 도중 연결이 끊겨 파일이 불완전합니다. 다시 시도해 보세요.",
  SERVER_CROSS_ORIGIN_REDIRECT: "서버가 허용되지 않은 주소로 이동시켜 중단됐습니다.",
  USER_CANCELED: "다운로드를 취소했습니다.",
  USER_SHUTDOWN: "브라우저가 종료되어 중단됐습니다.",
  CRASH: "브라우저 오류로 중단됐습니다.",
};

function downloadErrorText(code) {
  return DOWNLOAD_ERRORS[code] || `알 수 없는 오류 (${code || "코드 없음"})`;
}

// HTTP 상태 코드 → 설명
function httpErrorText(status) {
  if (status === 401) return "로그인이 필요합니다(401). 사이트에 로그인한 뒤 다시 시도하세요.";
  if (status === 403) return `서버가 접근을 거부했습니다(403). 주소가 만료됐거나 사이트가 외부 다운로드를 막고 있습니다. ${EXPIRED_HINT}`;
  if (status === 404 || status === 410) return `파일이 없습니다(${status}). 주소가 만료됐을 수 있습니다. ${EXPIRED_HINT}`;
  if (status === 429) return "요청이 너무 많아 서버가 막았습니다(429). 잠시 후 다시 시도하세요.";
  if (status >= 500) return `서버 오류입니다(${status}). 잠시 후 다시 시도하세요.`;
  return `서버가 요청을 거절했습니다(HTTP ${status}).`;
}

// chrome.downloads.download() 시작 단계의 오류 메시지 → 설명
function startErrorText(message) {
  if (/Invalid filename/i.test(message || "")) return "파일 이름을 만들 수 없습니다.";
  if (/Invalid URL/i.test(message || "")) return "올바르지 않은 주소입니다.";
  return message || "다운로드를 시작하지 못했습니다.";
}
