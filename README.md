# Zammad Ticket Copier - Firefox & Chrome Extension

Intelligently extract and export Zammad ticket conversations for analysis, archival, and AI processing.

## Overview

A lightweight browser extension for Firefox and Chrome that extracts entire support ticket conversations from Zammad helpdesk systems. Export as formatted text or structured JSON for use with AI tools, data pipelines, and knowledge management systems.

**Perfect for:**
- Support teams needing quick ticket archives
- Analysts processing support data
- Building knowledge bases from conversations
- AI-powered ticket analysis and summarization
- Custom automation workflows

## Features

- **One-Click Extraction** - Copy full ticket transcripts instantly
- **Smart Content Cleaning** - Removes signatures, disclaimers, and farewell markers automatically
- **Structured JSON Export** - Download tickets in machine-readable format
- **AI-Ready Format** - Perfect for Perplexity, ChatGPT, Claude, and similar tools
- **User-Controlled Permissions** - You decide which Zammad instances to grant access to
- **Pseudonymization** - Replaces names, mails, hosts, IPs and secrets with consistent pseudonyms
- **Attachment Download** - Saves text attachments such as logs next to the JSON, pseudonymized too
- **Zero Data Collection** - Privacy-first: no tracking, no external servers
- **Firefox Developer Edition Compatible** - Full support for development workflows

## Pseudonymization

With "Pseudonymize" on, the export keeps the conversation readable but replaces
what identifies the customer side. The same value gets the same pseudonym
everywhere in one export, in the conversation and in every attachment, so an
AI can still follow who said what and which host a log line is about. Nothing
is stored: the mapping exists only while one export runs.

| What | Becomes |
| --- | --- |
| Customers and other people (ticket users, From/To/Cc, sender names) | `Customer-1`, `Person-1` |
| Support agents, only with "Keep support agent names" off or when Zammad roles are not readable | `Agent-1` |
| Names after a salutation ("Hi Tom", "Dear Mr. Weber", "Thanks, Anna") | `Person-N` |
| Organizations, with and without legal form | `Org-1` |
| Mail addresses, always, the support team's own included | `customer-1@example.invalid`, `agent-1@example.invalid`, `user-N@example.invalid` |
| Customer host names and URLs (path user IDs, share tokens, query values) | `cloud.domain1.example`, `host1.domain1.example`, `/s/SHARE1`, `?dir=[redacted]` |
| URLs on internal domains that are not public (tracker, CRM, portal, internal cloud) | `[internal-link-N]` |
| Public IPv4 / private IPv4 / IPv6 / MAC | `192.0.2.x` / `10.255.x.x` / `2001:db8::x` / `02:00:00:00:..` |
| Phone numbers (international form or after "Tel", "Phone", ...) | `[phone-N]` |
| User IDs in JSON logs, WebDAV and data directory paths | `user-N` |
| Passwords, secrets, tokens, salts, `instanceid` in config dumps and logs | `[redacted]` |

Kept as is: support agents' names (switch off with "Keep support agent names"), the support company's name and the protected
words, loopback addresses, version numbers, URLs on public hosts, and the
ticket number. The page URL is left out.

URLs fall into three groups:

- **Public hosts**: kept. Built in are only vendor-neutral references
  (GitHub, Stack Overflow, MDN, distribution and database docs, ...).
- **Internal domains**: the agents' mail domains, plus any you add. Every URL
  there that is not public becomes `[internal-link-N]`, since its path
  (tracker, CRM, portal, internal cloud) is what is confidential.
- **Everything else** is a customer host and gets pseudonymized.

Who is support staff comes from Zammad roles only: users whose role grants
an agent or admin permission (`/api/v1/roles`). Everyone else is customer
side, also a customer's colleague that an agent logged a call for, and gets
pseudonymized. If the roles are not readable, every person is pseudonymized.

No company or product is built in. The extension learns the support side
from the ticket: the staff mail domains become internal domains, and the
staff organization becomes a protected name, so a sender like
"<Company> Support" does not turn every mention of the company into a
pseudonym.

### Settings for your team

Under "Advanced" in the popup, one entry per line:

- **Public hosts**: add your own public sites, for example your docs,
  community forum and the forums of products you support
  (`docs.your-company.com`, `*.forum.product.org`).
- **Internal domains**: domains of internal tools that are not your agents'
  mail domain (`your-crm.io`).
- **Protected words**: your company and product names
  (`YourProduct`, `Partner Office`).

Names come from the Zammad API (`/api/v1/tickets/:id?all=true`) with the
agent's session; if it is not readable, only the article senders are known.

Limits: a name that appears only in free text, without salutation and without
being a ticket user, is not found. File names inside paths are kept. Check the
output before you hand it to an external service.

## Attachments

The download uses the format selected for the clipboard: JSON, or plain text,
which is shorter and reads better in AI chats.

With "Download attachments" on, "Download ... + attachments" saves into
`Downloads/zammad/ticket-<number>-<time>/`:

- `ticket.json` or `ticket.txt`, with each message listing its attachments
- text attachments (`.log`, `.txt`, `.json`, `.csv`, `.php`, `.yaml`, ..., also
  `.gz` compressed ones, which are unpacked), pseudonymized like the
  conversation and named `a<message>-<n>.<ext>` instead of their original name
- archives, images and PDFs only with "Also archives, images, PDFs"; they are
  saved unchanged, NOT pseudonymized, and are marked so in the JSON

Inline images (signature logos) are skipped. Files above 40 MB are skipped.

## Installation

Build first: `npm install && npm run build`.

### Firefox (temporary loading)
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `build/firefox/manifest.json`

### Chrome / Edge
1. Go to `chrome://extensions` and enable Developer mode
2. Click "Load unpacked"
3. Select `build/chrome/`

### For Development

One source tree, two browsers:

```
src/extract.js            extraction, runs inside the Zammad page (shared)
src/pseudonymize.js       pseudonymizer, injected into the page before extract.js
src-firefox/background.js Firefox MV2 background: injects extract.js as code
src/popup.*, icons        shared
src-<browser>/            files only that browser gets (copied over src/)
src/browser-shim.js       maps `browser` to `chrome` where it is missing
src-chrome/service_worker.js  Chrome MV3: chrome.scripting.executeScript(func)
src-chrome/offscreen.*    Chrome only: blob URLs for saving attachments
test/                     unit tests for the pseudonymizer (npm test)
manifests/base.json       shared manifest keys
manifests/firefox.json    Manifest V2, Gecko ID
manifests/chrome.json     Manifest V3, scripting permission
```

```bash
npm run build          # build/<browser>/ and dist/zammad-ticket-extractor-<browser>-<version>.zip
npm run lint:firefox   # web-ext lint on build/firefox
npm run check:chrome   # loads build/chrome in headless Chromium
npm test               # pseudonymizer unit tests
```
