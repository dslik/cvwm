/*!
 * postcdmi for cvwm: a request workbench for a CDMI server, in the spirit of Postman. Compose a request -- method,
 * URI, headers, body -- send it with the desktop's credentials, and read the status, headers and body back. It
 * knows CDMI: the media types are on a menu, common requests fill in from templates, and a JSON response is
 * pretty-printed. It uses the desktop's Authorization header and same-origin credentials, so it reaches whatever
 * the signed-in desktop can.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var HEADERS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string with optional {token} substitution; the stylesheet, the method list, the
  // media-type map and the request templates are pulled from the fork where present.
  var R = CTX.rsrc || null;
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }

  var MT = {
    container: 'application/cdmi-container', object: 'application/cdmi-object', queue: 'application/cdmi-queue',
    capability: 'application/cdmi-capability', domain: 'application/cdmi-domain', json: 'application/json'
  };
  var METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
  var TEMPLATES = [['Template…', ''], ['Read a container', 'get-container'], ['Read an object', 'get-object'],
    ['List children (extended)', 'list'], ['Create a container', 'put-container'], ['Create a text object', 'put-object'],
    ['Set an ACL', 'put-acl'], ['Delete', 'delete'], ['Server capabilities', 'caps'], ['Namespaces (well-known)', 'nswk']];
  if (R) {
    var _mt = R.json('data', 'mediatypes'); if (_mt && typeof _mt === 'object') MT = _mt;
    var _me = R.json('data', 'methods'); if (Array.isArray(_me) && _me.length) METHODS = _me;
    var _tp = R.json('data', 'templates'); if (Array.isArray(_tp) && _tp.length) TEMPLATES = _tp;
  }

  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code:#eff1f3;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--warn:#9a6700;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code:#151b23;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--warn:#d29922;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    'body{display:flex;flex-direction:column;}' +
    '.row{display:flex;gap:6px;align-items:center;padding:6px 8px;}' +
    '#url-row{border-bottom:1px solid var(--border);}' +
    'select,input,button,textarea{font:13px inherit;color:var(--fg);background:var(--bg);border:1px solid var(--border);border-radius:6px;}' +
    'select,#send,.tabbtn{height:30px;}' +
    '#method{width:96px;font-family:var(--mono);font-weight:600;}' +
    '#uri{flex:1;min-width:0;font:12px var(--mono);padding:0 8px;height:30px;}' +
    '#send{padding:0 16px;background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600;cursor:pointer;}' +
    '#send:disabled{opacity:.6;cursor:default;}' +
    '.tmpl{height:30px;}' +
    '#tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--border);}' +
    '.tabbtn{padding:0 12px;background:var(--panel);border:1px solid var(--border);border-bottom:0;border-radius:6px 6px 0 0;cursor:pointer;color:var(--muted);}' +
    '.tabbtn.on{background:var(--bg);color:var(--fg);font-weight:600;}' +
    '.pane{display:none;flex:1;min-height:0;overflow:auto;padding:8px;}' +
    '.pane.on{display:block;}' +
    '#req{flex:0 0 auto;height:200px;min-height:120px;max-height:45%;display:flex;flex-direction:column;overflow:hidden;}' +
    '#body{width:100%;box-sizing:border-box;flex:1;min-height:0;height:auto;resize:none;font:12px var(--mono);padding:8px;background:var(--code);}' +
    '.hdr{display:flex;gap:6px;margin:0 0 4px;}' +
    '.hdr input{flex:1;min-width:0;font:12px var(--mono);padding:4px 6px;}' +
    '.hdr .k{flex:0 0 40%;}' +
    '.hdr button{width:28px;height:28px;cursor:pointer;}' +
    '.addh{margin-top:4px;height:26px;padding:0 10px;cursor:pointer;background:var(--panel);}' +
    '#resp{flex:1;min-height:0;display:flex;flex-direction:column;border-top:2px solid var(--border);}' +
    '#status{padding:6px 10px;font:13px var(--mono);border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;}' +
    '.dot{font-weight:700;}.dot.ok{color:var(--ok);}.dot.err{color:var(--err);}.dot.warn{color:var(--warn);}' +
    '#rtabs{display:flex;gap:2px;padding:4px 8px 0;}' +
    '#rbody{flex:1;min-height:0;overflow:auto;padding:8px;margin:0;font:12px var(--mono);white-space:pre-wrap;word-break:break-word;}' +
    '#rhead{flex:1;min-height:0;overflow:auto;padding:8px;margin:0;font:12px var(--mono);white-space:pre-wrap;display:none;}' +
    '.muted{color:var(--muted);}';
  style.textContent = (R && R.text('styles', 'postcdmi')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(t, p, k) { var e = document.createElement(t); for (var x in (p || {})) { if (x === 'text') e.textContent = p[x]; else if (x === 'html') e.innerHTML = p[x]; else e.setAttribute(x, p[x]); } (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }

  // ---- URL row: method, URI, template menu, send
  var method = el('select', { id: 'method' }); METHODS.forEach(function (m) { method.appendChild(el('option', { value: m, text: m })); });
  var uri = el('input', { id: 'uri', type: 'text', spellcheck: 'false', placeholder: S('uriPlaceholder', 'https://host:port/cdmi/3.0.0/path') });
  var tmpl = el('select', { class: 'tmpl', title: S('templateTitle', 'Fill in a common CDMI request') });
  TEMPLATES.forEach(function (o) { tmpl.appendChild(el('option', { value: o[1], text: o[0] })); });
  var send = el('button', { id: 'send', type: 'button', text: S('send', 'Send') });
  document.body.appendChild(el('div', { id: 'url-row', class: 'row' }, [method, uri, tmpl, send]));

  // ---- request tabs: Body, Headers
  var tabBody = el('button', { class: 'tabbtn on', type: 'button', text: S('tabBody', 'Body') });
  var tabHead = el('button', { class: 'tabbtn', type: 'button', text: S('tabHeaders', 'Headers') });
  document.body.appendChild(el('div', { id: 'tabs' }, [tabBody, tabHead]));

  var req = el('div', { id: 'req' });
  var bodyPane = el('div', { class: 'pane on' });
  var bodyIn = el('textarea', { id: 'body', spellcheck: 'false', placeholder: S('bodyPlaceholder', 'Request body (JSON for a CDMI representation)') });
  bodyPane.appendChild(bodyIn);
  var headPane = el('div', { class: 'pane' });
  var headList = el('div', {});
  headPane.appendChild(headList);
  var addH = el('button', { class: 'addh', type: 'button', text: S('addHeader', '+ header') });
  headPane.appendChild(addH);
  req.appendChild(bodyPane); req.appendChild(headPane);
  document.body.appendChild(req);

  function showReqTab(which) {
    tabBody.classList.toggle('on', which === 'body'); tabHead.classList.toggle('on', which === 'head');
    bodyPane.classList.toggle('on', which === 'body'); headPane.classList.toggle('on', which === 'head');
  }
  tabBody.addEventListener('click', function () { showReqTab('body'); });
  tabHead.addEventListener('click', function () { showReqTab('head'); });

  function headerRow(k, v) {
    var ki = el('input', { class: 'k', type: 'text', placeholder: S('headerPlaceholder', 'Header'), spellcheck: 'false', value: k || '' });
    var vi = el('input', { class: 'v', type: 'text', placeholder: S('valuePlaceholder', 'Value'), spellcheck: 'false', value: v || '' });
    var rm = el('button', { type: 'button', title: S('remove', 'Remove'), text: '\u00d7' });
    var row = el('div', { class: 'hdr' }, [ki, vi, rm]);
    rm.addEventListener('click', function () { row.remove(); });
    // keep an empty trailing row so there's always somewhere to type
    function maybeGrow() { if (row === headList.lastChild && (ki.value || vi.value)) headList.appendChild(headerRow('', '')); }
    ki.addEventListener('input', maybeGrow); vi.addEventListener('input', maybeGrow);
    return row;
  }
  function setHeaders(pairs) { headList.textContent = ''; (pairs || []).forEach(function (p) { headList.appendChild(headerRow(p[0], p[1])); }); headList.appendChild(headerRow('', '')); }
  addH.addEventListener('click', function () { headList.insertBefore(headerRow('', ''), headList.lastChild); });
  function currentHeaders() {
    var out = {};
    [].slice.call(headList.querySelectorAll('.hdr')).forEach(function (r) { var k = r.querySelector('.k').value.trim(); var v = r.querySelector('.v').value; if (k) out[k] = v; });
    return out;
  }
  setHeaders([['Accept', MT.container], ['Content-Type', MT.container]]);

  // ---- response
  var resp = el('div', { id: 'resp' });
  var statusEl = el('div', { id: 'status', class: 'muted', text: S('noRequest', 'No request sent yet.') });
  var rTabBody = el('button', { class: 'tabbtn on', type: 'button', text: S('tabBody', 'Body') });
  var rTabHead = el('button', { class: 'tabbtn', type: 'button', text: S('tabHeaders', 'Headers') });
  var rBody = el('pre', { id: 'rbody' });
  var rHead = el('pre', { id: 'rhead' });
  resp.appendChild(statusEl); resp.appendChild(el('div', { id: 'rtabs' }, [rTabBody, rTabHead])); resp.appendChild(rBody); resp.appendChild(rHead);
  document.body.appendChild(resp);
  function showRespTab(which) {
    rTabBody.classList.toggle('on', which === 'body'); rTabHead.classList.toggle('on', which === 'head');
    rBody.style.display = which === 'body' ? '' : 'none'; rHead.style.display = which === 'head' ? '' : 'none';
  }
  rTabBody.addEventListener('click', function () { showRespTab('body'); });
  rTabHead.addEventListener('click', function () { showRespTab('head'); });

  if (CTX.resize) CTX.resize(760, 620);
  if (CTX.setTitle) CTX.setTitle(S('title', 'postcdmi'));

  // default URI to the desktop's base
  uri.value = (CTX.baseURI || CTX.origin || '') + '';
  var uriEdited = false;                          // set once the user types in the URI, so templates leave it alone
  uri.addEventListener('input', function () { uriEdited = true; });

  // ---- templates
  function serverOrigin() { try { return new URL(uri.value || CTX.baseURI || CTX.origin).origin; } catch (e) { return CTX.origin || ''; } }
  function base() { return (CTX.baseURI || (serverOrigin() + '/cdmi/3.0.0/')); }
  tmpl.addEventListener('change', function () {
    var t = tmpl.value; tmpl.value = ''; if (!t) return;
    var b = base();
    // Templates set the request's shape (method, headers, body). They fill the URI only where the user has not
    // typed one, so choosing a template does not discard a URI you entered. setURI() honours that.
    function setURI(v) { if (!uriEdited) uri.value = v; }
    if (t === 'get-container') { method.value = 'GET'; setURI(b); setHeaders([['Accept', MT.container]]); bodyIn.value = ''; }
    else if (t === 'get-object') { method.value = 'GET'; setURI(b + 'file.txt'); setHeaders([['Accept', MT.object]]); bodyIn.value = ''; }
    else if (t === 'list') { method.value = 'GET'; setURI(b + '?childfields=objectType;objectName'); setHeaders([['Accept', MT.container]]); bodyIn.value = ''; }
    else if (t === 'put-container') { method.value = 'PUT'; setURI(b + 'newdir/'); setHeaders([['Accept', MT.container], ['Content-Type', MT.container]]); bodyIn.value = JSON.stringify({ metadata: {} }, null, 2); }
    else if (t === 'put-object') { method.value = 'PUT'; setURI(b + 'hello.txt'); setHeaders([['Accept', MT.object], ['Content-Type', MT.object]]); bodyIn.value = JSON.stringify({ mimetype: 'text/plain', valuetransferencoding: 'utf-8', value: 'hello\n' }, null, 2); }
    else if (t === 'put-acl') { method.value = 'PATCH'; setURI(b); setHeaders([['Content-Type', MT.container]]); bodyIn.value = JSON.stringify({ metadata: { cdmi_acl: [{ identifier: 'EVERYONE@', acetype: 'ALLOW', aceflags: 'NO_FLAGS', acemask: 'READ' }] } }, null, 2); }
    else if (t === 'delete') { method.value = 'DELETE'; setHeaders([]); bodyIn.value = ''; }
    else if (t === 'caps') { method.value = 'GET'; setURI(serverOrigin() + '/.well-known/cdmi/cdmi_capabilities/'); setHeaders([['Accept', MT.capability]]); bodyIn.value = ''; }
    else if (t === 'nswk') { method.value = 'GET'; setURI(serverOrigin() + '/.well-known/cdmi/cdmi_namespaces/'); setHeaders([['Accept', MT.container]]); bodyIn.value = ''; }
    showReqTab(bodyIn.value ? 'body' : 'head');
  });

  // ---- send
  async function doSend() {
    var u = uri.value.trim();
    if (!/^https:\/\//i.test(u)) { statusEl.className = ''; statusEl.textContent = S('mustBeHttps', 'The URI must be an https: URL.'); return; }
    var m = method.value, hdrs = currentHeaders();
    // The desktop's Authorization is added unless the request overrides it, so postcdmi reaches what the desktop can.
    var h = {}; for (var k in HEADERS) h[k] = HEADERS[k]; for (k in hdrs) h[k] = hdrs[k];
    var hasBody = m === 'PUT' || m === 'POST' || m === 'PATCH';
    var body = hasBody && bodyIn.value.length ? bodyIn.value : undefined;
    send.disabled = true; statusEl.className = 'muted'; statusEl.textContent = S('sending', 'Sending \u2026');
    var t0 = Date.now();
    try {
      var res = await fetch(u, { method: m, headers: h, body: body, redirect: 'follow', credentials: 'same-origin', cache: 'no-store' });
      var ms = Date.now() - t0;
      var text = await res.text();
      var cls = res.status < 300 ? 'ok' : res.status < 400 ? 'warn' : 'err';
      statusEl.className = '';
      statusEl.textContent = '';
      statusEl.appendChild(el('span', { class: 'dot ' + cls, text: res.status + ' ' + res.statusText }));
      statusEl.appendChild(el('span', { class: 'muted', text: ms + ' ms  \u00b7  ' + text.length + ' bytes' + (res.redirected ? '  \u00b7  redirected to ' + res.url : '') }));
      // headers
      var hl = []; res.headers.forEach(function (v, k) { hl.push(k + ': ' + v); });
      rHead.textContent = hl.sort().join('\n') || S('noHeaders', '(no headers)');
      // body: pretty-print JSON
      var ct = res.headers.get('content-type') || '';
      if (/json|cdmi-/.test(ct) && text) { try { rBody.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { rBody.textContent = text; } }
      else rBody.textContent = text || S('emptyBody', '(empty body)');
      showRespTab('body');
    } catch (e) {
      statusEl.className = '';
      statusEl.textContent = '';
      statusEl.appendChild(el('span', { class: 'dot err', text: S('failed', 'Failed') }));
      statusEl.appendChild(el('span', { class: 'muted', text: (e && e.message) || S('networkErr', 'the request could not be sent (network, CORS, or TLS)') }));
      var hint = S('corsHint', 'A cross-origin server must allow this origin (CORS); an http: URL from this https: page is blocked as mixed content.');
      if (/cdmi_namespaces\//.test(u)) hint = S('discoveryHint', 'This looks like a discovery reference, which answers a 307 redirect to a base URI. The browser could not follow it (often the base is at another origin, or the redirect target refused this origin). Use the Namespaces window to mount it, or GET the base URI directly.');
      rBody.textContent = S('didNotComplete', 'The request did not complete.') + '\n\n' + ((e && e.message) || '') + '\n\n' + hint;
    } finally { send.disabled = false; }
  }
  send.addEventListener('click', doSend);
  uri.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSend(); });
  bodyIn.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doSend(); });
})();
