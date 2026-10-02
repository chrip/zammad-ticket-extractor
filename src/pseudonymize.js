// Consistent pseudonymization for ticket text and attached logs.
// Injected into the Zammad page next to extract.js (Firefox: executeScript
// file, Chrome: scripting.executeScript files), and loaded by the unit tests.
// One instance per export: the same name, mail, host or IP gets the same
// pseudonym in the conversation and in every attachment. Nothing is persisted.

// Hosts whose URLs are public knowledge: general docs, forums, issue trackers.
// "*.example.org" matches example.org and every subdomain, anything else one host.
// Vendor-neutral only; a team adds its own public sites in the popup settings.
const DEFAULT_PUBLIC_HOSTS = [
  'github.com', 'gist.github.com', '*.githubusercontent.com', 'gitlab.com',
  '*.php.net', '*.apache.org', 'nginx.org', 'docs.nginx.com', 'developer.mozilla.org',
  'learn.microsoft.com', 'support.microsoft.com', 'support.apple.com', 'docs.docker.com', 'hub.docker.com',
  '*.ubuntu.com', '*.debian.org', 'access.redhat.com', 'docs.redhat.com', 'mariadb.com', '*.mariadb.org',
  'dev.mysql.com', '*.postgresql.org', 'redis.io', '*.letsencrypt.org', 'docs.zammad.org', '*.w3.org',
  'schema.org', 'stackoverflow.com', '*.stackexchange.com', 'serverfault.com', 'superuser.com', 'askubuntu.com',
  '*.wikipedia.org', 'datatracker.ietf.org', '*.rfc-editor.org',
  'example.com', 'example.org', 'example.net', '*.example', '*.invalid', 'localhost'
];

function createPseudonymizer(config = {}) {
  const hostPatterns = list => (list || []).map(d => String(d).trim().toLowerCase()).filter(Boolean);
  const publicHosts = hostPatterns(config.publicHosts || DEFAULT_PUBLIC_HOSTS);
  // The support team's own domains: their URLs (tracker, CRM, portal, internal
  // cloud) are dropped unless public. The caller adds the agents' mail domains.
  const internalDomains = hostPatterns(config.internalDomains);
  // Support agents are the exporting team itself: their names stay readable
  // unless the caller asks otherwise. Mail addresses are always pseudonymized.
  const keepAgents = config.keepAgents !== false;

  // Last labels that are file extensions or code, not TLDs: "server.log", "OC.Files.App".
  const notTlds = new Set(('php js mjs cjs ts json log txt html htm css scss xml yml yaml conf ini cfg sh ' +
    'py rb go java class jar md png jpg jpeg gif svg webp ico pdf zip gz tgz bz2 xz tar 7z rar sql ' +
    'lock map vue csv tsv service socket timer old bak tmp swp out err pid sock db sqlite crt pem key ' +
    'csr p12 pfx eml msg doc docx xls xlsx ppt pptx odt ods odp rtf mp3 mp4 mov avi wav ogg webm ' +
    'exe dll so deb rpm apk iso img dmg bin dat env dist local min lst patch diff kt swift rs c h cpp hpp ' +
    'cs vb ps1 bat cmd twig tpl inc phar mo po pot ttf woff woff2 eot otf').split(' '));

  // Two-letter TLDs are all accepted; longer ones only from this list.
  const gTlds = new Set(('com net org info biz io app dev cloud online site tech eu asia edu gov mil int mobi name pro ' +
    'xyz top shop store gmbh services solutions systems network email digital group software agency company ' +
    'international berlin hamburg bayern nrw koeln cologne ruhr saarland wien tirol swiss zuerich paris london ' +
    'nyc amsterdam brussels local lan internal intranet intra corp home arpa').split(' '));

  // Generic subdomain labels kept as is, so "cloud.acme.com" becomes "cloud.domain1.example".
  const genericLabels = new Set(('www cloud office code docs ' +
    'mail smtp imap mx files share drive talk hpb signaling turn stun ldap ad dc db sql ' +
    'mysql mariadb postgres pg redis s3 minio storage nas proxy lb vpn auth sso idp keycloak login portal ' +
    'intranet extranet test testing stage staging dev prod production backup api app apps web static ' +
    'cdn admin push notify whiteboard').split(' '));

  const secretKeys = 'pass|passwd|password|pwd|secret|token|salt|apikey|api_key|api-key|private_?key|' +
    'credentials?|instanceid|dbpassword|mail_smtppassword|ldap_agent_password|authorization|cookie';

  const keyRx = new RegExp(`((?:["']?)(?:[\\w.-]*(?:${secretKeys})[\\w.-]*)["']?\\s*(?:=>|:|=)\\s*)(["'])((?:\\\\.|(?!\\2).)*)\\2`, 'gi');
  const bareKeyRx = new RegExp(`(\\b(?:${secretKeys})\\s*[=:]\\s*)([^\\s"',;&]{3,})`, 'gi');
  // Free text, English and German: "Passwort: x", "Password for the share: x",
  // "the password is x", "das Kennwort lautet x". A held value (\uE000) is a URL.
  const proseSecretRx = /(\b(?:(?:pass(?:wor[dt]|code|phrase)|kennwort|zugangscode|access[ -]code)\b[^\n=:]{0,30}?|(?:pass|passwd|pwd|pw|pin|secret|token)\s*)[=:]\s*)(["']?)(?!\uE000)([^\s"']{3,})\2/gi;
  const proseIsRx = /(\b(?:password|passwort|kennwort|passcode|passphrase|pin)\b[^\n.=:]{0,20}?\b(?:is|ist|lautet|was|war)\s+)(["']?)(?!\uE000)([^\s"',;]{3,}?)\2(?=[\s"',;]|\.?$|\.\s)/gim;

  const maps = new Map();                         // kind -> Map(original key -> pseudonym)
  const counters = new Map();
  const terms = new Map();                        // lowercase term -> pseudonym, matched as words
  let termRegex = null;

  // Placeholders survive later passes untouched: no letters, digits or dots in them.
  const sentinels = [];
  const hold = value => `\uE000${sentinels.push(value) - 1}\uE001`;
  const release = text => text.replace(/\uE000(\d+)\uE001/g, (m, i) => String(sentinels[Number(i)]));

  function next(kind) {
    const n = (counters.get(kind) || 0) + 1;
    counters.set(kind, n);
    return n;
  }

  function lookup(kind, key, make) {
    if (!maps.has(kind)) maps.set(kind, new Map());
    const map = maps.get(kind);
    if (!map.has(key)) map.set(key, make(next(kind)));
    return map.get(key);
  }

  // A pseudonym whose number is assigned when it is first written out, so
  // "Customer-1" is the first one in the export, not the first one registered.
  function ref(label) {
    let value = null;
    return { toString: () => value || (value = `${label}-${next('ref:' + label)}`) };
  }

  function derived(base, format) {
    return { toString: () => format(String(base)) };
  }

  function lazyLookup(kind, key, label) {
    if (!maps.has(kind)) maps.set(kind, new Map());
    const map = maps.get(kind);
    if (!map.has(key)) map.set(key, ref(label));
    return map.get(key);
  }

  // A fixed pseudonym that does not use up a counter: a known person's mail.
  function assign(kind, key, value) {
    if (!maps.has(kind)) maps.set(kind, new Map());
    if (!maps.get(kind).has(key)) maps.get(kind).set(key, value);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Müller also shows up as Mueller and Muller.
  function spellings(word) {
    const out = new Set([word]);
    const pairs = [[/ä/g, 'ae'], [/ö/g, 'oe'], [/ü/g, 'ue'], [/ß/g, 'ss'], [/Ä/g, 'Ae'], [/Ö/g, 'Oe'], [/Ü/g, 'Ue']];
    let ascii = word;
    let plain = word;
    for (const [rx, rep] of pairs) {
      ascii = ascii.replace(rx, rep);
      plain = plain.replace(rx, rep[0]);
    }
    out.add(ascii);
    out.add(plain.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    return [...out];
  }

  // Words that are never replaced: kept agents' names, the support company and
  // product names (configured, or learned from the agents' domains and organization).
  const protectedWords = new Set(['zammad']);
  for (const d of internalDomains) protectedWords.add(d.replace(/^\*\./, '').split('.')[0]);

  function protect(word) {
    if (!word || word.length < 3) return;
    for (const s of spellings(word.trim())) {
      protectedWords.add(s.toLowerCase());
      terms.delete(s.toLowerCase());
    }
    termRegex = null;
  }

  // capitalized: a surname like "Young" must not replace the adjective "young".
  function addTerm(term, pseudonym, { capitalized = false } = {}) {
    if (typeof term !== 'string') return;
    const t = term.trim();
    // Very short fragments ("Li", "AG") would hit unrelated words.
    if (t.length < 3) return;
    for (const s of spellings(t)) {
      const key = s.toLowerCase();
      if (!terms.has(key) && !protectedWords.has(key)) terms.set(key, { pseudonym, capitalized });
    }
    termRegex = null;
  }

  const nameStopwords = new Set(('herr frau dr prof ing dipl mr mrs ms miss sir madam van von der den de la le ' +
    'du di da del team support admin administrator agent customer system info service kunde kundin gmbh ag ' +
    'kg ug ohg mbh ev e.v inc ltd llc corp co sa sarl bv nv the und and bot robot noreply notification notifications ' +
    'automation helpdesk desk office').split(' '));

  const genericMailboxes = new Set(('info support admin contact kontakt office mail noreply no-reply service sales ' +
    'billing hello team help helpdesk it webmaster postmaster root abuse security privacy datenschutz buchhaltung').split(' '));

  const personByName = new Map();
  const keptStaff = new Set();

  // Register a person: every name part and the full name map to one pseudonym.
  // keep: false for an agent the caller could not confirm as staff.
  function addPerson({ firstname = '', lastname = '', name = '', email = '', login = '', phones = [], extra = [], role = 'person', keep = true } = {}) {
    const key = (email || `${firstname} ${lastname}`.trim() || name || login).toLowerCase();
    if (!key) return null;
    const label = role === 'customer' ? 'Customer' : role === 'agent' ? 'Agent' : 'Person';
    // One person with two mail addresses keeps one pseudonym.
    const fullName = (name || `${firstname} ${lastname}`).trim().toLowerCase();
    // The page's sender line repeats staff the API already confirmed.
    if (keptStaff.has(key) || (fullName && keptStaff.has(fullName))) return null;
    const pseudonym = (fullName && personByName.get(fullName)) || lazyLookup('person:' + label, key, label);
    if (fullName && !personByName.has(fullName)) personByName.set(fullName, pseudonym);
    const mailOf = derived(pseudonym, v => `${v.toLowerCase()}@example.com`);
    if (role === 'agent' && keepAgents && keep) {
      keptStaff.add(key);
      if (fullName) keptStaff.add(fullName);
      // Staff are shown by first name only: "Anna Young", "Young" -> "Anna".
      const full = name || `${firstname} ${lastname}`.trim();
      const words = full.split(/\s+/).filter(Boolean);
      const first = firstname || (words.length > 1 ? words[0] : '');
      const last = lastname || (words.length > 1 ? words.slice(1).join(' ') : '');
      // "Acme Support" or "Portal Bot" is a mailbox: keep it whole.
      const surname = last && last.split(/\s+/).every(w => !nameStopwords.has(w.toLowerCase()) && !protectedWords.has(w.toLowerCase()));
      if (first && last && surname) {
        protect(first);
        const cap = { capitalized: true };
        addTerm(full, first, cap);
        addTerm(`${last}, ${first}`, first, cap);
        addTerm(last, first, cap);
        for (const part of last.split(/\s+/)) if (!nameStopwords.has(part.toLowerCase())) addTerm(part, first, cap);
      } else {
        protect(full);
        for (const w of words) protect(w);
      }
      if (email) assign('email', email.toLowerCase(), mailOf);
      return first || full;
    }
    const full = name || `${firstname} ${lastname}`.trim();
    const cap = { capitalized: true };
    // "Acme Support" (Acme protected) or "Admin Team" names a mailbox, not a person.
    const isNameWord = w => w && !nameStopwords.has(w.toLowerCase().replace(/\.$/, '')) && !protectedWords.has(w.toLowerCase());
    if (full.split(/[\s,]+/).some(isNameWord)) {
      addTerm(full, pseudonym, cap);
      if (firstname && lastname) addTerm(`${lastname}, ${firstname}`, pseudonym, cap);
    }
    for (const part of [firstname, lastname, ...full.split(/[\s,]+/)]) {
      if (part && !nameStopwords.has(part.toLowerCase().replace(/\.$/, ''))) addTerm(part, pseudonym, cap);
    }
    if (email) {
      assign('email', email.toLowerCase(), mailOf);
      // "c.schaefer" identifies a person, "info" or "support" does not.
      const local = email.split('@')[0];
      if (/[a-z]/i.test(local) && local.length >= 4 && !genericMailboxes.has(local.toLowerCase())) addTerm(local, derived(pseudonym, v => v.toLowerCase()));
    }
    if (login && login !== email) addTerm(login, derived(pseudonym, v => v.toLowerCase()));
    for (const p of phones) addPhone(p);
    for (const e of extra) addTerm(e, derived(pseudonym, v => `[address of ${v}]`));
    return pseudonym;
  }

  // "Acme Corp Inc." -> "Acme Corp Inc.", "Acme Corp", "Acme"
  function nameCores(name) {
    const legalForm = /[\s,]+(?:gmbh|ag|kg|ug|ohg|mbh|e\.\s?v\.|inc\.?|ltd\.?|llc|corp\.?|co\.?|plc|sa|sarl|bv|nv|se|kgaa|& co\.?(?: kg)?)$/i;
    const out = [];
    let core = String(name || '').trim();
    if (core) out.push(core);
    while (legalForm.test(core)) {
      core = core.replace(legalForm, '').trim();
      if (core.length >= 3) out.push(core);
    }
    return out;
  }

  // The support company's own name, and product names: never pseudonymized.
  function addProtectedName(name) {
    for (const core of nameCores(name)) {
      for (const w of [core, ...core.split(/\s+/)]) {
        if (w.length >= 3 && !nameStopwords.has(w.toLowerCase())) protect(w);
      }
    }
  }

  function addOrganization(name, domains = []) {
    if (!name) return null;
    const pseudonym = lazyLookup('org', name.toLowerCase(), 'Org');
    // "Acme Corp Inc." is also written as "Acme Corp" or plain "Acme".
    for (const core of nameCores(name)) addTerm(core, pseudonym, { capitalized: true });
    for (const d of domains) host(d);
    return pseudonym;
  }

  // Values the caller knows are sensitive without knowing what they are (log user IDs).
  function addUserId(id) {
    if (!id || typeof id !== 'string' || id.length < 2) return null;
    if (/^(--|admin|root|null|undefined|system|cron|anonymous|guest|-)$/i.test(id)) return null;
    const existing = terms.get(id.toLowerCase());
    if (existing) return existing.pseudonym;
    const pseudonym = lazyLookup('userid', id.toLowerCase(), 'user');
    addTerm(id, pseudonym);
    return pseudonym;
  }

  function phoneKey(p) {
    return String(p).replace(/[^\d+]/g, '').replace(/^00/, '+');
  }

  function addPhone(p) {
    const key = phoneKey(p);
    if (key.replace(/\D/g, '').length < 6) return null;
    return lookup('phone', key, n => `[phone-${n}]`);
  }

  // Every address, also the support team's own: mailboxes and staff alike.
  function email(address) {
    return lookup('email', address.toLowerCase(), n => `user-${n}@example.com`);
  }

  function matchesHost(h, pattern) {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    return h === pattern;
  }

  function isPublic(h) {
    return publicHosts.some(p => matchesHost(h, p));
  }

  function isInternal(h) {
    if (!h) return false;
    return internalDomains.some(d => {
      const base = d.replace(/^\*\./, '');
      return h === base || h.endsWith('.' + base);
    });
  }

  function addInternalDomain(d) {
    const base = String(d || '').trim().toLowerCase();
    if (!base || isInternal(base) || isPublic(base)) return;
    internalDomains.push(base);
    protectedWords.add(base.split('.')[0]);
  }

  // cloud.acme.com -> cloud.domain1.example; x7.acme.com -> host1.domain1.example
  function host(name) {
    const h = name.toLowerCase().replace(/\.$/, '');
    // A bare internal host name ("cloud.our-company.com") says nothing about a customer.
    if (isPublic(h) || isInternal(h)) return name;
    const labels = h.split('.');
    const twoPartSuffix = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(labels.slice(-2).join('.'));
    const baseLen = twoPartSuffix ? 3 : 2;
    const base = labels.slice(-baseLen).join('.');
    const domain = lookup('domain', base, n => `domain${n}.example`);
    const sub = labels.slice(0, -baseLen);
    if (!sub.length) return domain;
    if (sub.every(l => genericLabels.has(l))) return `${sub.join('.')}.${domain}`;
    return lookup('host', h, n => `host${n}.${domain}`);
  }

  function ipv4(ip) {
    if (/^(127\.|0\.0\.0\.0$|255\.255\.255\.255$)/.test(ip)) return ip;
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip);
    // Private stays recognizable as private, public goes to the documentation ranges.
    if (isPrivate) return lookup('ip4private', ip, n => n <= 65000 ? `10.255.${Math.floor(n / 250)}.${n % 250 + 1}` : `[private-ip-${n}]`);
    const ranges = ['192.0.2', '198.51.100', '203.0.113'];
    return lookup('ip4', ip, n => n <= 750 ? `${ranges[Math.floor((n - 1) / 250)]}.${(n - 1) % 250 + 1}` : `[ip-${n}]`);
  }

  function ipv6(ip) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return ip;
    return lookup('ip6', lower, n => `2001:db8::${n.toString(16)}`);
  }

  function mac(m) {
    return lookup('mac', m.toLowerCase(), n => `02:00:00:00:${String(Math.floor(n / 256) % 256).padStart(2, '0')}:${(n % 256).toString(16).padStart(2, '0')}`);
  }

  function isValidIpv6(s) {
    if (!/[0-9a-f]/i.test(s)) return false;
    const doubles = s.split('::').length - 1;
    if (doubles > 1) return false;
    const groups = s.split(':').filter(g => g !== '');
    if (groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
    if (doubles === 0) return groups.length === 8;
    return groups.length >= 1 && groups.length <= 7;
  }

  // Path segments that hold a user ID or a share token: WebDAV, avatar and
  // share links of self-hosted clouds, and per-user data directories.
  const userPathRx = /(\/dav\/(?:files|uploads|trashbin|versions|calendars|principals\/users|addressbooks\/users)\/|\/avatar\/)([^/\s"'?#<>]+)/g;
  // only below a data directory: "/srv/nc-data/<user>/files", not "/apps/x/wopi/files"
  const dataDirRx = /(\/[^/\s"'?#<>]*data[^/\s"'?#<>]*\/)([^/\s"'?#<>]+)(\/(?:files|files_trashbin|files_versions|files_encryption|cache|uploads|thumbnails)(?=[/\s"']|$))/gi;
  // "/apps/files/js" and "/var/cache" are code and system paths, not a user's data dir.
  const notDataDirUser = /^(appdata_.*|__groupfolders|files_external|apps|apps-extra|custom_apps|core|lib|dist|js|css|img|l10n|templates|index\.php|remote\.php|ocs|dav|webdav|var|www|html|htdocs|srv|opt|usr|tmp|etc|data|config|resources|settings|admin|personal|s|u|ajax|api|v\d+(\.\d+)?|[\w-]+\.(php|js|json))$/i;
  const shareRx = /(\/(?:index\.php\/)?s\/)([A-Za-z0-9]{8,})/g;
  const homeRx = /((?:\/home|\/Users|[A-Z]:\\Users)[\\/])([^\\/\s"'<>]+)/g;

  // Instance IDs ("oc" + 10 characters) show up in WOPI file IDs and appdata
  // paths; once seen, the same ID is replaced everywhere (cookie names, config).
  const instanceRx = /(\d_|appdata_)(oc[a-z0-9]{10})(?![a-z0-9])/g;

  function instanceId(id) {
    const pseudonym = lookup('instance', id, n => `ocinstance${String(n).padStart(2, '0')}`);
    addTerm(id, pseudonym);
    return pseudonym;
  }

  function learnInstanceIds(input) {
    for (const m of String(input).matchAll(instanceRx)) instanceId(m[2]);
  }

  function path(p) {
    return p
      .replace(instanceRx, (m, pre, id) => pre + instanceId(id))
      .replace(shareRx, (m, pre, token) => pre + lookup('share', token, n => `SHARE${n}`))
      .replace(userPathRx, (m, pre, user) => pre + userIdOrKeep(user))
      .replace(dataDirRx, (m, pre, user, post) => notDataDirUser.test(user) ? m : pre + userIdOrKeep(user) + post)
      .replace(homeRx, (m, pre, user) => pre + userIdOrKeep(user));
  }

  function userIdOrKeep(user) {
    let decoded = user;
    try { decoded = decodeURIComponent(user); } catch { /* keep raw */ }
    return addUserId(decoded) || user;
  }

  function url(u) {
    const m = u.match(/^([a-z][a-z0-9+.-]*:\/\/)(?:([^@/\s]+)@)?(\[[0-9a-f:.]+\]|[^/:?#\s\[]+)(:\d+)?([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i);
    if (!m) return u;
    const [, scheme, userinfo, hostname, port = '', p = '', query = '', fragment = ''] = m;
    const lowerHost = hostname.toLowerCase();
    if (isPublic(lowerHost) && !userinfo) return u;
    // Tracker, CRM, portal or internal cloud links: path and query are the secret part.
    if (isInternal(lowerHost)) return lookup('internalurl', u, n => `[internal-link-${n}]`);
    let h = hostname;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) h = ipv4(hostname);
    else if (/^\[.*\]$/.test(hostname)) h = `[${ipv6(hostname.slice(1, -1))}]`;
    else if (hostname.includes('.')) h = host(hostname);
    const cleanQuery = query.replace(/=([^&]*)/g, (mm, v) => v ? '=[redacted]' : mm);
    return scheme + (userinfo ? '[redacted]@' : '') + h + port + path(p) + cleanQuery + (fragment ? '#[redacted]' : '');
  }

  function rebuildTermRegex() {
    if (!terms.size) return null;
    const alternatives = [...terms.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
    return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  }

  // English first; German forms stay because customers write both.
  const salutationRx = /\b(Hello|Hi|Hey|Dear|Good\s+(?:morning|afternoon|evening)|Thanks|Thank\s+you|Cheers|Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.?|Hallo|Liebe|Lieber|Moin|Servus|Guten\s+(?:Morgen|Tag|Abend)|Sehr\s+geehrte[rs]?|Herr|Frau|Herrn),?[ \t]+((?:(?:Mr\.?|Mrs\.?|Ms\.?|Miss|Dr\.|Prof\.|Herr|Frau|Herrn)[ \t]+)*)(\p{Lu}[\p{Ll}'-]+(?:[ \t]+\p{Lu}[\p{Ll}'-]+)?)/gu;
  const salutationStop = new Set(('Grüße Grüsse Gruesse Grüß Gruß Kollegen Kolleginnen Kollege Kollegin Team Support Zusammen ' +
    'Sir Madam Damen Herren All Everyone Everybody There Kunde Kundin Leute Folks Customer Admin Administrator ' +
    'Danke Thanks Thank Again Herr Frau Herrn Dr Prof Mr Mrs Ms Miss Valued Guys Sirs For In Advance Very Much ' +
    'So Again Both You We I The Again Good Morning Afternoon Evening Hello Hi Hey').split(' '));

  function text(input) {
    if (input === null || input === undefined) return input;
    sentinels.length = 0;
    learn(input);
    let s = String(input);

    // 1. secrets in config dumps and JSON: 'dbpassword' => 'x', "secret":"x", password=x
    s = s.replace(/(\b(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/g, (m, pre) => pre + hold('[redacted]'));
    s = s.replace(keyRx, (m, pre, q, v) => v ? pre + q + hold('[redacted]') + q : m);
    s = s.replace(bareKeyRx, (m, pre, v) => /^(Bearer|Basic|Token)$/.test(v) ? m : pre + hold('[redacted]'));
    s = s.replace(proseSecretRx, (m, pre, q) => pre + q + hold('[redacted]') + q);
    s = s.replace(proseIsRx, (m, pre, q) => pre + q + hold('[redacted]') + q);

    // 2. mail addresses (before URLs and hosts, they contain both)
    s = s.replace(/(?<![\w.%+-])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?![\w-])/g, m => hold(email(m)));

    // 3. URLs with scheme
    // balanced parentheses belong to the URL: ".../Support%20(LTS)?fileId=1"
    // no dots in the scheme, so "Firefox.https://..." keeps "Firefox." as text
    s = s.replace(/(?<![a-z0-9+-])[a-z][a-z0-9+-]*:\/\/(?:[^\s<>"'`()\[\]{}]|\([^\s<>"'`()]*\))+/gi, m => {
      const trail = m.match(/[.,;:!?]+$/)?.[0] || '';
      return hold(url(m.slice(0, m.length - trail.length))) + trail;
    });

    // 3b. URL-encoded URLs in query strings: WOPISrc=https%3A%2F%2Fcloud.acme.com%2F...
    s = s.replace(/\b((?:https?|wss?)%3A%2F%2F)([a-z0-9.-]+|\[[0-9a-f:]+\])/gi, (m, pre, h) => {
      const lower = h.toLowerCase();
      if (isPublic(lower)) return m;
      if (isInternal(lower)) return pre + hold(lookup('internalhost', lower, n => `internal-host-${n}.example`));
      return pre + hold(/^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? ipv4(h) : host(h));
    });

    // 4. paths outside URLs (logs, command output)
    s = s.replace(/(?:\/|[A-Z]:\\)[^\s"'<>]*/g, m => path(m));

    // 5. MAC before IPv6, both use colons
    s = s.replace(/(?<![\w:-])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![\w:-])/gi, m => hold(mac(m)));

    // 6. IPv4; four-part version numbers ("version":"29.0.4.1") look the same
    s = s.replace(/(?<![\w.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?!\w|\.\d)/g, (m, offset, whole) => {
      const before = whole.slice(Math.max(0, offset - 24), offset);
      if (/(version|ver\.?|release|\bv)["'\s:=]*$/i.test(before)) return m;
      // user agent tokens and package names: "Chrome/120.0.0.0", "server-8.1.0.2"
      if (/[A-Za-z][\w.-]*[/-]$/.test(before)) return m;
      // "<Product> 28.0.1.2" for a protected product name
      const word = (before.match(/([\p{L}-]+)\s+$/u) || [])[1];
      if (word && protectedWords.has(word.toLowerCase())) return m;
      return hold(ipv4(m));
    });

    // 7. IPv6
    s = s.replace(/(?<![\w:.])\[?((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})\]?(?![\w:])/gi, (m, ip) => {
      if (!isValidIpv6(ip)) return m;
      return m.replace(ip, hold(ipv6(ip)));
    });

    // 8. bare hostnames: cloud.acme.com, also inside "screenshot-cloud.acme.com.png"
    s = s.replace(/(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w-]|\.[a-z0-9])/gi, m => {
      let h = m;
      let ext = '';
      const last = h.slice(h.lastIndexOf('.') + 1);
      if (notTlds.has(last.toLowerCase())) {
        ext = h.slice(h.lastIndexOf('.'));
        h = h.slice(0, h.lastIndexOf('.'));
        if (!h.includes('.')) return m;
        const tld = h.slice(h.lastIndexOf('.') + 1);
        if (notTlds.has(tld.toLowerCase())) return m;
      }
      const tld = h.slice(h.lastIndexOf('.') + 1);
      // TLDs are lowercase, and "e.target.value" or "OC.Files.App" are code.
      if (!/^[a-z]{2}$/.test(tld) && !gTlds.has(tld)) return m;
      return hold(host(h)) + ext;
    });

    // 9. phone numbers: international form, or after a label
    // "+49 ...", not "00...": in logs that is a process ID or a timestamp
    s = s.replace(/(?<![\w+])\+[1-9]\d{0,2}[\s./-]?(?:\(0\)[\s./-]?)?\d[\d\s./-]{5,16}\d(?!\w)/g, m => hold(addPhone(m) || m));
    s = s.replace(/(\b(?:Tel|Telefon|Phone|Mobil|Mobile|Handy|Fax|Cell)\.?\s*[:.]?\s*)(\(?0\d[\d\s()./-]{5,16}\d)/gi, (m, pre, num) => pre + hold(addPhone(num) || num));

    // 10. known names, logins, organizations
    if (!termRegex) termRegex = rebuildTermRegex();
    if (termRegex) {
      s = s.replace(termRegex, m => {
        const t = terms.get(m.toLowerCase());
        if (!t || (t.capitalized && !/^\p{Lu}/u.test(m))) return m;
        return hold(t.pseudonym);
      });
    }

    return release(s);
  }

  // Names nobody told us about, after a salutation: "Hi Anna", "Dear Mr. Weber",
  // "Thanks, Tom". Call it on all texts first, so "Weber" is also replaced where
  // it comes before the salutation.
  function learn(input) {
    if (!input) return;
    learnInstanceIds(input);
    for (const m of String(input).matchAll(salutationRx)) {
      const name = m[3];
      const parts = name.split(/[ \t]+/);
      if (salutationStop.has(parts[0]) || parts.every(w => protectedWords.has(w.toLowerCase()))) continue;
      const known = terms.get(name.toLowerCase());
      const pseudonym = known ? known.pseudonym : lazyLookup('person:Person', name.toLowerCase(), 'Person');
      for (const part of parts) if (!salutationStop.has(part)) addTerm(part, pseudonym, { capitalized: true });
      addTerm(name, pseudonym, { capitalized: true });
    }
  }

  // JSON-lines logs: collect user IDs first so that a user
  // seen on line 900 is also replaced in a path on line 3.
  function scanLog(content) {
    learnInstanceIds(content);
    const userRx = /"(?:user|uid|userId|user_id|userid|owner|actor)"\s*:\s*"([^"\\]{1,128})"/g;
    let m;
    while ((m = userRx.exec(content))) addUserId(m[1]);
    // audit log messages and key=value lines: Login successful: "jdoe", uid=jdoe
    const auditRx = /(?:Login (?:successful|attempt|failed)[^"\n]{0,20}\\?"|\b(?:user|uid|userId|username)[=:]\s?\\?["']?)([A-Za-z0-9._@-]{2,64})/g;
    while ((m = auditRx.exec(content))) if (!m[1].includes('@')) addUserId(m[1]);
  }

  function file(content) {
    scanLog(content);
    // Line by line keeps regexes on bounded input and memory flat for big logs.
    let out = '';
    let start = 0;
    while (start < content.length) {
      let end = content.indexOf('\n', start);
      if (end === -1) end = content.length;
      out += text(content.slice(start, end));
      if (end < content.length) out += '\n';
      start = end + 1;
    }
    return out;
  }

  for (const w of config.protectedWords || []) addProtectedName(w);

  return { addPerson, addOrganization, addProtectedName, addUserId, addPhone, addTerm, addInternalDomain, isInternal, learn, text, file, host, url };
}

