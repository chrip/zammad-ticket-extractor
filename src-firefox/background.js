// MV2 background script (persistent) for Ticket Extractor

async function runOnActiveTab(options = {}) {
  const runtimeOptions = {
    copyFormat: options.copyFormat || 'json',
    anonymize: Boolean(options.anonymize),
    downloadJson: Boolean(options.downloadJson),
    downloadAttachments: Boolean(options.downloadAttachments),
    includeBinary: Boolean(options.includeBinary),
    keepAgents: options.keepAgents !== false,
    publicHosts: options.publicHosts || '',
    internalDomains: options.internalDomains || '',
    protectedWords: options.protectedWords || ''
  };

  console.log('[BG] Starting extraction with options:', runtimeOptions);
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id) {
    console.error('[BG] No active tab found');
    throw new Error('No active tab');
  }
  console.log('[BG] Tab found:', tab.id, tab.url);

  try {
    // extractAndCopy calls createPseudonymizer, defined by this file.
    await browser.tabs.executeScript(tab.id, { file: '/pseudonymize.js' });
    console.log('[BG] Injecting script...');
    const extractCode = extractAndCopy.toString();
    console.log('[BG] Extract function length:', extractCode.length);

    // Use message passing to get the result since executeScript doesn't properly await Promises in MV2
    return new Promise((resolve) => {
      // Set up one-time listener for the result
      const listener = (msg) => {
        if (msg && msg.type === 'EXTRACTION_RESULT') {
          browser.runtime.onMessage.removeListener(listener);
          console.log('[BG] Received result via message:', msg.result);

          if (msg.result && msg.result.ok) {
            (async () => {
              let downloadedJson = false;
              // The download uses the selected format, like the clipboard.
              const asText = runtimeOptions.copyFormat === 'text';
              if (runtimeOptions.downloadJson && (asText ? msg.result.transcript : msg.result.json)) {
                try {
                  const filename = msg.result.filename || `ticket-${Date.now()}.${asText ? 'txt' : 'json'}`;
                  const payload = asText ? msg.result.transcript : JSON.stringify(msg.result.json, null, 2);
                  const blobUrl = URL.createObjectURL(new Blob([payload], { type: asText ? 'text/plain;charset=utf-8' : 'application/json' }));
                  await browser.downloads.download({ url: blobUrl, filename, saveAs: false });
                  downloadedJson = true;
                  console.log('[BG] Export downloaded:', filename);
                  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
                } catch (downloadError) {
                  console.error('[BG] Failed to download JSON:', downloadError);
                }
              }

              const messageParts = [];
              if (msg.result.copied) {
                messageParts.push(`Copied ${runtimeOptions.copyFormat === 'json' ? 'JSON' : 'text'} to clipboard`);
              } else {
                messageParts.push('Failed to copy to clipboard');
              }
              if (downloadedJson) {
                messageParts.push(`${asText ? 'Text' : 'JSON'} downloaded`);
              } else if (runtimeOptions.downloadJson) {
                messageParts.push(`${asText ? 'Text' : 'JSON'} download failed`);
              }

              resolve({
                ...msg.result,
                downloadedJson,
                message: msg.result.message || messageParts.filter(Boolean).join('. ')
              });
            })();
          } else {
            resolve(msg.result || { ok: false, error: 'No result returned' });
          }
        }
      };

      browser.runtime.onMessage.addListener(listener);

      // Inject script that sends message back
      browser.tabs.executeScript(tab.id, {
        code: `
          (async function() {
            console.log('[INJECTED] Script starting...');
            try {
              ${extractCode}
              
              const injectedOptions = ${JSON.stringify(runtimeOptions)};
              console.log('[INJECTED] Calling extractAndCopy with options:', injectedOptions);
              const result = await extractAndCopy(injectedOptions);
              console.log('[INJECTED] ExtractAndCopy returned:', result);
              
              // Send result back via message
              browser.runtime.sendMessage({
                type: 'EXTRACTION_RESULT',
                result: result
              });
            } catch (e) {
              console.error('[INJECTED] Extraction error:', e);
              browser.runtime.sendMessage({
                type: 'EXTRACTION_RESULT',
                result: { 
                  ok: false, 
                  error: e?.message || String(e), 
                  stack: e?.stack,
                  name: e?.name
                }
              });
            }
          })();
        `
      }).catch((e) => {
        browser.runtime.onMessage.removeListener(listener);
        console.error('[BG] Failed to inject script:', e);
        resolve({ ok: false, error: e?.message || String(e) });
      });
    });
  } catch (e) {
    console.error('[BG] Background script error:', e);
    console.error('[BG] Error stack:', e?.stack);
    console.error('[BG] Error name:', e?.name);
    return { ok: false, error: e?.message || String(e), stack: e?.stack, name: e?.name };
  }
}

// Revoke a blob URL once its download no longer needs it.
const pendingBlobUrls = new Map();
browser.downloads.onChanged.addListener(delta => {
  const state = delta.state && delta.state.current;
  if (pendingBlobUrls.has(delta.id) && (state === 'complete' || state === 'interrupted')) {
    URL.revokeObjectURL(pendingBlobUrls.get(delta.id));
    pendingBlobUrls.delete(delta.id);
  }
});

// Attachments, sent one by one from the page by extractAndCopy.
async function saveFile(msg) {
  let blob;
  if (typeof msg.text === 'string') {
    blob = new Blob([msg.text], { type: msg.mime || 'text/plain;charset=utf-8' });
  } else {
    const bin = atob(msg.base64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: msg.mime || 'application/octet-stream' });
  }
  const url = URL.createObjectURL(blob);
  try {
    const id = await browser.downloads.download({ url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' });
    pendingBlobUrls.set(id, url);
    return { ok: true };
  } catch (e) {
    URL.revokeObjectURL(url);
    console.error('[BG] Failed to save file:', msg.filename, e);
    return { ok: false, error: e?.message || String(e) };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'RUN_EXTRACTION') {
    return runOnActiveTab(msg.options || {});
  }
  if (msg && msg.type === 'SAVE_FILE') {
    return saveFile(msg);
  }
});
