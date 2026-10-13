// 페이지의 실제 JS 환경(MAIN world)에서 실행됩니다.
// "다음 차시로 이동하시겠습니까?" 같은 confirm/alert 창 때문에 자동 넘김이 멈추지 않도록,
// 확장 프로그램이 켜져 있고 '팝업 자동 확인'이 설정된 경우에만 자동으로 '확인' 처리합니다.
(() => {
  const isOn = () => document.documentElement?.dataset.lectureAutoConfirm === '1';
  const origConfirm = window.confirm.bind(window);
  const origAlert = window.alert.bind(window);
  window.confirm = (msg) => (isOn() ? true : origConfirm(msg));
  window.alert = (msg) => (isOn() ? undefined : origAlert(msg));
})();
