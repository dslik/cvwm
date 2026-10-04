/*!
 * Framer for cvwm: makes a new application that frames a web page.
 *
 * Some web programs cannot be a cvwm app of their own (they need a server cvwm cannot host); the honest way
 * to bring them in is to frame a running instance, as Earthworm does. This tool writes such a
 * wrapper for you: give it a URI, an application name and a window title, and it creates /apps/<name>/ holding
 * an index.js that frames the URI and an index.png taken from the page's favicon (or a generic framed-web icon
 * where the favicon cannot be read). The new app then opens from its container like any other.
 *
 * The favicon is fetched and drawn to a canvas to make a 64x64 PNG. A cross-origin favicon that the server does
 * not share (no permissive CORS) taints the canvas and cannot be read back; the generic icon is used instead.
 */
(function () {
  'use strict';

  var CTX = window.CDMI_CONTEXT || {};
  var HEADERS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string with optional {token} substitution; the stylesheet is pulled where present.
  var R = CTX.rsrc || null;
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var T_OBJECT = 'application/cdmi-object', T_CONTAINER = 'application/cdmi-container';

  var style = document.createElement('style');
  var DEFAULT_CSS =
    'html,body{margin:0;height:100%;background:#20222a;color:#e6e6e6;font:13px Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif}' +
    'body{display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}' +
    '.box{width:100%;max-width:560px}h2{margin:0 0 4px;font-size:17px}p.sub{margin:0 0 16px;color:#9aa0b0;line-height:1.5}' +
    'label{display:block;margin:12px 0 4px;color:#c7ccd8;font-size:12px}' +
    'input{width:100%;box-sizing:border-box;height:32px;padding:0 9px;background:#12141a;color:#eee;border:1px solid #3a3f4b;border-radius:4px;font:13px "DejaVu Sans Mono",monospace}' +
    'input:focus{outline:none;border-color:#3b6ea5}' +
    '.hint{color:#7a8090;font-size:11px;margin-top:3px}' +
    '.preview{display:flex;align-items:center;gap:10px;margin-top:16px;min-height:48px}' +
    '.preview img,.preview canvas{width:48px;height:48px;image-rendering:auto;background:#0c0d11;border:1px solid #333;border-radius:6px}' +
    '.preview .lbl{color:#9aa0b0;font-size:12px}' +
    '.err{color:#ff8a80;min-height:18px;font-size:12px;margin-top:10px}' +
    '.msg{color:#8fd48f;min-height:18px;font-size:12px;margin-top:10px}' +
    '.row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}' +
    'button{height:32px;padding:0 16px;background:#333844;color:#eee;border:1px solid #4a5060;border-radius:4px;cursor:pointer}' +
    'button:hover{background:#3d4350}button.go{background:#3b6ea5;border-color:#3b6ea5}button:disabled{opacity:.5;cursor:default}';
  style.textContent = (R && R.text('styles', 'framer')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    for (var k in props) { if (k === 'text') e.textContent = props[k]; else e.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  var uri = el('input', { type: 'text', spellcheck: 'false', placeholder: S('uriPlaceholder', 'https://host:port/  (the page to frame)') });
  var name = el('input', { type: 'text', spellcheck: 'false', placeholder: S('namePlaceholder', 'app-name  (the container under /apps/)') });
  var title = el('input', { type: 'text', spellcheck: 'false', placeholder: S('titlePlaceholder', 'Window title') });
  var previewImg = el('img', { alt: '' }), previewLbl = el('span', { class: 'lbl', text: S('previewIntro', 'The icon appears here once a URI is entered.') });
  var err = el('div', { class: 'err' }), msg = el('div', { class: 'msg' });
  var cancel = el('button', { type: 'button', text: S('cancel', 'Cancel') }), make = el('button', { type: 'button', class: 'go', text: S('create', 'Create app') });
  var preview = el('div', { class: 'preview' }, [previewImg, previewLbl]);
  document.body.appendChild(el('div', { class: 'box' }, [
    el('h2', { text: S('heading', 'Frame a web application') }),
    el('p', { class: 'sub', text: S('sub', 'Creates a new cvwm app that frames a web page. The app is written to /apps/ and opens like any other.') }),
    el('label', { text: S('uriLabel', 'URI to frame') }), uri, el('div', { class: 'hint', text: S('uriHint', 'The page must allow being framed from this desktop (its frame-ancestors / origin allow-list).') }),
    el('label', { text: S('nameLabel', 'Application name') }), name, el('div', { class: 'hint', text: S('nameHint', 'Letters, digits, - and _; becomes the container name under /apps/.') }),
    el('label', { text: S('titleLabel', 'Window title') }), title,
    preview, err, msg,
    el('div', { class: 'row' }, [cancel, make])
  ]));

  if (CTX.resize) CTX.resize(600, 560);
  if (CTX.setTitle) CTX.setTitle(S('title', 'Framer'));

  /* ---- favicon -> 64x64 PNG data, or null if it cannot be read */
  var iconData = null, iconMime = 'image/png', iconTried = '', iconSeq = 0;
  function faviconCandidates(u) {
    try {
      var p = new URL(u), origin = p.origin;
      // The page's own <link rel=icon> is the authority, but we cannot read another origin's HTML here, so we try
      // the well-known locations. A cross-origin icon that the server does not share with CORS taints the canvas
      // and cannot be turned into a PNG; the generic icon is used then. This is expected, not an error.
      return [origin + '/favicon.ico', origin + '/favicon.png', origin + '/apple-touch-icon.png', origin + '/apple-touch-icon-precomposed.png'];
    } catch (e) { return []; }
  }
  // Getting the real favicon saved needs its actual bytes. Two ways, in order:
  //   1. fetch() the candidate; if the server allows the read (CORS, or same-origin), store the bytes verbatim.
  //      No canvas, so no taint, and no re-encoding: an .ico is saved as-is, a .png as-is. cvwm draws either.
  //   2. If the fetch is CORS-blocked, load it into an <img> to display (a plain load shows a no-CORS icon), and
  //      try a canvas read in case that origin happens to allow it; otherwise save the generic icon.
  // Only a favicon that neither fetches nor loads is "not found".
  function mimeOf(url, ct) { if (ct) return ct.split(';')[0].trim(); if (/\.png$/i.test(url)) return 'image/png'; if (/\.ico$/i.test(url)) return 'image/x-icon'; if (/\.svg$/i.test(url)) return 'image/svg+xml'; return 'image/png'; }
  function loadFavicon() {
    var u = normalizeURI(uri.value); if (!u || u === iconTried) return; iconTried = u;
    var myseq = ++iconSeq;
    iconData = null; iconMime = 'image/png'; previewLbl.textContent = S('lookingFavicon', 'Looking for a favicon\u2026');
    var cands = faviconCandidates(u), i = 0;
    (async function attempt() {
      if (myseq !== iconSeq) return;
      if (i >= cands.length) { if (!iconData) useGeneric(S('noFavicon', 'No favicon could be saved; the generic icon will be used.')); return; }
      var cand = cands[i];
      // The desktop shares the server's origin (not this iframe's opaque one), so its fetch reaches more icons.
      var got = null;
      try { if (CTX.desktop && CTX.desktop.fetchBytes) got = await CTX.desktop.fetchBytes(cand); } catch (e) { got = null; }
      if (myseq !== iconSeq) return;
      if (got && got.base64 && /^image\//.test(got.mime || '')) {
        iconMime = got.mime || mimeOf(cand, null); iconData = got.base64;
        previewImg.src = 'data:' + iconMime + ';base64,' + iconData; previewLbl.textContent = S('iconFromFavicon', 'Icon from the page favicon.');
        return;
      }
      display(cand, myseq, function () { i++; attempt(); });
    })();
  }

  // HTTP-import fallback: have the CDMI server fetch the favicon and read it back. Tried once, for the whole set of
  // candidates, only if the in-browser attempts left us on the generic icon and the server offers cdmi_import_http.
  var importTried = false;
  async function tryImportFavicon() {
    if (importTried) return; importTried = true;
    var u = normalizeURI(uri.value); if (!u) return;
    var base = appsBase() && appsBase().replace(/apps\/$/, '');            // the disk base
    if (!base) return;
    if (!(await serverImportsHttp(base))) { previewLbl.textContent += S('noHttpImport', ' (server offers no HTTP import)'); return; }
    var cands = faviconCandidates(u);
    for (var i = 0; i < cands.length; i++) {
      var https = cands[i].replace(/^http:/, 'https:'); if (!/^https:/.test(https)) continue;   // import_uri must be https
      var tmp = base + 'cdmi_objectid/';                                    // a nameless object: created, read, deleted
      try {
        var made = await put(base + '.framer-favicon-tmp', T_OBJECT, JSON.stringify({ imports: [{ type: 'HTTP', import_uri: https }] }), { 'If-None-Match': '*' });
        if (!made.ok && made.status !== 412) continue;
        var obj = base + '.framer-favicon-tmp';
        var read = await fetch(obj + '?value&mimetype&metadata=cdmi_size', { headers: Object.assign({ Accept: T_OBJECT }, HEADERS), credentials: 'same-origin' });
        if (read.ok) {
          var rep2 = await read.json(), v = rep2.value, enc = rep2.valuetransferencoding, mime = rep2.mimetype || '';
          var b64 = enc === 'base64' ? v : (typeof v === 'string' ? btoa(unescape(encodeURIComponent(v))) : null);
          if (b64 && /^image\//.test(mime) && b64.length > 4) {
            iconData = b64; iconMime = mime; previewImg.src = 'data:' + mime + ';base64,' + b64;
            previewLbl.textContent = S('iconFromServer', 'Icon fetched by the server (HTTP import).');
            await deleteObj(obj); return;
          }
        }
        await deleteObj(obj);
      } catch (e) { /* try the next candidate */ }
    }
  }
  async function serverImportsHttp(base) {
    try {
      var r = await fetch(base + 'cdmi_capabilities/?capabilities', { headers: Object.assign({ Accept: 'application/cdmi-capability' }, HEADERS), credentials: 'same-origin' });
      if (!r.ok) return false; var caps = (await r.json()).capabilities || {}; return String(caps.cdmi_import_http) === 'true';
    } catch (e) { return false; }
  }
  async function deleteObj(url) { try { await fetch(url, { method: 'DELETE', headers: HEADERS, credentials: 'same-origin' }); } catch (e) { /* leave it */ } }
  // Show a favicon we could not read the bytes of, and save the generic icon in its place.
  function display(cand, myseq, andThen) {
    var img = new Image();
    img.onload = function () { if (myseq !== iconSeq) return; if (!iconData) { previewImg.src = cand; iconData = GENERIC_PNG; iconMime = 'image/png'; previewLbl.textContent = S('faviconNoCors', 'The favicon can be shown but not read (no CORS); the generic icon will be saved.'); } andThen(); };
    img.onerror = function () { if (myseq === iconSeq) andThen(); };
    img.src = cand;
  }
  function useGeneric(why) {
    iconData = GENERIC_PNG; iconMime = 'image/png'; previewImg.src = 'data:image/png;base64,' + GENERIC_PNG; previewLbl.textContent = why || S('genericIcon', 'Generic framed-web icon.');
    // offer the server-side fetch, which gets past CORS
    tryImportFavicon();
  }
  // Fetch the favicon only when the user has finished the URI (leaves the field, or presses Enter), not on every
  // keystroke. The name is still suggested as they type.
  uri.addEventListener('input', function () { if (!name.value || name.value === lastSuggest) { name.value = suggestName(uri.value); lastSuggest = name.value; } });
  uri.addEventListener('blur', loadFavicon);
  uri.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') loadFavicon(); });
  var lastSuggest = '';

  function suggestName(u) { try { return new URL(normalizeURI(u) || u).hostname.split('.').slice(-2, -1)[0] || ''; } catch (e) { return ''; } }
  function normalizeURI(raw) {
    var u = (raw || '').trim(); if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { var p = new URL(u); return (p.protocol === 'https:' || p.protocol === 'http:') ? p.href : null; } catch (e) { return null; }
  }

  /* ---- the generated app: a framing wrapper, with the URI and title baked in */
  function generatedIndexJs(fURI, fTitle) {
    var jUri = JSON.stringify(fURI), jTitle = JSON.stringify(fTitle);
    return '/*! ' + fTitle.replace(/\*\//g, '* /') + ' \u2014 a framed web application, made by Framer for cvwm. */\n' +
      '(function () {\n' +
      "  'use strict';\n" +
      '  var CTX = window.CDMI_CONTEXT || {}, URI = ' + jUri + ', TITLE = ' + jTitle + ';\n' +
      "  var s = document.createElement('style');\n" +
      "  s.textContent = 'html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}';\n" +
      '  document.head.appendChild(s);\n' +
      "  var f = document.createElement('iframe'); f.title = TITLE; f.src = URI; f.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');\n" +
      '  document.body.appendChild(f);\n' +
      '  if (CTX.setTitle) CTX.setTitle(TITLE);\n' +
      '  if (CTX.resize) CTX.resize(1100, 760);\n' +
      '})();\n';
  }

  /* ---- CDMI writes */
  async function put(url, type, body, extra) {
    var h = Object.assign({ 'Content-Type': type, Accept: type }, extra || {});
    for (var k in HEADERS) h[k] = HEADERS[k];
    return fetch(url, { method: 'PUT', headers: h, body: body, credentials: 'same-origin' });
  }
  function appsBase() {
    // where to write: the disk the framer runs on, at its /apps/ container
    var base = CTX.baseURI || (CTX.namespaces && CTX.namespaces[0] && CTX.namespaces[0].baseURI);
    return base ? base + 'apps/' : null;
  }

  async function create() {
    err.textContent = ''; msg.textContent = '';
    var u = normalizeURI(uri.value); if (!u) { err.textContent = S('invalidUri', 'Enter a valid http(s) URI.'); return; }
    var nm = (name.value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(nm)) { err.textContent = S('invalidName', 'The name may hold letters, digits, - and _, and must not start with - or _.'); return; }
    var ttl = (title.value || '').trim() || nm;
    var base = appsBase(); if (!base) { err.textContent = S('noDisk', 'No disk is mounted to write the app to.'); return; }
    if (!iconData) useGeneric();
    make.disabled = true; msg.textContent = S('creating', 'Creating \u2026');
    var appURL = base + encodeURIComponent(nm) + '/';
    try {
      // the container (fail if it exists, so we do not clobber an app)
      var made = await put(appURL, T_CONTAINER, JSON.stringify({ metadata: {} }), { 'If-None-Match': '*' });
      if (made.status === 412 || made.status === 409) { err.textContent = S('appExists', 'An app named "{nm}" already exists.', { nm: nm }); make.disabled = false; msg.textContent = ''; return; }
      if (!made.ok) throw new Error('container: ' + made.status);
      // index.js
      var js = generatedIndexJs(u, ttl);
      var r1 = await put(appURL + 'index.js', T_OBJECT, JSON.stringify({ mimetype: 'text/javascript', valuetransferencoding: 'utf-8', value: js }));
      if (!r1.ok) throw new Error('index.js: ' + r1.status);
      // index.png (base64)
      var r2 = await put(appURL + 'index.png', T_OBJECT, JSON.stringify({ mimetype: iconMime, valuetransferencoding: 'base64', value: iconData }));
      if (!r2.ok) throw new Error('index.png: ' + r2.status);
      msg.textContent = S('createdOpening', 'Created {nm}. Opening \u2026', { nm: nm });
      var D = CTX.desktop;
      if (D && D.rescan) D.rescan();                                // redraw the disks (helper detection, icons)
      if (D && D.reload) D.reload(base);                            // refresh any open browser window showing /apps/
      setTimeout(function () {
        if (CTX.open) CTX.open(appURL); else if (D && D.open) D.open(appURL);   // open the new app
        if (CTX.close) CTX.close();                                 // and close the framer
      }, 300);
    } catch (e) {
      err.textContent = S('couldNotCreate', 'Could not create the app: {e}', { e: (e && e.message || e) }); make.disabled = false; msg.textContent = '';
    }
  }
  make.addEventListener('click', create);
  cancel.addEventListener('click', function () { if (CTX.close) CTX.close(); });
  [uri, name, title].forEach(function (inp) { inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') create(); }); });
  uri.focus();

  /* a generic "framed web application" icon: a browser window with a globe, 64x64 PNG */
  var GENERIC_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAA/1BMVEUAAADx8/VZd6l4gpLM5NH///9Vqqp8iJSWnann6+1Zhmt3eIfK0+LH2s1GeFl4h5WBi5o0a0qEqZGqxbOUpsV1m4U8cFFNfWB9fX9plHlgjHF7oolufZaKn8Hb8N6YuqJ5g5CRtJy00by71sIA//+qqqqguKx5g5N5gpF6hJPe8+EAAP9VVVV6hpSBi5qfwKnY4eBVVapvb39zf45/f/99jKWEjZeBjqGZoKvEzdwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABJYkwVAAAAQHRSTlMA/v74/wEDQfz+/xD//v8R//////////8D/////f///2z///8BA/+brcn/AQM+Qf//AxBCAv8b//3+AAAAAAAAOE566gAAAi1JREFUeNrtl2lv2zAMhpXJOcRMcihHPtfcV9Nz9/b//9gop40bt+7MYB+Goi9gQ1DCRyRFyZIQ73pbWnXb6wXzz984g12t6z2pEGE4bKuQ/K3b93eSocuZ6J7azyRPP7fpdWXfE335ganvM1Hl4fpqxwZIOTxG0RVfJBvwSd6Q54+AYQkYj6unBeBrHTDudC4uDs+4DaD/zwHcEJ4DmEn8vwChlL8/8jSoAUYdpn7VAeqFPylVvesatAGU1g0/tAGoyEGSgNvcnwfYAKJJEoOxsYoPUA6NgYXWOjMGQXMBKkO4M/OAtDBzh4lmAhzmwTTx9jrI3KRAUCzAhpwO8oKsSZHRgUPHASiIo0CbKCjlG0uINQMQYeYHXh4AAVAuLFoGoMBpQCnQgfaiJPhUnmbhdQBQ1HubTw4O7C1Qi/paA1RiCmtzsKUK3ypsLQl/AwCpfMFjK+EAfAiTYwgTC/TOGAAqI5rBOTzMYpDRnCxZSdxgcTKNluakVkmvA+6NWdCYx0K6IwhGnFK2vpJo4IdSXlAd5ay1oACLQ+6IUeT7qTGatxp1gi6iGLSPYDqP44i7oWhASEoXCgNoIv6WplyMMWRZbmLM9VmbqrZgkCAuOntbV34xqhbb+rDxu9CopwCRppdSN31YGvqlDKuj4lrMRk2EBvuB3FUOeBe2IzlgiM6qYfr0rLriHlW36elZ18/EzW2/rW5/CFE/8q95l4ve8yvDqsdQ+n4/e1v6A7EzPpBi930nAAAAAElFTkSuQmCC';
})();
