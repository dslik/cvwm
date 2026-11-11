/*!
 * mcpinspector for cvwm: a native MCP client for a CDMI server's "CDMI over MCP" endpoint. It replaces the app that
 * framed an external Inspector: it speaks the protocol itself, so no separate Node proxy, no cross-origin framing.
 *
 * Give it the MCP endpoint URI and a bearer token; it performs the initialize handshake and, for each capability the
 * server advertises, lists what it offers: tools (tools/list, tools/call), prompts (prompts/list, prompts/get) and
 * resources (resources/list, resources/templates/list, resources/read). A left-hand tab selects the kind; the panel
 * builds a form from the selected item and shows the result. It talks the Streamable HTTP transport seedmi serves: a
 * POST carrying the JSON-RPC message, Accept naming both application/json and text/event-stream, the
 * MCP-Protocol-Version header, and it reads a reply framed either way.
 *
 * A token can be pasted, or the app can mint one from the authorization server: with a client id and secret
 * (client_credentials), or in the signed-in person's name by the authorization code flow with PKCE, as a public client
 * holding no secret — carried in a hidden frame with the credential the desktop already holds, so that nothing is
 * typed and no window is opened. Token
 * minting reaches the authorization server, which is cross-origin to the desktop, so it works where that server sends
 * CORS headers; otherwise the app says so and the token is pasted instead (the setup prints a curl to mint one).
 *
 * Prompts and resources are not defined by the CDMI-over-MCP subclause today (seedmi advertises tools only); the tabs
 * appear when a server advertises those capabilities, so the app is ready for a server that adds them (see the seedmi
 * recommendations doc). An argument whose input schema declares an "enum" is offered as a pick-list, the same way a
 * boolean is; for the CDMI "representation" and "mode" arguments, which are closed sets the schema does not yet name,
 * the app offers a built-in editable pick-list until the server declares the enum itself.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string; the stylesheet and the fallback-enum table are pulled where present.
  var R = CTX.rsrc || null;
  function S(id, vars) {
    var v = R && R.text('strings', id); if (v == null) return id;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var PROTOCOL = '2026-07-28';

  // CDMI closed-set arguments the input schema does not yet declare as enums. Offered as an editable pick-list from
  // the resource table; once a server declares the enum, that authoritative list is used as a strict select instead.
  var FALLBACK_ENUMS = (R && R.json('data', 'enums')) || {};

  var style = document.createElement('style');
  style.textContent = R.text('styles', 'mcpinspector');
  document.head.appendChild(style);

  function el(t, p, k) { var e = document.createElement(t); for (var x in (p || {})) { if (x === 'text') e.textContent = p[x]; else if (x === 'html') e.innerHTML = p[x]; else e.setAttribute(x, p[x]); } (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }

  var endpoint = el('input', { type: 'text', id: 'ep', class: 'ep', spellcheck: 'false', placeholder: S('endpointPlaceholder') });
  var token = el('input', { type: 'password', id: 'tok', class: 'tok', spellcheck: 'false', placeholder: S('tokenPlaceholder') });
  var connect = el('button', { class: 'go', type: 'button', text: S('connect') });
  var clientId = el('input', { type: 'text', id: 'cid', spellcheck: 'false', placeholder: S('clientIdPlaceholder') });
  var clientSecret = el('input', { type: 'password', id: 'csec', spellcheck: 'false', placeholder: S('clientSecretPlaceholder') });
  var getBtn = el('button', { class: 'mint', type: 'button', text: S('getToken') });
  var userBtn = el('button', { class: 'mint', type: 'button', text: S('useUser') });
  var top = el('div', { id: 'top' }, [endpoint, token, connect]);
  var crow = el('div', { id: 'crow' }, [
    el('label', { for: 'cid', text: S('client') }), clientId, clientSecret, getBtn, userBtn
  ]);
  var status = el('div', { id: 'status', text: S('notConnected') });
  var tabsEl = el('div', { id: 'tabs' });
  var listEl = el('div', { id: 'list' }, [el('div', { class: 'msg', text: S('listConnect') })]);
  var leftEl = el('div', { id: 'left' }, [tabsEl, listEl]);
  var panel = el('div', { id: 'panel' }, [el('div', { class: 'msg', text: S('panelConnect') })]);
  var split = el('div', { id: 'split' }, [leftEl, panel]);
  // top row and token controls above; the split fills; the status line sits at the bottom.
  document.body.appendChild(top); document.body.appendChild(crow); document.body.appendChild(split); document.body.appendChild(status);
  if (CTX.resize) CTX.resize(900, 640);
  if (CTX.setTitle) CTX.setTitle(S('title'));

  // Prefill: launch arguments (endpoint [token]) or a start URI win; else the advertised cdmi_mcp_uri, else an 8100 guess.
  (function () {
    var a = CTX.argv || [];
    if (a.length && a[0]) { endpoint.value = a[0]; if (a[1]) token.value = a[1]; return; }
    if (CTX.startURI) { endpoint.value = CTX.startURI; return; }
    var adv = (D.mcpEndpoint && D.mcpEndpoint()) || CTX.mcpUri;
    if (adv) { endpoint.value = adv; return; }
    try { var o = new URL(CTX.baseURI || CTX.origin); endpoint.value = o.protocol + '//' + o.hostname + ':8100/mcp'; } catch (e) {}
  })();

  var rpcId = 0, uid = 0;
  function setStatus(text, cls) { status.textContent = ''; status.appendChild(el('span', { class: cls || '', text: text })); }

  // One JSON-RPC call over the Streamable HTTP transport. Reads a reply framed as application/json or as a single
  // text/event-stream event, and returns the parsed JSON-RPC message (throws on a transport or JSON-RPC error).
  async function rpc(method, params) {
    var body = { jsonrpc: '2.0', id: ++rpcId, method: method };
    if (params !== undefined) body.params = params;
    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL
    };
    if (token.value.trim()) headers['Authorization'] = 'Bearer ' + token.value.trim();
    var res;
    try {
      res = await fetch(endpoint.value.trim(), { method: 'POST', headers: headers, body: JSON.stringify(body), cache: 'no-store' });
    } catch (netErr) {
      var here = ''; try { here = new URL(CTX.baseURI || CTX.origin || location.href).origin; } catch (e) {}
      var there = ''; try { there = new URL(endpoint.value.trim()).origin; } catch (e) {}
      var cross = here && there && here !== there;
      throw new Error('Could not reach the endpoint (' + (netErr && netErr.message || 'fetch failed') + ').' +
        (cross ? ' It is a different origin (' + there + ') from this desktop (' + here + '). The setup enables cross-origin (CORS) requests to the MCP endpoint, so the usual cause is an untrusted TLS certificate: a self-signed certificate is accepted per origin, and ' + there + ' is a different port from the desktop, so accepting it for the desktop did not cover it. Open ' + there + '/ in this browser, accept the certificate, then Connect again. (If the server was not built with CORS, reach it from a same-origin page or paste a token instead.)' :
          ' Check the URL and that the server is running and its certificate is trusted by this browser.'));
    }
    var text = await res.text();
    if (res.status === 401) throw new Error('401 unauthenticated — the token was refused or is missing (' + (res.headers.get('WWW-Authenticate') || 'no challenge') + ')');
    if (!res.ok && !text) throw new Error('HTTP ' + res.status + ' ' + res.statusText + (res.status === 403 ? ' (origin not permitted, or forbidden)' : ''));
    var msg = parseReply(text, res.headers.get('content-type') || '');
    if (!msg) throw new Error('HTTP ' + res.status + ': the response was not a JSON-RPC message');
    if (msg.error) { var e = new Error(msg.error.message || ('JSON-RPC error ' + msg.error.code)); e.data = msg.error.data; e.code = msg.error.code; throw e; }
    return msg.result;
  }

  // Parse a reply that is either a JSON object or an SSE stream carrying one (event: message / data: {...}).
  function parseReply(text, contentType) {
    text = text || '';
    if (/text\/event-stream/i.test(contentType) || /^\s*event:|^\s*data:/m.test(text)) {
      var data = '';
      text.split(/\r?\n/).forEach(function (line) { var m = /^data:\s?(.*)$/.exec(line); if (m) data += m[1]; });
      if (!data) return null;
      try { return JSON.parse(data); } catch (e) { return null; }
    }
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // ---- connection and the capability tabs --------------------------------------------------------------------------

  var caps = {};
  var lists = { tools: [], prompts: [], resources: [], templates: [] };
  var activeKind = 'tools';
  var selected = null;

  // The kinds a tab is shown for: tools whenever the server offers any, prompts/resources only where advertised.
  var KINDS = [
    { key: 'tools', label: S('tabTools') },
    { key: 'prompts', label: S('tabPrompts') },
    { key: 'resources', label: S('tabResources') }
  ];

  async function doConnect() {
    if (!/^https?:\/\//i.test(endpoint.value.trim())) { setStatus(S('httpUrl'), 'err'); return; }
    connect.disabled = true; setStatus(S('initializing'));
    tabsEl.textContent = ''; listEl.textContent = ''; panel.textContent = '';
    lists = { tools: [], prompts: [], resources: [], templates: [] }; selected = null;
    try {
      var init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cvwm-mcpinspector', version: '1' } });
      var sv = (init && init.serverInfo) || {};
      caps = (init && init.capabilities) || {};
      setStatus(S('connectedPrefix') + (sv.name || 'server') + ' ' + (sv.version || '') + ', protocol ' + (init.protocolVersion || '?') + capsSummary(caps), 'ok');

      // Tools: attempt the list whenever the server advertises the capability, and also unconditionally, since the
      // CDMI-over-MCP binding offers tools without always spelling the capability out. Prompts and resources are called
      // only where advertised: calling an unimplemented method returns a JSON-RPC error, not an empty list.
      try { var lt = await rpc('tools/list', {}); lists.tools = (lt && lt.tools) || []; } catch (e) { if (caps.tools) throw e; }
      if (caps.prompts) { try { var lp = await rpc('prompts/list', {}); lists.prompts = (lp && lp.prompts) || []; } catch (e) { lists.prompts = []; } }
      if (caps.resources) {
        try { var lr = await rpc('resources/list', {}); lists.resources = (lr && lr.resources) || []; } catch (e) { lists.resources = []; }
        try { var lrt = await rpc('resources/templates/list', {}); lists.templates = (lrt && lrt.resourceTemplates) || []; } catch (e) { lists.templates = []; }
      }
      renderTabs();
      var firstKind = availableKinds()[0] || 'tools';
      selectKind(firstKind);
    } catch (e) {
      setStatus('' + (e.message || e), 'err');
      listEl.appendChild(el('div', { class: 'msg', text: S('couldNotConnect') }));
      showError(e);
    } finally { connect.disabled = false; }
  }

  function capsSummary(c) {
    var on = [];
    if (c.tools) on.push('tools'); if (c.prompts) on.push('prompts'); if (c.resources) on.push('resources');
    return on.length ? ' — offers ' + on.join(', ') : '';
  }

  // A kind is available where the server advertised it, or (for tools) where the list is non-empty.
  function availableKinds() {
    var out = [];
    if (caps.tools || lists.tools.length) out.push('tools');
    if (caps.prompts) out.push('prompts');
    if (caps.resources) out.push('resources');
    if (!out.length) out.push('tools');
    return out;
  }

  function renderTabs() {
    tabsEl.textContent = '';
    var avail = availableKinds();
    KINDS.forEach(function (k) {
      if (avail.indexOf(k.key) < 0) return;
      var n = k.key === 'resources' ? (lists.resources.length + lists.templates.length) : lists[k.key].length;
      var b = el('button', { type: 'button', text: k.label + (n ? ' (' + n + ')' : '') });
      b.addEventListener('click', function () { selectKind(k.key); });
      b._kind = k.key;
      tabsEl.appendChild(b);
    });
  }

  function selectKind(kind) {
    activeKind = kind; selected = null;
    [].forEach.call(tabsEl.children, function (b) { b.classList.toggle('on', b._kind === kind); });
    // Set the placeholder first, so renderList's auto-selection (cdmi_read on the tools tab) overwrites it rather than
    // being wiped by it.
    panel.textContent = '';
    panel.appendChild(el('div', { class: 'msg', text: 'Select ' + (kind === 'tools' ? 'a tool to call it.' : kind === 'prompts' ? 'a prompt to fill it in.' : 'a resource to read it.') }));
    renderList();
  }

  // The rows of the active kind. Tools/prompts/resources/templates share the row shape; templates are shown within the
  // Resources tab, after the concrete resources, marked as templates.
  function renderList() {
    listEl.textContent = '';
    var rows = [];
    if (activeKind === 'tools') rows = lists.tools.map(function (t) { return { item: t, kind: 'tools', name: t.name, desc: t.description, ro: t.annotations && t.annotations.readOnlyHint }; });
    else if (activeKind === 'prompts') rows = lists.prompts.map(function (p) { return { item: p, kind: 'prompts', name: p.title || p.name, desc: p.description }; });
    else if (activeKind === 'resources') {
      rows = lists.resources.map(function (r) { return { item: r, kind: 'resources', name: r.name || r.uri, desc: r.description || r.uri }; })
        .concat(lists.templates.map(function (r) { return { item: r, kind: 'templates', name: (r.name || r.uriTemplate) + '  (template)', desc: r.description || r.uriTemplate }; }));
    }
    if (!rows.length) { listEl.appendChild(el('div', { class: 'msg', text: 'The server offers no ' + activeKind + '.' })); return; }
    rows.forEach(function (row) {
      var node = el('div', { class: 'tool' }, [
        el('div', { class: 'nm' }, [row.name, row.ro ? el('span', { class: 'ro', text: '  read-only' }) : null]),
        el('div', { class: 'ds', text: row.desc || '' })
      ]);
      node.addEventListener('click', function () {
        [].forEach.call(listEl.children, function (c) { c.classList.remove('sel'); });
        node.classList.add('sel'); selected = row.item; renderPanel(row.kind, row.item);
      });
      listEl.appendChild(node);
    });
    // A quick win: open cdmi_read by default on the tools tab.
    if (activeKind === 'tools') {
      var idx = lists.tools.findIndex(function (t) { return t.name === 'cdmi_read'; });
      if (idx < 0 && lists.tools.length) idx = 0;
      if (idx >= 0 && listEl.children[idx]) listEl.children[idx].click();
    }
  }

  function renderPanel(kind, item) {
    if (kind === 'tools') return renderToolPanel(item);
    if (kind === 'prompts') return renderPromptPanel(item);
    return renderResourcePanel(item, kind === 'templates');
  }

  // ---- a form field from a JSON-schema property --------------------------------------------------------------------
  // Returns { input, read }, where read() yields the value to send (undefined to omit). An enum declared by the schema
  // is a strict pick-list (a <select>); representation/mode with no schema enum get an editable pick-list (a datalist),
  // a client fallback until the server declares the enum. Objects are JSON textareas, booleans a tri-state select.
  function makeField(name, spec) {
    spec = spec || {};
    var type = spec.type || 'string';
    var enumVals = Array.isArray(spec.enum) && spec.enum.length ? spec.enum : null;
    if (enumVals) {
      var sel = el('select', {}, [el('option', { value: '', text: S('unset') })].concat(enumVals.map(function (v) { return el('option', { value: String(v), text: String(v) }); })));
      return { input: sel, read: function () { return sel.value === '' ? undefined : sel.value; } };
    }
    if (type === 'boolean') {
      var b = el('select', {}, [el('option', { value: '', text: S('unset') }), el('option', { value: 'true', text: 'true' }), el('option', { value: 'false', text: 'false' })]);
      return { input: b, read: function () { return b.value === '' ? undefined : b.value === 'true'; } };
    }
    if (type === 'object') {
      var ta = el('textarea', { spellcheck: 'false', placeholder: '{ ... } JSON' });
      return { input: ta, read: function () { var v = ta.value.trim(); if (!v) return undefined; return JSON.parse(v); /* may throw: caught by caller */ }, isJson: true };
    }
    if (FALLBACK_ENUMS[name]) {
      // Editable pick-list: a text input backed by a <datalist> of the known values, so a value outside the list still
      // works. This is what makes "representation" a pick-list before the server declares its enum.
      var listId = 'dl' + (++uid);
      var dl = el('datalist', { id: listId }, FALLBACK_ENUMS[name].map(function (v) { return el('option', { value: v }); }));
      var inp = el('input', { type: 'text', list: listId, spellcheck: 'false', placeholder: 'one of: ' + FALLBACK_ENUMS[name].join(', ') });
      return { input: inp, read: function () { var v = inp.value.trim(); return v === '' ? undefined : v; }, extra: dl };
    }
    var t = el('input', { type: 'text', spellcheck: 'false' });
    return { input: t, read: function () { var v = t.value.trim(); return v === '' ? undefined : v; } };
  }

  function fieldRow(name, spec, required) {
    var f = makeField(name, spec);
    var lab = el('label', {}, [name, required ? el('span', { class: 'req', text: ' *' }) : null,
      spec && spec.description ? el('span', { class: 'hint', text: '  ' + spec.description }) : null]);
    var kids = [lab, f.input]; if (f.extra) kids.push(f.extra);
    return { field: el('div', { class: 'field' }, kids), f: f };
  }

  // ---- tools -------------------------------------------------------------------------------------------------------

  function renderToolPanel(t) {
    panel.textContent = '';
    panel.appendChild(el('h2', { text: t.name }));
    panel.appendChild(el('p', { class: 'desc', text: t.description || '' }));
    var schema = t.inputSchema || { properties: {}, required: [] };
    var props = schema.properties || {}, required = schema.required || [];
    var fields = {};
    Object.keys(props).forEach(function (name) {
      var r = fieldRow(name, props[name], required.indexOf(name) >= 0);
      fields[name] = r.f; panel.appendChild(r.field);
    });
    // sensible defaults for a CDMI call
    if (fields.uri && fields.uri.input.tagName === 'INPUT' && !fields.uri.input.value) fields.uri.input.value = '/';
    if (fields.baseUri && !fields.baseUri.input.value) { var ns = (D.mounted && D.mounted()[0]); if (ns) fields.baseUri.input.value = ns.base; }

    var callBtn = el('button', { id: 'call', type: 'button', text: S('call') + t.name });
    var result = el('div', { id: 'result' });
    panel.appendChild(callBtn); panel.appendChild(result);
    callBtn.addEventListener('click', function () { doCall(t, fields, result, callBtn); });
  }

  async function doCall(t, fields, result, callBtn) {
    var args = {}, bad = null;
    Object.keys(fields).forEach(function (name) {
      if (bad) return;
      try { var v = fields[name].read(); if (v !== undefined) args[name] = v; }
      catch (e) { bad = name + ': ' + (fields[name].f && fields[name].f.isJson ? 'not valid JSON' : (e.message || e)); }
    });
    if (bad) { result.textContent = ''; result.appendChild(el('div', { class: 'rt err', text: bad })); return; }
    callBtn.disabled = true; result.textContent = ''; result.appendChild(el('div', { class: 'rt', text: S('calling') }));
    try {
      var r = await rpc('tools/call', { name: t.name, arguments: args });
      result.textContent = '';
      var rt = r && r.resultType;
      result.appendChild(el('div', { class: 'rt ' + (rt === 'complete' ? 'ok' : ''), text: 'resultType: ' + (rt || '(none)') + (r && r.isError ? '  (isError)' : '') }));
      // A tool result carries a text content block (the human-readable account) and, on this server, structuredContent
      // (the CDMI representation). Show each when present, rather than only one: seedmi returns both on every call.
      var txt = r && contentText(r.content);
      var hasStructured = r && r.structuredContent !== undefined;
      if (txt) {
        result.appendChild(el('div', { class: 'lbl', text: 'content (text)' }));
        result.appendChild(el('pre', { text: typeof txt === 'string' ? txt : JSON.stringify(txt, null, 2) }));
      }
      if (hasStructured) {
        result.appendChild(el('div', { class: 'lbl', text: 'structuredContent' }));
        result.appendChild(el('pre', { text: JSON.stringify(r.structuredContent, null, 2) }));
      }
      if (!txt && !hasStructured) {
        result.appendChild(el('pre', { text: JSON.stringify(r, null, 2) }));
      }
    } catch (e) {
      result.textContent = '';
      result.appendChild(el('div', { class: 'rt err', text: S('error') + (e.code ? ' ' + e.code : '') + ': ' + (e.message || e) }));
      if (e.data) result.appendChild(el('pre', { text: JSON.stringify(e.data, null, 2) }));
    } finally { callBtn.disabled = false; }
  }

  // ---- prompts -----------------------------------------------------------------------------------------------------

  function renderPromptPanel(p) {
    panel.textContent = '';
    panel.appendChild(el('h2', { text: p.title || p.name }));
    panel.appendChild(el('p', { class: 'desc', text: p.description || '' }));
    var argDefs = p.arguments || [];
    var fields = {};
    argDefs.forEach(function (a) {
      var r = fieldRow(a.name, { type: 'string', description: a.description }, !!a.required);
      fields[a.name] = r.f; panel.appendChild(r.field);
    });
    if (!argDefs.length) panel.appendChild(el('p', { class: 'desc', text: S('noArgs') }));
    var btn = el('button', { id: 'call', type: 'button', text: 'Get prompt' });
    var result = el('div', { id: 'result' });
    panel.appendChild(btn); panel.appendChild(result);
    btn.addEventListener('click', async function () {
      var args = {};
      Object.keys(fields).forEach(function (n) { var v = fields[n].read(); if (v !== undefined) args[n] = v; });
      btn.disabled = true; result.textContent = ''; result.appendChild(el('div', { class: 'rt', text: 'Getting …' }));
      try {
        var r = await rpc('prompts/get', { name: p.name, arguments: args });
        result.textContent = '';
        if (r && r.description) { result.appendChild(el('div', { class: 'lbl', text: 'description' })); result.appendChild(el('pre', { text: r.description })); }
        var messages = (r && r.messages) || [];
        result.appendChild(el('div', { class: 'lbl', text: 'messages (' + messages.length + ')' }));
        messages.forEach(function (m) {
          result.appendChild(el('div', { class: 'role', text: m.role || 'message' }));
          contentBlocks(m.content).forEach(function (c) { renderContentBlock(result, c); });
        });
      } catch (e) {
        result.textContent = '';
        result.appendChild(el('div', { class: 'rt err', text: S('error') + (e.code ? ' ' + e.code : '') + ': ' + (e.message || e) }));
        if (e.data) result.appendChild(el('pre', { text: JSON.stringify(e.data, null, 2) }));
      } finally { btn.disabled = false; }
    });
  }

  // ---- resources ---------------------------------------------------------------------------------------------------

  function renderResourcePanel(r, isTemplate) {
    panel.textContent = '';
    panel.appendChild(el('h2', { text: r.name || r.uri || r.uriTemplate }));
    if (r.description) panel.appendChild(el('p', { class: 'desc', text: r.description }));
    if (r.mimeType) panel.appendChild(el('p', { class: 'desc', text: 'mimeType: ' + r.mimeType }));
    var uriInput;
    if (isTemplate) {
      // A URI template (RFC 6570): show it, editable, so the caller expands its {vars} and reads the result.
      var r0 = fieldRow('uri', { type: 'string', description: 'The template: ' + r.uriTemplate + ' — replace the {variables}.' }, true);
      uriInput = r0.f; uriInput.input.value = r.uriTemplate || ''; panel.appendChild(r0.field);
    } else {
      panel.appendChild(el('div', { class: 'field' }, [el('label', {}, ['uri']), (function () { var i = el('input', { type: 'text', spellcheck: 'false', readonly: 'readonly' }); i.value = r.uri || ''; return i; })()]));
    }
    var btn = el('button', { id: 'call', type: 'button', text: S('readResource') });
    var result = el('div', { id: 'result' });
    panel.appendChild(btn); panel.appendChild(result);
    btn.addEventListener('click', async function () {
      var uri = isTemplate ? uriInput.read() : r.uri;
      if (!uri) { result.textContent = ''; result.appendChild(el('div', { class: 'rt err', text: S('fillUri') })); return; }
      btn.disabled = true; result.textContent = ''; result.appendChild(el('div', { class: 'rt', text: S('reading') }));
      try {
        var res = await rpc('resources/read', { uri: uri });
        result.textContent = '';
        var contents = (res && res.contents) || [];
        result.appendChild(el('div', { class: 'lbl', text: 'contents (' + contents.length + ')' }));
        contents.forEach(function (c) { renderContentBlock(result, { type: 'resource', resource: c }); });
        if (!contents.length) result.appendChild(el('pre', { text: JSON.stringify(res, null, 2) }));
      } catch (e) {
        result.textContent = '';
        result.appendChild(el('div', { class: 'rt err', text: S('error') + (e.code ? ' ' + e.code : '') + ': ' + (e.message || e) }));
        if (e.data) result.appendChild(el('pre', { text: JSON.stringify(e.data, null, 2) }));
      } finally { btn.disabled = false; }
    });
  }

  // ---- shared rendering of content blocks --------------------------------------------------------------------------

  function contentBlocks(content) { return content === undefined || content === null ? [] : (Array.isArray(content) ? content : [content]); }

  function renderContentBlock(into, c) {
    if (!c || typeof c !== 'object') { into.appendChild(el('pre', { text: String(c) })); return; }
    if (c.type === 'text' || typeof c.text === 'string' && c.type === undefined) { into.appendChild(el('pre', { text: c.text })); return; }
    if (c.type === 'resource' && c.resource) {
      var r = c.resource;
      into.appendChild(el('div', { class: 'lbl', text: (r.uri || 'resource') + (r.mimeType ? '  ·  ' + r.mimeType : '') }));
      if (typeof r.text === 'string') into.appendChild(el('pre', { text: r.text }));
      else if (typeof r.blob === 'string') into.appendChild(el('pre', { text: '[binary, ' + r.blob.length + ' base64 chars]' }));
      else into.appendChild(el('pre', { text: JSON.stringify(r, null, 2) }));
      return;
    }
    if (c.type === 'image' || c.type === 'audio') { into.appendChild(el('pre', { text: '[' + c.type + (c.mimeType ? ' ' + c.mimeType : '') + ']' })); return; }
    into.appendChild(el('pre', { text: JSON.stringify(c, null, 2) }));
  }

  function contentText(content) {
    if (!Array.isArray(content)) return content;
    return content.map(function (c) { return c && c.type === 'text' ? c.text : JSON.stringify(c); }).join('\n');
  }

  function showError(e) {
    panel.textContent = '';
    panel.appendChild(el('div', { class: 'msg', html: 'Connection failed.<br><br>' + (e && e.message ? String(e.message) : '') +
      '<br><br>Check the endpoint URL, that the token is a current bearer token the server accepts, and that the server permits this origin.' }));
  }

  // ---- Getting a token from the authorization server ---------------------------------------------------------------
  // Discover the token endpoint from the MCP endpoint's protected resource metadata (RFC 9728) -> the authorization
  // server's metadata (RFC 8414). Everything is cross-origin to this desktop. The setup enables CORS on both servers, so
  // the common failure is not CORS but an untrusted self-signed certificate on those ports (accepted per origin); the
  // error names that first, then the CORS/paste-a-token fallback.
  async function discoverTokenEndpoint() {
    var ep = endpoint.value.trim();
    if (!/^https?:\/\//i.test(ep)) throw new Error(S('setEndpointFirst'));
    var u = new URL(ep);
    var prm = u.origin + '/.well-known/oauth-protected-resource' + u.pathname;   // RFC 9728 places the path after the well-known segment
    var meta = await getJson(prm, 'the protected-resource metadata');
    var servers = meta.authorization_servers || [];
    if (!servers.length) throw new Error('The endpoint names no authorization server in its metadata.');
    var asBase = String(servers[0]).replace(/\/$/, '');
    var asMeta = await getJson(asBase + '/.well-known/oauth-authorization-server', 'the authorization server metadata');
    if (!asMeta.token_endpoint) throw new Error('The authorization server metadata names no token endpoint.');
    return { tokenEndpoint: asMeta.token_endpoint, resource: meta.resource || ep,
      grants: asMeta.grant_types_supported || [], authMethods: asMeta.token_endpoint_auth_methods_supported || [],
      authorizationEndpoint: asMeta.authorization_endpoint || '',
      // Absent is not permissive. "If code_challenge_methods_supported is absent, the authorization server does not
      // support PKCE and MCP clients MUST refuse to proceed" (MCP authorization, Security Considerations). Held as
      // undefined rather than [] so that absent and empty are distinguishable from a list that omits S256.
      challengeMethods: asMeta.code_challenge_methods_supported,
      // The scopes the RESOURCE says it needs, for least privilege. MCP's scope selection strategy takes the scope
      // from the 401 WWW-Authenticate challenge first and the protected-resource metadata's scopes_supported second.
      scopesSupported: meta.scopes_supported,
      // The issuer, recorded before the user-agent is sent anywhere, for the RFC 9207 check on the way back. The
      // authenticated source is the metadata document, not the address it was fetched from.
      issuer: asMeta.issuer,
      issParameter: asMeta.authorization_response_iss_parameter_supported === true };
  }
  async function getJson(url, what) {
    var res;
    try { res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' }); }
    catch (e) { throw crossOriginError(url, what, e); }
    if (!res.ok) throw new Error('Could not read ' + what + ' (' + url + '): HTTP ' + res.status);
    return res.json();
  }
  function crossOriginError(url, what, e) {
    var here = ''; try { here = new URL(CTX.baseURI || CTX.origin || location.href).origin; } catch (x) {}
    var there = ''; try { there = new URL(url).origin; } catch (x) {}
    if (here && there && here !== there) {
      return new Error('Could not reach ' + what + ' at ' + there + ' from this desktop (' + here + '). ' +
        'It is a different origin, and a browser reports an untrusted TLS certificate and a missing CORS header the same way, so it is one of two things. ' +
        'The certificate: a self-signed certificate is accepted per origin, and ' + there + ' is a different port from this desktop, so accepting it here did not cover it — open ' + there + '/ in this browser, accept it, and try again. ' +
        'The server’s origin list: if ' + there + '/ already loads, the certificate is fine and the server is simply not permitting this page to read its answers. For a seedmi-dc controller that is [listen].origins in its configuration, which must name ' + here + ' (seedmi-dc 1.6 or later; earlier controllers have no such setting); restart the controller after changing it. ' +
        'Either way you can mint a token outside the browser — the setup prints a curl — and paste it into Token instead.');
    }
    return new Error('Could not reach ' + what + ' (' + (e && e.message || 'fetch failed') + ').');
  }
  // ---- The authorization code flow, for a client with no secret ----------------------------------------------------
  // PKCE (RFC 7636): a fresh verifier per request, and its S256 challenge. This replaces the client secret as the
  // thing that binds the code to the program redeeming it, which is what lets this page hold no secret at all.
  // The name of the hidden frame the authorization request is carried in, used both to create it and as the form's
  // target, so the two cannot drift apart.
  var AUTHZ_FRAME = 'seedmi-authorize';
  function b64url(bytes) {
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function pkce() {
    var raw = new Uint8Array(32); crypto.getRandomValues(raw);
    var verifier = b64url(raw);
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier: verifier, challenge: b64url(new Uint8Array(digest)) };
  }

  /**
   * Carry an authorization request to the controller and wait for the code to come back. Nothing is shown to anyone:
   * the exchange happens in a hidden iframe, and no window is opened at any point.
   *
   * `held` is the credential the desktop already holds, and it is required. The request is submitted as a FORM POST
   * carrying that name and password, so the person types nothing and sees nothing.
   *
   * Why a navigation at all, rather than a fetch. A fetch cannot read the authorization response. With
   * `redirect: 'manual'` the response is an opaque redirect whose Location a page may not read — exposing the header
   * does not change that — and with `redirect: 'follow'` the redirect makes the request's origin opaque, so only
   * `Access-Control-Allow-Origin: *` could satisfy the check, which a server answering with credentials must never
   * send. Measured in Chromium, both ways. The code therefore has to arrive as a NAVIGATION to this desktop's own
   * origin, where this page can read it off the frame's URL because it is same-origin by then. A form submission is a
   * navigation and not a fetch, so no CORS applies to it.
   *
   * Why a frame and not a window. Nothing about the flow needs to be visible when the credential is already held, and
   * a window that appears and vanishes is a pop-up whatever it is for. Measured: the whole exchange completes in a
   * hidden iframe in well under a second.
   *
   * What a frame cannot do, and why that is right. If the credential is not accepted, the controller answers with its
   * sign-in page, and that page carries `frame-ancestors 'none'` and `X-Frame-Options: DENY` — a sign-in page inside
   * somebody else's frame is a sign-in page somebody else is reading. The browser refuses to render it, the frame
   * lands on an error page this page may not read, and the only signal is that nothing arrives. So a stale password
   * reads as a timeout, and is reported as what it is rather than by opening anything.
   *
   * The redirect address need not be a page the desktop serves: the URL is readable the moment the frame lands on this
   * origin, whatever status it answers with.
   */
  function carryAuthorization(endpoint, params, held) {
    var u = new URL(endpoint);
    var frame = document.createElement('iframe');
    frame.name = AUTHZ_FRAME;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.style.cssText = 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;border:0;visibility:hidden';
    document.body.appendChild(frame);

    var f = document.createElement('form');
    f.method = 'post'; f.action = u.origin + u.pathname; f.target = AUTHZ_FRAME;
    var add = function (k, v) {
      var i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
    };
    params.forEach(function (v, k) { add(k, v); });
    add('username', held.name); add('password', held.password);
    document.body.appendChild(f); f.submit(); f.remove();

    // Poll for the frame to land back on this origin. Reading its location throws while it is still on the controller,
    // and throws the same way if the browser has put an error page there, which is why a refusal reads as a timeout.
    return new Promise(function (resolve) {
      var here = '';
      try { here = new URL(CTX.baseURI || location.href).origin; } catch (e) { here = location.origin; }
      var settled = false;
      var done = function (v) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        try { frame.remove(); } catch (e) {}
        resolve(v);
      };
      var timer = setInterval(function () {
        var at = null;
        try { at = frame.contentWindow.location.href; } catch (e) { return; }   // still elsewhere, or an error page
        if (!at || at === 'about:blank' || at.indexOf(here) !== 0) return;
        var got = new URL(at);
        done({ code: got.searchParams.get('code'), state: got.searchParams.get('state'),
          iss: got.searchParams.get('iss'),
          error: got.searchParams.get('error'), description: got.searchParams.get('error_description') });
      }, 100);
      // Generous against a slow controller and still far inside a person's patience: the measured exchange is one
      // round trip plus a redirect.
      setTimeout(function () { done({ error: 'timeout' }); }, 15000);
    });
  }

  async function mintToken(form, label, client) {
    setStatus(S('requestingToken'));
    var disc;
    try { disc = await discoverTokenEndpoint(); }
    catch (e) { setStatus('' + (e.message || e), 'err'); showError(e); return; }
    // An authorization_code request carries what the code was issued against and adds nothing: the scope was settled at
    // the authorization endpoint, and RFC 6749 4.1.3 does not take one here.
    if (form.get('grant_type') !== 'authorization_code') {
      form.set('resource', disc.resource);
      if (!form.has('scope')) form.set('scope', 'cdmi:read cdmi:write cdmi:admin');
    }
    // Authenticate the client. A password grant still needs the client to prove who it is -- the resource owner's
    // credentials are not the client's -- so both grants carry the client credentials here. Prefer HTTP Basic
    // (client_secret_basic), the baseline every OAuth server must support and the one this controller advertises;
    // fall back to the body only where the metadata advertises client_secret_post and not Basic. RFC 6749 2.3.1:
    // the id and secret are form-urlencoded before being joined and base64 encoded, so a secret with - or _ (which
    // setup-cvwm.py's secrets.token_urlsafe produces) authenticates reliably rather than by accident.
    var headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    var methods = disc.authMethods || [];
    if (!client) {
      // A public client. It names itself in the body and holds no secret (RFC 6749 2.1, RFC 8252 8.4: a program
      // distributed to the people who run it cannot keep one), and the code is bound to this page by the PKCE
      // verifier instead. The form already carries client_id and code_verifier.
      // RFC 8414 section 2 makes client_secret_basic the DEFAULT where the metadata omits the field, so an absent
      // list is a server that wants a secret, not one that will take a client without one. Absent is not permissive.
      if (methods.indexOf('none') < 0) {
        setStatus('The authorization server does not accept a client with no secret (' + (methods.length
          ? 'it names ' + methods.join(', ')
          : 'its metadata names no authentication method, which RFC 8414 reads as client_secret_basic') +
          '), so this button cannot be used. Register a public client, or paste a token.', 'err');
        return;
      }
    } else if (!methods.length || methods.indexOf('client_secret_basic') >= 0) {
      headers.Authorization = 'Basic ' + btoa(encodeURIComponent(client.id) + ':' + encodeURIComponent(client.secret));
    } else if (methods.indexOf('client_secret_post') >= 0) {
      form.set('client_id', client.id); form.set('client_secret', client.secret);
    } else {
      setStatus('The authorization server asks for a client authentication method this app does not implement (' + methods.join(', ') + ').', 'err'); return;
    }
    var res;
    try { res = await fetch(disc.tokenEndpoint, { method: 'POST', headers: headers, body: form.toString(), cache: 'no-store' }); }
    catch (e) { var err = crossOriginError(disc.tokenEndpoint, 'the token endpoint', e); setStatus('' + err.message, 'err'); showError(err); return; }
    var text = await res.text(), data = {}; try { data = JSON.parse(text); } catch (e) {}
    if (!res.ok || !data.access_token) {
      setStatus(S('tokenRefused') + (data.error || ('HTTP ' + res.status)) + (data.error_description ? ' — ' + data.error_description : ''), 'err');
      return;
    }
    token.value = data.access_token;
    setStatus(S('tokenObtained') + label + (data.expires_in ? ' (expires in ' + data.expires_in + 's)' : '') + '. Click Connect.', 'ok');
  }

  getBtn.addEventListener('click', function () {
    if (!clientId.value.trim() || !clientSecret.value.trim()) { setStatus(S('enterClient'), 'err'); return; }
    var form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    mintToken(form, 'for client ' + clientId.value.trim(), { id: clientId.value.trim(), secret: clientSecret.value.trim() });
  });

  // The id of the public client this desktop is registered as at the controller. The client id field beside it is the
  // CONFIDENTIAL client, used by "Get token" for client_credentials; a client with a secret is not a public one, so
  // the two cannot be the same registration. CTX names it where the desktop was configured with one.
  var PUBLIC_CLIENT = (CTX.oauth && CTX.oauth.publicClientId) || 'cvwm-mcpinspector';
  var CALLBACK = (CTX.oauth && CTX.oauth.redirectUri) || (function () {
    try { return new URL(CTX.baseURI || location.href).origin + '/oauth/callback'; }
    catch (e) { return location.origin + '/oauth/callback'; }
  })();

  userBtn.addEventListener('click', async function () {
    // A token in the signed-in person's name, by the authorization code flow with PKCE (RFC 6749 4.1, RFC 7636). This
    // page holds no client secret: it is a program distributed to whoever runs the desktop, so a secret in it would be
    // a secret everyone has. The code is bound to this page by the verifier instead.
    //
    // The credential the desktop already holds is submitted with the authorization request, in a hidden frame, so the
    // person types nothing and sees nothing. No window is opened at any point.
    //
    // That credential is required here. Without it there is no way to complete this invisibly: the controller would
    // answer with its sign-in page, and a sign-in page refuses to be framed (`frame-ancestors 'none'`) precisely so
    // that it cannot be displayed inside somebody else's document. Showing it would mean a window, and a window that
    // appears and vanishes is a pop-up whatever it is for. So this button says what it needs instead of opening one.
    var auth = String((CTX.headers && CTX.headers.Authorization) || '');
    var held;
    if (/^Basic /i.test(auth)) {
      var decoded = ''; try { decoded = atob(auth.replace(/^Basic /i, '')); } catch (e) {}
      var i = decoded.indexOf(':');
      if (i > 0) held = { name: CTX.principal || decoded.slice(0, i), password: decoded.slice(i + 1) };
    }
    if (!held) {
      setStatus('This needs the password you signed in to the desktop with, and this session does not hold one — ' +
        'a Negotiate or certificate sign-in leaves nothing to present. Paste a token into Token instead; the setup ' +
        'prints a command that mints one.', 'err');
      return;
    }
    setStatus('Asking the authorization server for a code…');
    var disc, pair;
    try { disc = await discoverTokenEndpoint(); pair = await pkce(); }
    catch (e) { setStatus('' + (e.message || e), 'err'); showError(e); return; }
    if (!disc.authorizationEndpoint) {
      setStatus('The authorization server metadata names no authorization endpoint, so a code cannot be obtained. ' +
        'This needs seedmi-dc 1.9 or later; with an earlier controller, paste a token instead.', 'err');
      return;
    }
    // PKCE support is verified before the user-agent goes anywhere, and an absent list is a server that does not
    // support PKCE rather than one that does not say: MCP requires a client to refuse to proceed in that case. There
    // is no way to discover PKCE support other than this field, which is why its absence has to be disqualifying.
    if (!Array.isArray(disc.challengeMethods) || disc.challengeMethods.length === 0) {
      setStatus('The authorization server metadata does not name code_challenge_methods_supported, so PKCE support ' +
        'cannot be established and this app will not send an authorization request without it.', 'err');
      return;
    }
    if (disc.challengeMethods.indexOf('S256') < 0) {
      setStatus('The authorization server does not offer S256 for PKCE (it offers ' + disc.challengeMethods.join(', ') +
        '), and this app will not fall back to plain.', 'err');
      return;
    }
    // state ties the answer to this request: anything arriving with another one is not an answer to it.
    var state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    // Least privilege: ask for what the RESOURCE says it needs, not for everything this app can imagine wanting.
    // The protected-resource metadata's scopes_supported is the minimal set for basic functionality; asking beyond it
    // is how a client ends up refused invalid_scope for a permission it never needed.
    var wanted = Array.isArray(disc.scopesSupported) && disc.scopesSupported.length
      ? disc.scopesSupported.join(' ') : 'cdmi:read cdmi:write cdmi:admin';
    var params = new URLSearchParams({ response_type: 'code', client_id: PUBLIC_CLIENT, redirect_uri: CALLBACK,
      scope: wanted, resource: disc.resource, state: state,
      code_challenge: pair.challenge, code_challenge_method: 'S256' });
    var back = await carryAuthorization(disc.authorizationEndpoint, params, held);
    if (back.error === 'timeout') {
      // The frame never reached this origin. The ordinary cause is that the controller did not accept the credential
      // and answered with its sign-in page, which a frame may not render; a page this one cannot read is
      // indistinguishable from one that has not arrived.
      setStatus('The authorization server did not accept the password this desktop holds for you, or did not answer. ' +
        'Sign in to the desktop again, or paste a token into Token.', 'err');
      return;
    }
    if (back.error) {
      setStatus('The authorization server refused: ' + back.error + (back.description ? ' — ' + back.description : ''), 'err');
      return;
    }
    if (!back.code) { setStatus('The authorization server came back without a code.', 'err'); return; }
    if (back.state !== state) {
      setStatus('The answer does not match the request this app made, so it was discarded.', 'err');
      return;
    }
    // RFC 9207 section 2.4: which authorization server answered. An attacker who controls one server a client talks
    // to can otherwise have the client carry an honest server's code to it, or its own code to the honest one -- a
    // mix-up attack. The comparison is a simple string comparison with no normalisation: no case folding, no default
    // port elided, no trailing slash added or removed. An absent iss is only acceptable where the metadata does not
    // claim to send one.
    if (back.iss !== null && back.iss !== undefined) {
      if (back.iss !== disc.issuer) {
        setStatus('The answer came from ' + back.iss + ', and this app asked ' + disc.issuer +
          '. It was discarded without being used.', 'err');
        return;
      }
    } else if (disc.issParameter) {
      setStatus('The authorization server says it identifies itself in its answers and this one did not, ' +
        'so the answer was discarded.', 'err');
      return;
    }
    var form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', back.code);
    form.set('redirect_uri', CALLBACK);
    form.set('client_id', PUBLIC_CLIENT);
    form.set('code_verifier', pair.verifier);
    form.set('resource', disc.resource);
    mintToken(form, 'for ' + (held ? held.name : 'the signed-in person'), undefined);
  });

  connect.addEventListener('click', doConnect);
  [endpoint, token].forEach(function (n) { n.addEventListener('keydown', function (e) { if (e.key === 'Enter') doConnect(); }); });
})();
