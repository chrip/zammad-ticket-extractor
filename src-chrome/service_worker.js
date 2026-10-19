// Chrome MV3 service worker. Same job as src/background.js (Firefox MV2), but
// Chrome forbids injecting code strings, so the extraction function itself is
// passed to chrome.scripting.executeScript, which also awaits its promise.
importScripts('extract.js');

async function runOnActiveTab(options = {}) {
  const runtimeOptions = {
    copyFormat: options.copyFormat || 'json',
    anonymize: Boolean(options.anonymize),
    downloadJson: Boolean(options.downloadJson),
    downloadAttachments: Boolean(options.downloadAttachments),
    includeBinary: Boolean(options.includeBinary),
    excludeInternal: Boolean(options.excludeInternal),
    keepAgents: options.keepAgents !== false,
    publicHosts: options.publicHosts || '',
    internalDomains: options.internalDomains || '',
    protectedWords: options.protectedWords || ''
  };
  // a service worker has no window of its own: take the window the user last focused
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return { ok: false, error: 'No active tab' };

  let result;
  try {
    // extractAndCopy calls createPseudonymizer, defined by this file.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['pseudonymize.js'] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractAndCopy,
      args: [runtimeOptions]
    });
    result = injection && injection.result;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  if (!result || !result.ok) return result || { ok: false, error: 'No result returned' };

  let downloadedJson = false;
  let exportDownloadId = null;
  let exportPath = '';
  // The download uses the selected format, like the clipboard.
  const asText = runtimeOptions.copyFormat === 'text';
  if (runtimeOptions.downloadJson && (asText ? result.transcript : result.json)) {
    try {
      // no URL.createObjectURL in a service worker; a ticket's export stays far below the 2 MB data: URL cap
      const url = (asText ? 'data:text/plain;charset=utf-8,' : 'data:application/json;charset=utf-8,') +
        encodeURIComponent(asText ? result.transcript : JSON.stringify(result.json, null, 2));
      exportDownloadId = await chrome.downloads.download({ url, filename: result.filename || `ticket-${Date.now()}.${asText ? 'txt' : 'json'}`, saveAs: false, conflictAction: 'uniquify' });
      exportPath = await finalPath(exportDownloadId);
      downloadedJson = true;
    } catch (e) {
      console.error('[SW] Failed to download JSON:', e);
    }
  }

  const parts = [result.copied ? `Copied ${runtimeOptions.copyFormat === 'json' ? 'JSON' : 'text'} to clipboard` : 'Failed to copy to clipboard'];
  if (downloadedJson) parts.push(`${asText ? 'Text' : 'JSON'} downloaded`);
  else if (runtimeOptions.downloadJson) parts.push(`${asText ? 'Text' : 'JSON'} download failed`);
  return { ...result, downloadedJson, exportDownloadId, exportPath, message: result.message || parts.join('. ') };
}

// Attachments can exceed the 2 MB data: URL cap and a service worker has no
// URL.createObjectURL, so an offscreen document makes the blob URL.
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Save ticket attachments as downloads' });
  } catch (e) {
    // a parallel call created it first
    if (!(await chrome.offscreen.hasDocument())) throw e;
  }
}

const pendingBlobUrls = new Map();
chrome.downloads.onChanged.addListener(delta => {
  const state = delta.state && delta.state.current;
  if (pendingBlobUrls.has(delta.id) && (state === 'complete' || state === 'interrupted')) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', url: pendingBlobUrls.get(delta.id) }).catch(() => {});
    pendingBlobUrls.delete(delta.id);
  }
});

// The absolute path the browser saved a download under (after any rename on
// a name conflict); it is set shortly after download() resolves.
async function finalPath(id) {
  for (let i = 0; i < 30; i++) {
    const [item] = await chrome.downloads.search({ id });
    if (item && item.filename) return item.filename;
    await new Promise(r => setTimeout(r, 100));
  }
  return '';
}

async function saveFile(msg) {
  try {
    await ensureOffscreen();
    const made = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_BLOB_URL', text: msg.text, base64: msg.base64, mime: msg.mime });
    if (!made || !made.url) throw new Error('offscreen document returned no URL');
    const id = await chrome.downloads.download({ url: made.url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' });
    pendingBlobUrls.set(id, made.url);
    return { ok: true, id, path: await finalPath(id) };
  } catch (e) {
    console.error('[SW] Failed to save file:', msg.filename, e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Chrome ignores promises returned from onMessage listeners: answer via sendResponse.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'RUN_EXTRACTION') {
    runOnActiveTab(msg.options || {}).then(sendResponse, e => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  if (msg && msg.type === 'SAVE_FILE') {
    saveFile(msg).then(sendResponse);
    return true;
  }
  // "Open folder" in the popup: the file manager, with the file selected
  if (msg && msg.type === 'SHOW_DOWNLOAD') {
    chrome.downloads.show(msg.id);
    sendResponse({ ok: true });
    return false;
  }
});
