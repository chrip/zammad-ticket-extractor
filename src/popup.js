function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  if (el) {
    const hasMessage = Boolean(msg);
    el.textContent = hasMessage ? msg : '';
    el.classList.remove('error', 'success');
    if (isError) {
      el.classList.add('error');
    } else if (hasMessage && msg.includes('Copied')) {
      el.classList.add('success');
    }
    el.classList.toggle('hidden', !hasMessage);
  }
}

const DEFAULT_SETTINGS = {
  copyFormat: 'json',
  anonymize: false,
  downloadAttachments: false,
  includeBinary: false,
  keepAgents: true,
  // one host per line, edited in "Advanced"; defaults from pseudonymize.js
  publicHosts: DEFAULT_PUBLIC_HOSTS.join('\n'),
  internalDomains: '',
  protectedWords: ''
};

let currentSettings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = await browser.storage.local.get('ticketExtractorSettings');
    const saved = stored?.ticketExtractorSettings;
    if (saved && typeof saved === 'object') {
      currentSettings = { ...DEFAULT_SETTINGS, ...saved };
    } else {
      currentSettings = { ...DEFAULT_SETTINGS };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
    currentSettings = { ...DEFAULT_SETTINGS };
  }
  return currentSettings;
}

async function saveSettings() {
  try {
    await browser.storage.local.set({ ticketExtractorSettings: currentSettings });
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

async function runExtraction({ downloadJson }) {
  setStatus('Running…');
  try {
    const res = await browser.runtime.sendMessage({
      type: 'RUN_EXTRACTION',
      options: {
        ...currentSettings,
        downloadJson: Boolean(downloadJson)
      }
    });
    if (!res || !res.ok) {
      const errorMsg = res?.error || res?.message || 'unknown error';
      setStatus(`Failed: ${errorMsg}`, true);
      console.error('Extension error:', res);
      return false;
    }
    // The page may refuse the copy (e.g. not focused); the popup has focus, so retry here.
    let copied = Boolean(res.copied);
    if (!copied) {
      const text = currentSettings.copyFormat === 'json' && res.json ? JSON.stringify(res.json, null, 2) : res.transcript;
      if (text) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch (e) {
          console.warn('Popup clipboard fallback failed:', e);
        }
      }
    }
    const format = currentSettings.copyFormat === 'json' ? 'JSON' : 'text';
    const parts = [copied ? `Copied ${format} to clipboard.` : 'Failed to copy to clipboard.'];
    const label = format === 'JSON' ? 'JSON' : 'Text';
    if (downloadJson) parts.push(res.downloadedJson ? `${label} downloaded.` : `${label} download failed.`);
    const att = res.attachments;
    if (att) {
      const counts = [`${att.saved} saved`];
      if (att.skipped) counts.push(`${att.skipped} skipped`);
      if (att.failed) counts.push(`${att.failed} failed`);
      parts.push(`Attachments: ${counts.join(', ')}.`);
    }
    if (currentSettings.anonymize && !res.ticketAssetsLoaded) {
      parts.push(`Ticket users not readable via API${res.apiError ? ` (${res.apiError})` : ''}, only senders were pseudonymized by name.`);
    } else if (currentSettings.anonymize && currentSettings.keepAgents !== false && !res.staffKnown) {
      parts.push(`Agent roles not readable${res.apiError ? ` (${res.apiError})` : ''}, so agents were pseudonymized too.`);
    }
    const failed = !copied || (downloadJson && !res.downloadedJson) || Boolean(att && att.failed);
    setStatus(parts.join(' '), failed);
    return !failed;
  } catch (e) {
    setStatus(`Failed: ${e?.message || String(e)}`, true);
    console.error('Popup error:', e);
    return false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const copyBtn = document.getElementById('copyBtn');
  const downloadJsonBtn = document.getElementById('downloadJsonBtn');
  const copyFormatSelect = document.getElementById('copyFormat');
  const anonymizeToggle = document.getElementById('anonymizeToggle');
  const attachmentsToggle = document.getElementById('attachmentsToggle');
  const binaryToggle = document.getElementById('binaryToggle');
  const binaryLabel = document.getElementById('binaryLabel');
  const keepAgentsToggle = document.getElementById('keepAgentsToggle');
  const keepAgentsLabel = document.getElementById('keepAgentsLabel');
  const publicHostsInput = document.getElementById('publicHosts');
  const internalDomainsInput = document.getElementById('internalDomains');

  setStatus('');

  await loadSettings();

  if (copyFormatSelect) {
    copyFormatSelect.value = currentSettings.copyFormat;
    copyFormatSelect.addEventListener('change', async (event) => {
      currentSettings.copyFormat = event.target.value;
      syncControls();
      await saveSettings();
    });
  }

  if (anonymizeToggle) {
    anonymizeToggle.checked = Boolean(currentSettings.anonymize);
    anonymizeToggle.addEventListener('change', async (event) => {
      currentSettings.anonymize = event.target.checked;
      syncControls();
      await saveSettings();
    });
  }

  keepAgentsToggle.checked = currentSettings.keepAgents !== false;
  keepAgentsToggle.addEventListener('change', async (event) => {
    currentSettings.keepAgents = event.target.checked;
    await saveSettings();
  });

  const protectedWordsInput = document.getElementById('protectedWords');
  for (const [input, key] of [[publicHostsInput, 'publicHosts'], [internalDomainsInput, 'internalDomains'], [protectedWordsInput, 'protectedWords']]) {
    input.value = currentSettings[key];
    input.addEventListener('input', async () => {
      currentSettings[key] = input.value;
      await saveSettings();
    });
  }

  function syncControls() {
    const on = Boolean(currentSettings.downloadAttachments);
    binaryToggle.disabled = !on;
    binaryLabel.classList.toggle('disabled', !on);
    keepAgentsToggle.disabled = !currentSettings.anonymize;
    keepAgentsLabel.classList.toggle('disabled', !currentSettings.anonymize);
    const format = currentSettings.copyFormat === 'text' ? 'text' : 'JSON';
    downloadJsonBtn.textContent = `Download ${format}${on ? ' + attachments' : ''}`;
  }

  attachmentsToggle.checked = Boolean(currentSettings.downloadAttachments);
  binaryToggle.checked = Boolean(currentSettings.includeBinary);
  syncControls();
  attachmentsToggle.addEventListener('change', async (event) => {
    currentSettings.downloadAttachments = event.target.checked;
    syncControls();
    await saveSettings();
  });
  binaryToggle.addEventListener('change', async (event) => {
    currentSettings.includeBinary = event.target.checked;
    await saveSettings();
  });

  let isRunning = false;

  copyBtn.addEventListener('click', async () => {
    if (isRunning) return;
    isRunning = true;
    copyBtn.disabled = true;
    downloadJsonBtn.disabled = true;

    await runExtraction({ downloadJson: false });

    isRunning = false;
    copyBtn.disabled = false;
    downloadJsonBtn.disabled = false;
  });

  downloadJsonBtn.addEventListener('click', async () => {
    if (isRunning) return;
    isRunning = true;
    copyBtn.disabled = true;
    downloadJsonBtn.disabled = true;

    await runExtraction({ downloadJson: true });

    isRunning = false;
    copyBtn.disabled = false;
    downloadJsonBtn.disabled = false;
  });
});
