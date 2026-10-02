// Shared by the Firefox background script and the Chrome service worker.
// extractAndCopy runs inside the Zammad page: Firefox injects its source text,
// Chrome passes the function itself to chrome.scripting.executeScript.
// Both inject pseudonymize.js first, so createPseudonymizer is defined here.

// Function executed in the page context
async function extractAndCopy(options = {}) {
  const copyFormat = (options.copyFormat === 'text' ? 'text' : 'json');
  const anonymize = Boolean(options.anonymize);
  const downloadJson = Boolean(options.downloadJson);
  // Attachments are saved next to the JSON, so only on download.
  const downloadAttachments = downloadJson && Boolean(options.downloadAttachments);
  const includeBinary = Boolean(options.includeBinary);

  console.log('[EXTRACT] Starting extraction with options:', { copyFormat, anonymize, downloadJson, downloadAttachments, includeBinary });

  const hostList = value => Array.isArray(value) ? value : String(value || '').split(/[\s,]+/).filter(Boolean);
  const pseudo = anonymize ? createPseudonymizer({
    keepAgents: options.keepAgents !== false,
    publicHosts: options.publicHosts ? hostList(options.publicHosts) : undefined,
    internalDomains: hostList(options.internalDomains),
    // one per line: product names may contain spaces
    protectedWords: String(options.protectedWords || '').split(/\n/).map(w => w.trim()).filter(Boolean)
  }) : null;
  const ticketId = (location.hash.match(/ticket\/zoom\/(\d+)/) || [])[1] || '';

  async function api(path) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  // Ticket, customer, owner and organization records give names, mails and
  // phones to pseudonymize. Without them only the article senders are known.
  async function loadTicketAssets() {
    if (!ticketId) return null;
    try {
      return await api(`/api/v1/tickets/${ticketId}?all=true`);
    } catch (e) {
      console.warn('[EXTRACT] Ticket assets unavailable:', e);
      return null;
    }
  }

  async function loadArticles() {
    if (!ticketId) return [];
    try {
      return await api(`/api/v1/ticket_articles/by_ticket/${ticketId}`);
    } catch (e) {
      console.warn('[EXTRACT] Articles unavailable:', e);
      return [];
    }
  }

  function registerPeople(all, articles) {
    const assets = (all && all.assets) || {};
    const ticket = (assets.Ticket || {})[all && all.ticket_id] || {};
    const users = assets.User || {};
    const orgs = assets.Organization || {};
    const customerOrg = ticket.organization_id;
    const agentIds = new Set([ticket.owner_id]);
    for (const a of articles) if (a.sender === 'Agent' && a.created_by_id) agentIds.add(a.created_by_id);
    const domainOf = mail => String(mail || '').toLowerCase().split('@')[1] || '';
    // The agents' mail domains are the support team's own: their URLs are internal.
    for (const u of Object.values(users)) {
      if (u && agentIds.has(u.id) && u.id !== ticket.customer_id) pseudo.addInternalDomain(domainOf(u.email));
    }
    const isCustomerUser = u => u.id === ticket.customer_id || (customerOrg && u.organization_id === customerOrg);
    const isAgentUser = u => !isCustomerUser(u) && (agentIds.has(u.id) || pseudo.isInternal(domainOf(u.email)));

    // Agents first, so their names are protected before customers are added;
    // then the ticket's customer, so that is Customer-1.
    const rank = u => isAgentUser(u) ? 0 : u.id === ticket.customer_id ? 1 : 2;
    const ordered = Object.values(users).filter(Boolean).sort((a, b) => rank(a) - rank(b));
    const customerOrgIds = new Set([customerOrg]);
    for (const u of ordered) {
      if (u.id === 1) continue; // id 1 is Zammad's system user
      const role = isCustomerUser(u) ? 'customer' : isAgentUser(u) ? 'agent' : 'person';
      if (role !== 'agent' && u.organization_id) customerOrgIds.add(u.organization_id);
      const address = [u.street, u.address, [u.zip, u.city].filter(Boolean).join(' ')].filter(v => v && String(v).trim());
      pseudo.addPerson({
        firstname: u.firstname || '', lastname: u.lastname || '', email: u.email || '', login: u.login || '',
        phones: [u.phone, u.mobile, u.fax].filter(Boolean), extra: address, role
      });
      if (u.web) pseudo.text(u.web);
    }
    // Only the customer side's organizations; the support company stays readable
    // and its name is never taken for a person ("<Company> Support" senders).
    for (const u of Object.values(users)) {
      const org = u && isAgentUser(u) && orgs[u.organization_id];
      if (org && org.name && !customerOrgIds.has(org.id)) pseudo.addProtectedName(org.name);
    }
    for (const o of Object.values(orgs)) {
      if (o && o.name && customerOrgIds.has(o.id)) pseudo.addOrganization(o.name, String(o.domain || '').split(/[\s,;]+/).filter(Boolean));
    }
    // Article headers name people who are no Zammad user: "Name <mail>" in From/To/Cc.
    for (const a of articles) {
      for (const field of [a.from, a.to, a.cc, a.reply_to]) {
        if (!field) continue;
        for (const part of String(field).split(/,(?![^<]*>)/)) {
          const mail = (part.match(/<([^>]+)>/) || part.match(/([^\s<>"]+@[^\s<>"]+)/) || [])[1] || '';
          const name = part.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
          if (!mail && !name) continue;
          const role = pseudo.isInternal(domainOf(mail)) || (a.sender === 'Agent' && field === a.from) ? 'agent'
            : a.sender === 'Customer' && field === a.from ? 'customer' : 'person';
          pseudo.addPerson({ name: name.includes('@') ? '' : name, email: mail.trim(), role });
        }
      }
    }
  }

  function textFromNode(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);

    // Remove UI/irrelevant elements
    clone.querySelectorAll('.dropdown, .article-meta-links').forEach(n => n.remove());

    // Remove everything after signature marker
    const signatureMarker = clone.querySelector('.js-signatureMarker');
    if (signatureMarker) {
      let node = signatureMarker.nextSibling;
      while (node) {
        const next = node.nextSibling;
        node.remove();
        node = next;
      }
      signatureMarker.remove();
    }

    // Remove quoted header blocks (Von:/From:/Gesendet:/An:/Betreff:)
    const quotedHeaderSelectors = ["p", "div"];
    const headerStarts = [/^\s*Von:/i, /^\s*From:/i, /^\s*Gesendet:/i, /^\s*An:/i, /^\s*Betreff:/i];
    for (const sel of quotedHeaderSelectors) {
      clone.querySelectorAll(sel).forEach(el => {
        const t = (el.textContent || "").trim();
        if (headerStarts.some(rx => rx.test(t))) {
          let cur = el;
          while (cur) {
            const next = cur.nextSibling;
            cur.remove();
            if (!next) break;
            const isBlank = (next.nodeType === 3 && !next.textContent.trim()) ||
              (next.nodeType === 1 && ["P", "DIV", "BR"].includes(next.nodeName) && !(next.textContent || "").trim());
            if (isBlank) {
              next.remove();
              break;
            }
            cur = next;
          }
        }
      });
    }

    clone.querySelectorAll('a[href]').forEach(a => {
      const url = a.getAttribute('href');
      const text = a.textContent.trim();
      const same = text === url || `mailto:${text}` === url || `tel:${text}` === url;
      const rep = document.createTextNode(text && !same ? `${text} (${url})` : (same ? text : url));
      a.replaceWith(rep);
    });

    clone.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      const label = alt || src.split('/').pop() || src;
      img.replaceWith(document.createTextNode(`[image: ${label}]`));
    });

    clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
    // Only add newlines after block elements that are direct children of richtext-content
    // Avoid adding newlines after nested divs (like code blocks)
    const blockTags = ['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
    clone.querySelectorAll(blockTags.join(',')).forEach(el => {
      if (!el.childNodes.length || (el.textContent || '').trim().length === 0) return;
      el.appendChild(document.createTextNode('\n'));
    });
    // For DIVs, only add newline if it's a top-level block (not nested in another div)
    clone.querySelectorAll('DIV').forEach(el => {
      if (!el.childNodes.length || (el.textContent || '').trim().length === 0) return;
      // Only add newline if parent is not a DIV or is the root richtext-content
      const parent = el.parentElement;
      if (!parent || parent.tagName !== 'DIV' || parent.classList.contains('richtext-content')) {
        el.appendChild(document.createTextNode('\n'));
      }
    });

    let txt = clone.textContent || "";

    // Truncate at farewell markers - stop before signatures
    const farewellPatterns = [
      /(?:^|\n)\s*Grüße[^\S\r\n]*[A-ZÄÖÜa-zäöüß][^\n]*(?:\n|$)/i,
      /(?:^|\n)\s*Viele Grüße[^\n]*(?:\n|$)/i,
      /(?:^|\n)\s*Mit freundlichen Grüßen[^\n]*(?:\n|$)/i,
      /(?:^|\n)\s*Best regards[^\n]*(?:\n|$)/i,
      /(?:^|\n)\s*Kind regards[^\n]*(?:\n|$)/i,
      /(?:^|\n)\s*Med venlig hilsen[^\n]*(?:\n|$)/i,
      /(?:^|\n)\s*Sincerely[^\n]*(?:\n|$)/i,
      /(?:^|\n)\s*Regards[^\n]*(?:\n|$)/i
    ];

    let earliestMatch = txt.length;
    for (const pattern of farewellPatterns) {
      const match = txt.match(pattern);
      if (match && match.index !== undefined && match.index < earliestMatch) {
        earliestMatch = match.index;
      }
    }

    if (earliestMatch < txt.length) {
      // Find the end of the farewell line - keep "Viele Grüße" but remove everything after
      // The match starts at newline or start, so find where the farewell line ends
      const matchText = txt.slice(earliestMatch);
      // Find the end of the line containing the farewell
      const lineEnd = matchText.indexOf('\n');
      if (lineEnd >= 0) {
        // Cut after the farewell line (keep the farewell, remove signature after)
        const cutPoint = earliestMatch + lineEnd + 1;
        txt = txt.slice(0, cutPoint).trimEnd();
      } else {
        // No newline after farewell, cut at the match point
        txt = txt.slice(0, earliestMatch).trimEnd();
      }
    }

    // Remove common legal/signature patterns that might remain
    const legalPatterns = [
      /Sitz der Gesellschaft[^\n]*(?:\n|$)/i,
      /Registereintrag[^\n]*(?:\n|$)/i,
      /Geschäftsführer[^\n]*(?:\n|$)/i,
      /USt\. Ident\. Nr\.[^\n]*(?:\n|$)/i,
      /Die in dieser E-Mail[^\n]*(?:\n|$)/i,
      /The information contained in this e-mail[^\n]*(?:\n|$)/i,
      /VAT ID[^\n]*(?:\n|$)/i,
      /Place of incorporation[^\n]*(?:\n|$)/i
    ];

    for (const pattern of legalPatterns) {
      txt = txt.replace(pattern, '');
    }

    txt = txt.replace(/\u00a0/g, ' ');
    txt = txt.replace(/[ \t]+\n/g, '\n');
    txt = txt.replace(/\n{3,}/g, '\n\n');
    return txt.trim();
  }

  // Expand ALL folded content - find and click all "See more" buttons
  console.log('[EXTRACT] Looking for expand buttons...');
  const expandButtons = document.querySelectorAll('.js-toggleFold');
  console.log('[EXTRACT] Found', expandButtons.length, 'expand buttons');
  let clickedCount = 0;
  expandButtons.forEach(btn => {
    try {
      const btnText = btn.textContent.trim().toLowerCase();
      if (btnText.includes('see more')) {
        btn.click();
        clickedCount++;
      }
    } catch (e) {
      console.error('[EXTRACT] Error clicking button:', e);
    }
  });
  console.log('[EXTRACT] Clicked', clickedCount, 'buttons');
  // Wait for all expansions to complete
  if (clickedCount > 0) {
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  // Remove height restrictions on all articles
  document.querySelectorAll('.textBubble-content[style*="height"]').forEach(el => { el.style.removeProperty('height'); });

  console.log('[EXTRACT] Looking for .ticketZoom...');
  const ticketRoot = document.querySelector('.ticketZoom');
  if (!ticketRoot) {
    console.error('[EXTRACT] No .ticketZoom found on page');
    console.error('[EXTRACT] Current URL:', location.href);
    return { ok: false, error: 'No .ticketZoom found - make sure you are on a ticket page' };
  }
  console.log('[EXTRACT] Found ticketZoom element');

  const rawTitle = (ticketRoot.querySelector('.js-objectTitle') || {}).textContent?.trim() || '';
  const number = ticketRoot.querySelector('.js-objectNumber')?.getAttribute('data-number')?.replace(/^Ticket#/, '') ||
    (ticketRoot.querySelector('.js-objectNumber') || {}).textContent?.trim() || '';

  const [ticketAll, apiArticles] = (anonymize || downloadAttachments)
    ? await Promise.all([anonymize ? loadTicketAssets() : null, loadArticles()])
    : [null, []];
  if (pseudo) registerPeople(ticketAll, apiArticles);

  function getArticleDate(article) {
    const linkTime = article.parentElement?.querySelector('a small .humanTimeFromNow[datetime]') ||
      article.querySelector('.humanTimeFromNow[datetime]');
    const dt = linkTime?.getAttribute('datetime');
    try { return dt ? new Date(dt).toISOString() : ''; } catch { return ''; }
  }

  function getAuthor(article) {
    // Prefer meta "From"
    const metaFrom = article.querySelector('.article-content-meta .article-meta-row');
    if (metaFrom && /From/i.test(metaFrom.textContent || '')) {
      const val = metaFrom.querySelector('.article-meta-value')?.textContent || '';
      const emailMatch = val.match(/<([^>]+)>/);
      const name = val.replace(/\s*<[^>]+>\s*/g, '').trim();
      const email = emailMatch ? emailMatch[1].trim() : '';
      return { name, email };
    }
    // Fallback avatar title
    const avatar = article.querySelector('.js-avatar [title]');
    const name = avatar?.getAttribute('title')?.trim() || (article.classList.contains('agent') ? 'Agent' : 'Customer');
    return { name, email: '' };
  }

  // ---- attachments ------------------------------------------------------
  const MAX_BYTES = 40 * 1024 * 1024; // Chrome caps extension messages at 64 MiB, base64 adds a third
  const textExtensions = new Set(('log txt text json jsonl ndjson csv tsv xml yml yaml conf cfg ini env php md ' +
    'html htm sh out err journal properties toml sql diff patch').split(' '));
  const runtime = (globalThis.browser || globalThis.chrome).runtime;

  function splitName(filename) {
    const name = String(filename || '').toLowerCase();
    const gz = /\.gz$/.test(name);
    const inner = gz ? name.slice(0, -3) : name;
    const m = inner.match(/\.([a-z0-9]{1,10})$/);
    return { gz, ext: m ? m[1] : '' };
  }

  function looksLikeText(bytes) {
    const sample = bytes.subarray(0, 8192);
    if (sample.includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4))); return true; } catch { return false; }
  }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const chunks = [];
    let size = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { reader.cancel(); throw new Error('too large unpacked'); }
      chunks.push(value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  }

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function safeName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 120);
  }

  async function saveFile(path, payload) {
    const res = await runtime.sendMessage({ type: 'SAVE_FILE', filename: `${folder}/${path}`, ...payload });
    if (!res || !res.ok) throw new Error((res && res.error) || 'download failed');
  }

  async function saveAttachments() {
    const stats = { saved: 0, skipped: 0, failed: 0 };
    const byArticle = new Map(messages.map((m, i) => [String(m.articleId), i]));
    let counter = 0;
    for (const article of apiArticles) {
      const idx = byArticle.get(String(article.id));
      if (idx === undefined) continue; // not shown, e.g. filtered by Zammad
      const message = messages[idx];
      for (const att of article.attachments || []) {
        counter++;
        const { gz, ext } = splitName(att.filename);
        const label = `a${String(idx + 1).padStart(2, '0')}-${counter}`;
        const entry = anonymize ? { type: ext || 'bin', size: att.size } : { name: att.filename, size: att.size };
        (message.attachments = message.attachments || []).push(entry);
        try {
          if (Number(att.size) > MAX_BYTES) { entry.status = 'skipped: larger than 40 MB'; stats.skipped++; continue; }
          const res = await fetch(`/api/v1/ticket_attachment/${ticketId}/${article.id}/${att.id}`, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const original = new Uint8Array(await res.arrayBuffer());
          let bytes = original;
          let fileExt = ext;
          const contentType = String((att.preferences && (att.preferences['Content-Type'] || att.preferences['Mime-Type'])) || '');
          if (gz) {
            try { bytes = await gunzip(bytes); } catch (e) { bytes = null; entry.note = `not unpacked: ${e.message}`; }
          }
          const isText = bytes && (textExtensions.has(ext) || /^text\/|json|xml|yaml/.test(contentType) || (!ext && looksLikeText(bytes))) && looksLikeText(bytes);
          if (isText) {
            const content = new TextDecoder('utf-8').decode(bytes);
            const out = pseudo ? pseudo.file(content) : content;
            fileExt = ext || 'txt';
            entry.file = anonymize ? `${label}.${fileExt}` : safeName(gz ? att.filename.replace(/\.gz$/i, '') : att.filename);
            await saveFile(entry.file, { text: out, mime: 'text/plain;charset=utf-8' });
            entry.status = anonymize ? 'saved, pseudonymized' : 'saved';
            stats.saved++;
          } else if (includeBinary) {
            entry.file = anonymize ? `${label}.${(gz ? ext + '.gz' : ext) || 'bin'}` : safeName(att.filename);
            await saveFile(entry.file, { base64: toBase64(original), mime: contentType || 'application/octet-stream' });
            entry.status = anonymize ? 'saved unchanged, NOT pseudonymized' : 'saved';
            stats.saved++;
          } else {
            entry.status = 'skipped: binary or archive';
            stats.skipped++;
          }
        } catch (e) {
          console.error('[EXTRACT] Attachment failed:', e);
          entry.status = `failed: ${e.message}`;
          stats.failed++;
        }
      }
    }
    return stats;
  }

  // Extract ALL articles from the page
  console.log('[EXTRACT] Looking for articles...');
  const allArticles = document.querySelectorAll('.ticket-article-item');
  console.log('[EXTRACT] Found', allArticles.length, 'articles');
  const messages = [];
  allArticles.forEach((article, idx) => {
    const isSystem = article.classList.contains('system');
    const isAgent = article.classList.contains('agent');
    const isCustomer = article.classList.contains('customer');
    if (!isSystem && !isAgent && !isCustomer) {
      console.log('[EXTRACT] Article', idx + 1, 'skipped: unknown type');
      return;
    }

    const role = isSystem ? 'system' : (isAgent ? 'agent' : 'customer');
    const visibility = article.classList.contains('is-internal') ? 'internal' : 'public';
    const contentEl = article.querySelector('.textBubble-content .richtext-content') ||
      article.querySelector('.textBubble-content') ||
      article.querySelector('.task-subline');
    if (!contentEl) {
      console.log('[EXTRACT] Article', idx + 1, 'skipped: no content element');
      return;
    }
    const text = textFromNode(contentEl);
    if (!text) {
      console.log('[EXTRACT] Article', idx + 1, 'skipped: no text content');
      return;
    }

    const { name, email } = getAuthor(article);
    const dateIso = getArticleDate(article);

    const message = {
      articleId: article.getAttribute('data-id') || '',
      authorName: isSystem ? 'System' : (name || ''),
      authorEmail: isSystem ? '' : (email || ''),
      role,
      visibility,
      date: dateIso,
      contentText: text
    };

    messages.push(message);
  });

  console.log('[EXTRACT] Extracted', messages.length, 'messages');

  let title = rawTitle;
  if (pseudo) {
    // DOM senders cover tickets the API did not return.
    for (const role of ['agent', 'customer']) {
      messages.forEach(m => { if (m.role === role) pseudo.addPerson({ name: m.authorName, email: m.authorEmail, role }); });
    }
    // Names known only from a salutation in a later message count everywhere.
    pseudo.learn(rawTitle);
    messages.forEach(m => pseudo.learn(m.contentText));
    title = pseudo.text(rawTitle);
    messages.forEach(m => {
      if (m.role !== 'system') {
        m.authorName = pseudo.text(m.authorName || '');
        m.authorEmail = pseudo.text(m.authorEmail || '');
      }
      m.contentText = pseudo.text(m.contentText);
    });
  }

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const folder = `zammad/ticket-${number || 'unknown'}-${ts}`;
  const ext = copyFormat === 'text' ? 'txt' : 'json';
  const filename = downloadAttachments ? `${folder}/ticket.${ext}` : `ticket-${number || 'unknown'}-${ts}.${ext}`;

  const attachmentStats = downloadAttachments ? await saveAttachments() : null;

  const transcript = messages.map(m => {
    const d = m.date ? new Date(m.date) : null;
    const local = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
    const vis = m.visibility === 'internal' ? 'internal' : 'public';
    const files = (m.attachments || []).map(a => `attachment: ${a.file || a.name || `.${a.type} file`} (${a.status})`).join('\n');
    return `mail: ${m.authorName || ''}\nrole: ${m.role} (${vis})\ndate: ${local}\n${files ? files + '\n' : ''}content:\n${m.contentText}`;
  }).join('\n\n');

  // Copy to clipboard using execCommand (works in content script context)
  function copyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-999999px';
    textarea.style.top = '-999999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      return success;
    } catch (err) {
      document.body.removeChild(textarea);
      return false;
    }
  }

  const jsonMessages = messages.map(m => {
    const normalizedContent = (m.contentText || '').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const entry = {
      role: m.role,
      visibility: m.visibility,
      date: m.date,
      contentText: normalizedContent
    };
    entry.authorName = m.authorName;
    if (m.authorEmail) entry.authorEmail = m.authorEmail;
    if (m.attachments && m.attachments.length) entry.attachments = m.attachments;
    return entry;
  });

  const jsonPayload = {
    ticketNumber: number || '',
    ticketTitle: title || '',
    ...(anonymize ? { pseudonymized: true } : { url: location.href }),
    exportedAt: new Date().toISOString(),
    messages: jsonMessages
  };

  const copySource = copyFormat === 'json' ? JSON.stringify(jsonPayload, null, 2) : transcript;

  console.log('[EXTRACT] Copying to clipboard as', copyFormat);
  const copied = copyToClipboard(copySource);
  console.log('[EXTRACT] Clipboard copy result:', copied);

  const result = {
    ok: true,
    transcript,
    json: copyFormat === 'json' ? jsonPayload : undefined,
    filename,
    copied: copied,
    copiedFormat: copyFormat,
    anonymized: anonymize,
    attachments: attachmentStats,
    ticketAssetsLoaded: Boolean(ticketAll)
  };

  console.log('[EXTRACT] Returning result:', {
    ok: result.ok,
    messageCount: messages.length,
    copied: result.copied,
    copiedFormat: copyFormat,
    anonymized: anonymize
  });
  return result;
}
