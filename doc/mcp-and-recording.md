# MCP Servers and Playwright Session Recorder

## 1. MCP servers

Optional. Neither is needed to record a session (the script below does that).
They let Claude drive or inspect a live browser during a conversation.
The commands are from memory; verify the package names before relying on them.

| MCP server | Purpose | Add command |
|---|---|---|
| `chrome-devtools-mcp` | DevTools-style inspection: network, console, performance traces, screenshots, emulation | `claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest` |
| `@playwright/mcp` | Interactive control: click, type, navigate, read page state | `claude mcp add playwright -- npx @playwright/mcp@latest` |

Restart the Claude Code session after adding a server.

## 2. Playwright session recorder

Opens a headed Chromium window on a website. You use the site manually, and the script logs
everything.

### Setup

```
cd D:\projects\ext\playwright-test
npm i playwright
# only needed if the PC has no Chrome/Edge:
npx playwright install chromium
```

### Run

```
node record.js [url]
```

The default URL is the SAP Fiori page `https://webqasrise.sap.ofi.com/sap/bc/ui2/flp?sap-client=300&sap-language=EN#ZWeighBridge-display`. Log in manually in the window.

Optional env vars: `BROWSER=chrome|msedge|chromium` (default tries chrome, then msedge, then bundled chromium), `TRACE=1` (also save `trace.zip`; **not redacted**, may contain credentials).
Interact in the window, then close the main tab (or press Ctrl+C) to save.
A small "Saving..." keep-alive window also opens. Leave it alone; it closes itself.
Setting the env var `AUTO_CLOSE_MS` closes the page automatically (for unattended testing).

### Output (`output/<timestamp>/`)

| File | Contents |
|---|---|
| `events.jsonl` | UI events (click, change, submit, keydown; password fields masked; includes UI5 control ids), document/XHR/fetch requests with POST data, response previews (first 1000 chars), console messages, page errors, navigations (incl. Fiori hash changes) |
| `session.har` | Full network log with response bodies. Cookies, auth headers and password/token values are redacted after save |
| `trace.zip` | Only with `TRACE=1`. Screenshots, DOM snapshots, network. View with `npx playwright show-trace trace.zip` |

### Notes

- `npx playwright codegen <url>` records actions as code only. It does not capture network or console.
- The HAR is only written on `context.close()`. Closing the last window kills the browser first,
  hence the keep-alive window.
- Verified 2026-10-17: UI events, POST payload, responses, console, navigation, HAR and trace
  were all captured.

### SAP-specific notes

- **Scope:** everything under `https://webqasrise.sap.ofi.com/sap/` is recorded (any Fiori app, OData service, etc.). Requests, console, UI events and HAR entries outside that prefix are ignored. Override with `SCOPE=https://other.host/path/`. You can also pass any URL under the scope as the first argument.
- Because of the scope, login pages on a different host (SSO/IdP) are not recorded.
- Passwords/tokens are redacted from `events.jsonl` and `session.har` (regex on pass/pwd/token/secret keys). Review before sharing anyway.
- `ignoreHTTPSErrors` is on, since internal SAP hosts often use a private CA.
- `events.jsonl` skips static files (js/css/images); the HAR keeps everything.
- Fiori runs apps in iframes. The recorder injects into all frames and logs the frame URL.
- Not verified against the real SAP host (unreachable from the dev machine); tested against httpbin.

### `record.js`

```js
// Opens a headed browser on the SAP Fiori page, lets you work manually, and logs everything.
// Usage: node record.js [url]
// Options (env vars, all optional):
//   BROWSER=chrome|msedge|chromium   force a browser (default: try chrome, then msedge, then bundled chromium)
//   TRACE=1                          also save trace.zip (screenshots + DOM). WARNING: not redacted, may contain credentials
//   AUTO_CLOSE_MS=4000               close the page automatically (self-test)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] ||
  'https://webqasrise.sap.ofi.com/sap/bc/ui2/flp?sap-client=300&sap-language=EN#ZWeighBridge-display';
// Everything under this prefix is recorded (any Fiori app, OData service, etc.); other URLs are ignored.
// Override with SCOPE=https://other.host/path/
const SCOPE = process.env.SCOPE || 'https://webqasrise.sap.ofi.com/sap/';
const inScope = (u) => typeof u === 'string' && u.startsWith(SCOPE);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const outDir = path.join(__dirname, 'output', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outDir, { recursive: true });

// ---- redaction: never write passwords / tokens / cookies to disk ----
const SENSITIVE_KV = /((?:sap-)?pass(?:word)?|j_password|pwd|token|secret)(["']?\s*[=:]\s*["']?)([^&"'\s,}]+)/gi;
const redact = (s) => (typeof s === 'string' ? s.replace(SENSITIVE_KV, '$1$2***') : s);
const SENSITIVE_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'x-csrf-token', 'proxy-authorization']);

const logFile = path.join(outDir, 'events.jsonl');
const log = (type, data) => {
  const line = JSON.stringify({ t: new Date().toISOString(), type, ...data });
  fs.appendFileSync(logFile, line + '\n');
  console.log(`[${type}]`, JSON.stringify(data).slice(0, 200));
};

// events.jsonl only keeps meaningful traffic (page loads + XHR/fetch, i.e. OData calls); HAR keeps everything
const INTERESTING = new Set(['document', 'xhr', 'fetch']);

async function launch() {
  const wanted = process.env.BROWSER;
  const order = wanted ? [wanted] : ['chrome', 'msedge', 'chromium'];
  let lastErr;
  for (const ch of order) {
    try {
      const opts = { headless: false };
      if (ch !== 'chromium') opts.channel = ch;
      const b = await chromium.launch(opts);
      console.log('Using browser:', ch);
      return b;
    } catch (e) { lastErr = e; }
  }
  throw new Error('No browser could be launched. Install Chrome/Edge or run: npx playwright install chromium\n' + lastErr.message);
}

(async () => {
  const browser = await launch();
  const context = await browser.newContext({
    viewport: null,
    ignoreHTTPSErrors: true, // internal SAP hosts often use a private CA
    recordHar: {
      path: path.join(outDir, 'session.har'), content: 'embed', // full network incl. bodies (redacted after save)
      urlFilter: new RegExp('^' + escapeRe(SCOPE)),
    },
  });
  if (process.env.TRACE) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  // UI interactions: injected into every page/frame (Fiori runs content in iframes), reported via binding
  await context.exposeBinding('__logUi', (src, ev) =>
    inScope(src.page.url()) && log('ui', { page: src.page.url(), frame: src.frame.url() !== src.page.url() ? src.frame.url() : undefined, ...ev }));
  await context.addInitScript(() => {
    const desc = (el) => el && el.tagName ? {
      tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.name || undefined,
      closestId: (el.closest('[id]') || {}).id || undefined, // UI5 control id (e.g. __button3, ...--btnSave)
      aria: el.getAttribute('aria-label') || el.title || undefined,
      text: (el.innerText || '').trim().slice(0, 60) || undefined,
      type: el.type || undefined,
    } : {};
    for (const evt of ['click', 'change', 'submit', 'keydown']) {
      window.addEventListener(evt, (e) => {
        const el = e.target;
        const ev = { event: evt, target: desc(el) };
        if (evt === 'change' && el) ev.value = el.type === 'password' ? '***' : el.value;
        if (evt === 'keydown') { if (el && el.type === 'password') return; ev.key = e.key; }
        window.__logUi && window.__logUi(ev);
      }, true);
    }
  });

  const attach = (page) => {
    page.on('console', (m) => inScope(page.url()) && log('console', { level: m.type(), text: redact(m.text()) }));
    page.on('pageerror', (e) => inScope(page.url()) && log('pageerror', { message: redact(e.message) }));
    page.on('request', (r) => {
      if (!INTERESTING.has(r.resourceType()) || !inScope(r.url())) return;
      log('request', { method: r.method(), url: redact(r.url()), postData: redact(r.postData()) });
    });
    page.on('response', async (r) => {
      const type = r.request().resourceType();
      if (!INTERESTING.has(type) || !inScope(r.url())) return;
      let size, body;
      try {
        const buf = await r.body();
        size = buf.length;
        if (type !== 'document') body = redact(buf.toString('utf8').slice(0, 1000)); // preview of OData/JSON replies
      } catch {}
      log('response', { status: r.status(), url: redact(r.url()), size, body });
    });
    page.on('framenavigated', (f) => f === page.mainFrame() && inScope(f.url()) && log('navigate', { url: redact(f.url()) }));
  };
  context.pages().forEach(attach);
  context.on('page', attach);

  const page = await context.newPage();
  await page.goto(URL).catch((e) => console.log('goto warning:', e.message)); // still allow manual login if it redirects/slow
  console.log('\n>>> Browser is open. Log in and do the process manually, then CLOSE THE MAIN TAB to save. <<<\n');

  // Finish when the last tab is closed (or Ctrl+C), so HAR gets flushed to disk.
  const done = new Promise((res) => {
    const check = () => context.pages().length === 0 && res();
    context.on('page', (p) => p.on('close', check));
    page.on('close', check);
    process.on('SIGINT', res);
  });
  // Keep-alive: a separate context in the same browser, so closing your last tab doesn't kill
  // the browser before the HAR is flushed. It is closed automatically after saving.
  const keepAlive = await browser.newContext({ viewport: { width: 300, height: 120 } });
  const kaPage = await keepAlive.newPage();
  await kaPage.setContent('<body style="font:14px sans-serif">Saving... this window closes itself.<br>(Do not use)</body>');
  if (process.env.AUTO_CLOSE_MS) setTimeout(() => page.close(), +process.env.AUTO_CLOSE_MS); // for self-test
  await done;

  try {
    if (process.env.TRACE) await context.tracing.stop({ path: path.join(outDir, 'trace.zip') });
    await context.close(); // flushes the HAR
  } catch (e) { console.log('save error:', e.message); }
  await browser.close().catch(() => {});

  // Redact the HAR: strip cookies/auth headers and password-like values
  const harPath = path.join(outDir, 'session.har');
  try {
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    const scrubHeaders = (hs) => hs.forEach((h) => { if (SENSITIVE_HEADERS.has(h.name.toLowerCase())) h.value = '***'; });
    for (const e of har.log.entries) {
      scrubHeaders(e.request.headers); scrubHeaders(e.response.headers);
      e.request.cookies = []; e.response.cookies = [];
      e.request.url = redact(e.request.url);
      (e.request.queryString || []).forEach((q) => { q.value = redact(`${q.name}=${q.value}`).split('=').slice(1).join('='); });
      if (e.request.postData) {
        e.request.postData.text = redact(e.request.postData.text);
        (e.request.postData.params || []).forEach((p) => { p.value = redact(`${p.name}=${p.value}`).split('=').slice(1).join('='); });
      }
      if (e.response.content && e.response.content.text) e.response.content.text = redact(e.response.content.text);
    }
    fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
  } catch (e) { console.log('HAR redaction error (HAR may contain secrets, do not share):', e.message); }

  console.log('\nSaved to', outDir);
  for (const f of fs.readdirSync(outDir)) console.log(' -', f, fs.statSync(path.join(outDir, f)).size, 'bytes');
})();
```

