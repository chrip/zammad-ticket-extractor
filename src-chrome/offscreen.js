// Chrome only: turns attachment content into a blob URL for chrome.downloads,
// which the service worker cannot do itself.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'OFFSCREEN_BLOB_URL') {
    let blob;
    if (typeof msg.text === 'string') {
      blob = new Blob([msg.text], { type: msg.mime || 'text/plain;charset=utf-8' });
    } else {
      const bin = atob(msg.base64 || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: msg.mime || 'application/octet-stream' });
    }
    sendResponse({ url: URL.createObjectURL(blob) });
    return false;
  }
  if (msg && msg.type === 'OFFSCREEN_REVOKE') {
    URL.revokeObjectURL(msg.url);
  }
  return false;
});
