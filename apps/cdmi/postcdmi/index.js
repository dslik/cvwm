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
  function S(id, vars) {
    var v = R && R.text('strings', id); if (v == null) return id;
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
  // Launch options, in the spirit of curl, described in rsrc/data/options.json using the command-line-args
  // option-definition format (name, alias, type, multiple, defaultOption) -- so one file both documents the flags
  // and drives the parser below. The built-in default mirrors the resource for a classic (fork-less) install.
  var OPTIONS = [
    { name: 'request', alias: 'X', type: 'String', typeLabel: '<method>' },
    { name: 'header', alias: 'H', type: 'String', multiple: true, typeLabel: '<name: value>' },
    { name: 'data', alias: 'd', type: 'String', typeLabel: '<body>' },
    { name: 'url', type: 'String', defaultOption: true, typeLabel: '<uri>' }
  ];
  if (R) {
    var _mt = R.json('data', 'mediatypes'); if (_mt && typeof _mt === 'object') MT = _mt;
    var _me = R.json('data', 'methods'); if (Array.isArray(_me) && _me.length) METHODS = _me;
    var _tp = R.json('data', 'templates'); if (Array.isArray(_tp) && _tp.length) TEMPLATES = _tp;
    var _op = R.json('data', 'options'); if (Array.isArray(_op) && _op.length) OPTIONS = _op;
  }

  var style = document.createElement('style');
  style.textContent = R.text('styles', 'postcdmi');
  document.head.appendChild(style);

  function el(t, p, k) { var e = document.createElement(t); for (var x in (p || {})) { if (x === 'text') e.textContent = p[x]; else if (x === 'html') e.innerHTML = p[x]; else e.setAttribute(x, p[x]); } (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }

  // ---- URL row: method, URI, template menu, send
  var method = el('select', { id: 'method' }); METHODS.forEach(function (m) { method.appendChild(el('option', { value: m, text: m })); });
  var uri = el('input', { id: 'uri', type: 'text', spellcheck: 'false', placeholder: S('uriPlaceholder') });
  var tmpl = el('select', { class: 'tmpl', title: S('templateTitle') });
  TEMPLATES.forEach(function (o) { tmpl.appendChild(el('option', { value: o[1], text: o[0] })); });
  var send = el('button', { id: 'send', type: 'button', text: S('send') });
  document.body.appendChild(el('div', { id: 'url-row', class: 'row' }, [method, uri, tmpl, send]));

  // ---- request tabs: Body, Headers
  var tabBody = el('button', { class: 'tabbtn on', type: 'button', text: S('tabBody') });
  var tabHead = el('button', { class: 'tabbtn', type: 'button', text: S('tabHeaders') });
  document.body.appendChild(el('div', { id: 'tabs' }, [tabBody, tabHead]));

  var req = el('div', { id: 'req' });
  var bodyPane = el('div', { class: 'pane on' });
  var bodyIn = el('textarea', { id: 'body', spellcheck: 'false', placeholder: S('bodyPlaceholder') });
  bodyPane.appendChild(bodyIn);
  var headPane = el('div', { class: 'pane' });
  var headList = el('div', {});
  headPane.appendChild(headList);
  var addH = el('button', { class: 'addh', type: 'button', text: S('addHeader') });
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
    var ki = el('input', { class: 'k', type: 'text', placeholder: S('headerPlaceholder'), spellcheck: 'false', value: k || '' });
    var vi = el('input', { class: 'v', type: 'text', placeholder: S('valuePlaceholder'), spellcheck: 'false', value: v || '' });
    var rm = el('button', { type: 'button', title: S('remove'), text: '\u00d7' });
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
  var statusEl = el('div', { id: 'status', class: 'muted', text: S('noRequest') });
  var rTabBody = el('button', { class: 'tabbtn on', type: 'button', text: S('tabBody') });
  var rTabHead = el('button', { class: 'tabbtn', type: 'button', text: S('tabHeaders') });
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
  if (CTX.setTitle) CTX.setTitle(S('title'));

  // default URI to the desktop's base
  uri.value = (CTX.baseURI || CTX.origin || '') + '';
  var uriEdited = false;                          // set once the user types in the URI, so templates leave it alone
  uri.addEventListener('input', function () { uriEdited = true; });
  // Parse CTX.argv against OPTIONS, curl-style: -X/--request, -H/--header (repeatable), -d/--data, and a bare URI.
  // Short flags take an attached or following value (-XGET or -X GET); long flags take =value or the next token;
  // "--" ends option parsing. Unknown flags are ignored rather than fatal.
  function parseArgv(argv) {
    var byShort = {}, byLong = {}, vals = {}, positionals = [], a = (argv || []).slice();
    OPTIONS.forEach(function (o) { byLong[o.name] = o; if (o.alias) byShort[o.alias] = o; if (o.multiple) vals[o.name] = []; });
    function take(o, v) { if (o.multiple) vals[o.name].push(v); else vals[o.name] = v; }
    for (var i = 0; i < a.length; i++) {
      var arg = a[i], o = null, inline = null, m;
      if (arg === '--') { while (++i < a.length) positionals.push(a[i]); break; }
      if ((m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg))) { o = byLong[m[1]]; inline = m[2] === undefined ? null : m[2]; }
      else if (arg.length > 1 && arg.charAt(0) === '-' && arg !== '-') { o = byShort[arg.charAt(1)]; inline = arg.length > 2 ? arg.slice(2) : null; }
      else { positionals.push(arg); continue; }
      if (!o) continue;                              // unknown flag
      if (o.type === 'Boolean') take(o, true);
      else take(o, inline !== null ? inline : (i + 1 < a.length ? a[++i] : ''));
    }
    return { vals: vals, positionals: positionals };
  }
  function setMethod(mv) {
    if (![].some.call(method.options, function (o) { return o.value === mv; })) method.appendChild(el('option', { value: mv, text: mv }));
    method.value = mv;
  }
  function parseHeader(s) { var i = String(s).indexOf(':'); return i < 0 ? [String(s).trim(), ''] : [s.slice(0, i).trim(), s.slice(i + 1).replace(/^[ \t]+/, '')]; }

  (function () {                                   // pre-populate from launch arguments (curl-style) or a start URI
    var p = parseArgv(CTX.argv), vals = p.vals, pos = p.positionals;
    var meths = { GET: 1, PUT: 1, POST: 1, DELETE: 1, PATCH: 1, HEAD: 1, OPTIONS: 1 };
    // Backward compatible: a bare METHOD may lead the arguments when -X/--request was not given.
    if (vals.request == null && pos.length && meths[String(pos[0]).toUpperCase()]) vals.request = String(pos.shift()).toUpperCase();
    // curl: a body with no explicit method is a POST.
    if (vals.data != null && vals.request == null) vals.request = 'POST';
    var url = vals.url != null ? vals.url : (pos.length ? pos[0] : null);
    if (vals.request != null) setMethod(String(vals.request).toUpperCase());
    if (url != null) { uri.value = url; uriEdited = true; }
    if (vals.header && vals.header.length) setHeaders(vals.header.map(parseHeader));
    if (vals.data != null) bodyIn.value = vals.data;
    if (CTX.startURI) { uri.value = CTX.startURI; uriEdited = true; }   // a programmatic start URI still wins for the URL
    if (vals.data != null) showReqTab('body'); else if (vals.header && vals.header.length) showReqTab('head');
  })();

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
    if (!/^https:\/\//i.test(u)) { statusEl.className = ''; statusEl.textContent = S('mustBeHttps'); return; }
    var m = method.value, hdrs = currentHeaders();
    // The desktop's Authorization is added unless the request overrides it, so postcdmi reaches what the desktop can.
    var h = {}; for (var k in HEADERS) h[k] = HEADERS[k]; for (k in hdrs) h[k] = hdrs[k];
    var hasBody = m === 'PUT' || m === 'POST' || m === 'PATCH';
    var body = hasBody && bodyIn.value.length ? bodyIn.value : undefined;
    send.disabled = true; statusEl.className = 'muted'; statusEl.textContent = S('sending');
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
      rHead.textContent = hl.sort().join('\n') || S('noHeaders');
      // body: pretty-print JSON
      var ct = res.headers.get('content-type') || '';
      if (/json|cdmi-/.test(ct) && text) { try { rBody.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { rBody.textContent = text; } }
      else rBody.textContent = text || S('emptyBody');
      showRespTab('body');
    } catch (e) {
      statusEl.className = '';
      statusEl.textContent = '';
      statusEl.appendChild(el('span', { class: 'dot err', text: S('failed') }));
      statusEl.appendChild(el('span', { class: 'muted', text: (e && e.message) || S('networkErr') }));
      var hint = S('corsHint');
      if (/cdmi_namespaces\//.test(u)) hint = S('discoveryHint');
      rBody.textContent = S('didNotComplete') + '\n\n' + ((e && e.message) || '') + '\n\n' + hint;
    } finally { send.disabled = false; }
  }
  send.addEventListener('click', doSend);
  uri.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSend(); });
  bodyIn.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doSend(); });
})();
