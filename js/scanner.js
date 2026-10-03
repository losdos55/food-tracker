// Full-screen rear-camera barcode scanner (ZXing, vendored: iOS Safari has no BarcodeDetector).
// The camera is stopped as soon as a code is read, the view is closed, or the app is backgrounded.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function cameraErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was denied. To allow it, open iOS Settings › Apps › Safari › Camera (Settings › Safari › Camera on older iOS) and choose Ask or Allow, then try again. You can also type the barcode instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Type the barcode instead.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app or could not start. Close other camera apps and try again.';
    default:
      return `The camera could not start${e?.message ? ` (${esc(e.message)})` : ''}. Type the barcode instead.`;
  }
}

/**
 * onCode(text, format) is called once with e.g. ('012345678905', 'UPC_A').
 * onManual() is called when the user picks "Type barcode instead".
 */
export function openScanner({ onCode, onManual }) {
  const view = document.createElement('div');
  view.className = 'scan-view';
  view.innerHTML = `
    <video playsinline muted autoplay></video>
    <div class="scan-frame" aria-hidden="true"></div>
    <div class="scan-top"><button class="btn" data-scan="cancel">Cancel</button></div>
    <div class="scan-bottom">
      <p class="scan-status">Starting camera…</p>
      <button class="btn" data-scan="manual">Type barcode instead</button>
    </div>`;
  document.body.appendChild(view);
  document.body.classList.add('noscroll');
  const video = view.querySelector('video');
  const status = view.querySelector('.scan-status');

  let controls = null;
  let closed = false;

  const stopCamera = () => {
    try { controls?.stop(); } catch { /* already stopped */ }
    controls = null;
    // belt and braces: make sure the camera light goes off
    video.srcObject?.getTracks?.().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopCamera();
    document.removeEventListener('visibilitychange', onHidden);
    view.remove();
    if (!document.querySelector('.sheet-wrap')) document.body.classList.remove('noscroll');
  };
  const onHidden = () => { if (document.hidden) close(); };
  document.addEventListener('visibilitychange', onHidden);

  view.querySelector('[data-scan=cancel]').addEventListener('click', close);
  view.querySelector('[data-scan=manual]').addEventListener('click', () => { close(); onManual(); });

  const fail = (html) => {
    stopCamera();
    view.classList.add('failed');
    status.innerHTML = html;
  };

  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return fail(window.isSecureContext
        ? 'This browser can\'t access the camera. Type the barcode instead.'
        : 'The camera needs a secure (HTTPS) connection. Open the app from its https:// address, or type the barcode instead.');
    }
    let ZX;
    try {
      ZX = await import('../vendor/zxing-browser.esm.js');
    } catch {
      return fail('The scanner failed to load. Reconnect once so it can be cached, or type the barcode instead.');
    }
    if (closed) return;
    const { BrowserMultiFormatReader, BarcodeFormat, DecodeHintType } = ZX;
    const hints = new Map([
      [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8]],
      [DecodeHintType.TRY_HARDER, true],
    ]);
    const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
    try {
      const c = await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        video,
        (result, _err, ctl) => {
          if (!result || closed) return;
          ctl.stop();
          const text = result.getText();
          const format = BarcodeFormat[result.getBarcodeFormat()];
          close();
          onCode(text, format);
        });
      if (closed) { c.stop(); return; } // cancelled while the permission prompt was up
      controls = c;
      status.textContent = 'Point the camera at the barcode';
    } catch (e) {
      if (!closed) fail(cameraErrorMessage(e));
    }
  })();

  return { close };
}
