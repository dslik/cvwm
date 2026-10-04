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
 * (client_credentials), or as the signed-in desktop user (password grant, using the desktop's own credential). Token
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
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var PROTOCOL = '2026-07-28';

  // CDMI closed-set arguments the input schema does not yet declare as enums. Offered as an editable pick-list (a
  // client fallback); once a server declares the enum, that authoritative list is used as a strict select instead.
  var FALLBACK_ENUMS = {
    representation: ['cdmi-object', 'cdmi-container', 'cdmi-queue', 'cdmi-domain', 'cdmi-capability'],
    mode: ['replace', 'replace-fields', 'merge']
  };
  if (R) { var _en = R.json('data', 'enums'); if (_en && typeof _en === 'object') FALLBACK_ENUMS = _en; }

  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code:#eff1f3;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--sel:#ddf4ff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code:#151b23;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--sel:#132132;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    'body{display:flex;flex-direction:column;}' +
    // top row: endpoint (left), token (beside it), Connect (right) — inputs and button one height.
    '#top{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);flex:none;}' +
    '#top input{height:30px;box-sizing:border-box;min-width:0;font:12px var(--mono);padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#top .ep{flex:2 1 0;}' +
    '#top .tok{flex:1 1 0;}' +
    '#top .go{height:30px;flex:none;padding:0 18px;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;font-weight:600;cursor:pointer;}' +
    '#top .go:disabled{opacity:.6;cursor:default;}' +
    // second row: the token-minting controls.
    '#crow{display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border);flex:none;}' +
    '#crow label{color:var(--muted);font-size:12px;flex:none;}' +
    '#crow input{height:28px;box-sizing:border-box;flex:1 1 0;min-width:60px;font:12px var(--mono);padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#crow .mint{height:28px;flex:none;padding:0 10px;background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;}' +
    '#crow .mint:hover{border-color:var(--muted);}#crow .mint:disabled{opacity:.6;cursor:default;}' +
    // status line pinned to the bottom of the window, where errors show.
    '#status{flex:none;padding:5px 10px;font:12px var(--mono);border-top:1px solid var(--border);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#status .ok{color:var(--ok);}#status .err{color:var(--err);}' +
    '#split{flex:1;min-height:0;display:flex;}' +
    // left column: the capability tabs above a scrolling list.
    '#left{flex:0 0 34%;min-width:180px;max-width:55%;display:flex;flex-direction:column;border-right:1px solid var(--border);}' +
    '#tabs{display:flex;flex:none;border-bottom:1px solid var(--border);}' +
    '#tabs button{flex:1;padding:7px 6px;background:var(--panel);border:0;border-right:1px solid var(--border);cursor:pointer;font:inherit;font-size:12px;color:var(--muted);}' +
    '#tabs button:last-child{border-right:0;}' +
    '#tabs button.on{background:var(--bg);color:var(--fg);font-weight:600;box-shadow:inset 0 -2px 0 var(--accent);}' +
    '#tabs button:disabled{opacity:.45;cursor:default;}' +
    '#list{flex:1;overflow:auto;}' +
    '.tool{padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;}' +
    '.tool:hover{background:var(--panel);}.tool.sel{background:var(--sel);}' +
    '.tool .nm{font-family:var(--mono);font-weight:600;word-break:break-all;}' +
    '.tool .ds{color:var(--muted);font-size:12px;}' +
    '.tool .ro{font-size:11px;color:var(--ok);}' +
    '#panel{flex:1;min-width:0;overflow:auto;padding:12px 14px;}' +
    '#panel h2{margin:0 0 2px;font:600 15px var(--mono);word-break:break-all;}' +
    '#panel .desc{color:var(--muted);margin:0 0 12px;}' +
    '.field{margin:0 0 10px;}' +
    '.field label{display:block;font-size:12px;margin:0 0 3px;}' +
    '.field .req{color:var(--err);}' +
    '.field .hint{color:var(--muted);font-size:11px;margin:2px 0 0;}' +
    '.field input,.field textarea,.field select{width:100%;box-sizing:border-box;font:12px var(--mono);padding:5px 7px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '.field textarea{min-height:70px;resize:vertical;}' +
    '#call{height:30px;padding:0 16px;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;font-weight:600;cursor:pointer;margin:4px 0 12px;}' +
    '#call:disabled{opacity:.6;cursor:default;}' +
    '#result{border-top:1px solid var(--border);padding-top:10px;}' +
    '#result .rt{font-size:12px;margin:0 0 6px;}' +
    '#result .lbl{color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;margin:12px 0 4px;}' +
    '#result .role{font-size:11px;font-weight:700;color:var(--accent);margin:12px 0 2px;text-transform:uppercase;letter-spacing:.03em;}' +
    '#result pre{margin:0;padding:10px;background:var(--code);border-radius:6px;font:12px var(--mono);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:50vh;}' +
    '.msg{color:var(--muted);padding:24px 12px;text-align:center;}';
  style.textContent = (R && R.text('styles', 'mcpinspector')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(t, p, k) { var e = document.createElement(t); for (var x in (p || {})) { if (x === 'text') e.textContent = p[x]; else if (x === 'html') e.innerHTML = p[x]; else e.setAttribute(x, p[x]); } (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }

  var endpoint = el('input', { type: 'text', id: 'ep', class: 'ep', spellcheck: 'false', placeholder: S('endpointPlaceholder', 'https://host:8100/mcp') });
  var token = el('input', { type: 'password', id: 'tok', class: 'tok', spellcheck: 'false', placeholder: S('tokenPlaceholder', 'bearer token') });
  var connect = el('button', { class: 'go', type: 'button', text: S('connect', 'Connect') });
  var clientId = el('input', { type: 'text', id: 'cid', spellcheck: 'false', placeholder: S('clientIdPlaceholder', 'client id') });
  var clientSecret = el('input', { type: 'password', id: 'csec', spellcheck: 'false', placeholder: S('clientSecretPlaceholder', 'client secret') });
  var getBtn = el('button', { class: 'mint', type: 'button', text: S('getToken', 'Get token') });
  var userBtn = el('button', { class: 'mint', type: 'button', text: S('useUser', 'Use logged-in user') });
  var top = el('div', { id: 'top' }, [endpoint, token, connect]);
  var crow = el('div', { id: 'crow' }, [
    el('label', { for: 'cid', text: S('client', 'Client') }), clientId, clientSecret, getBtn, userBtn
  ]);
  var status = el('div', { id: 'status', text: S('notConnected', 'Not connected.') });
  var tabsEl = el('div', { id: 'tabs' });
  var listEl = el('div', { id: 'list' }, [el('div', { class: 'msg', text: S('listConnect', 'Connect to list what the server offers.') })]);
  var leftEl = el('div', { id: 'left' }, [tabsEl, listEl]);
  var panel = el('div', { id: 'panel' }, [el('div', { class: 'msg', text: S('panelConnect', 'Connect, then pick an item.') })]);
  var split = el('div', { id: 'split' }, [leftEl, panel]);
  // top row and token controls above; the split fills; the status line sits at the bottom.
  document.body.appendChild(top); document.body.appendChild(crow); document.body.appendChild(split); document.body.appendChild(status);
  if (CTX.resize) CTX.resize(900, 640);
  if (CTX.setTitle) CTX.setTitle(S('title', 'mcpinspector'));

  // Prefill the endpoint from the server's advertised cdmi_mcp_uri, else from the origin on an 8100 guess.
  (function () {
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
    { key: 'tools', label: S('tabTools', 'Tools') },
    { key: 'prompts', label: S('tabPrompts', 'Prompts') },
    { key: 'resources', label: S('tabResources', 'Resources') }
  ];

  async function doConnect() {
    if (!/^https?:\/\//i.test(endpoint.value.trim())) { setStatus(S('httpUrl', 'The endpoint is an http(s) URL.'), 'err'); return; }
    connect.disabled = true; setStatus(S('initializing', 'Initializing …'));
    tabsEl.textContent = ''; listEl.textContent = ''; panel.textContent = '';
    lists = { tools: [], prompts: [], resources: [], templates: [] }; selected = null;
    try {
      var init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cvwm-mcpinspector', version: '1' } });
      var sv = (init && init.serverInfo) || {};
      caps = (init && init.capabilities) || {};
      setStatus(S('connectedPrefix', 'Connected — ') + (sv.name || 'server') + ' ' + (sv.version || '') + ', protocol ' + (init.protocolVersion || '?') + capsSummary(caps), 'ok');

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
      listEl.appendChild(el('div', { class: 'msg', text: S('couldNotConnect', 'Could not connect.') }));
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
      var sel = el('select', {}, [el('option', { value: '', text: S('unset', '(unset)') })].concat(enumVals.map(function (v) { return el('option', { value: String(v), text: String(v) }); })));
      return { input: sel, read: function () { return sel.value === '' ? undefined : sel.value; } };
    }
    if (type === 'boolean') {
      var b = el('select', {}, [el('option', { value: '', text: S('unset', '(unset)') }), el('option', { value: 'true', text: 'true' }), el('option', { value: 'false', text: 'false' })]);
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

    var callBtn = el('button', { id: 'call', type: 'button', text: S('call', 'Call ') + t.name });
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
    callBtn.disabled = true; result.textContent = ''; result.appendChild(el('div', { class: 'rt', text: S('calling', 'Calling …') }));
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
      result.appendChild(el('div', { class: 'rt err', text: S('error', 'Error') + (e.code ? ' ' + e.code : '') + ': ' + (e.message || e) }));
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
    if (!argDefs.length) panel.appendChild(el('p', { class: 'desc', text: S('noArgs', 'This prompt takes no arguments.') }));
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
        result.appendChild(el('div', { class: 'rt err', text: S('error', 'Error') + (e.code ? ' ' + e.code : '') + ': ' + (e.message || e) }));
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
    var btn = el('button', { id: 'call', type: 'button', text: S('readResource', 'Read resource') });
    var result = el('div', { id: 'result' });
    panel.appendChild(btn); panel.appendChild(result);
    btn.addEventListener('click', async function () {
      var uri = isTemplate ? uriInput.read() : r.uri;
      if (!uri) { result.textContent = ''; result.appendChild(el('div', { class: 'rt err', text: S('fillUri', 'Fill in the resource URI.') })); return; }
      btn.disabled = true; result.textContent = ''; result.appendChild(el('div', { class: 'rt', text: S('reading', 'Reading …') }));
      try {
        var res = await rpc('resources/read', { uri: uri });
        result.textContent = '';
        var contents = (res && res.contents) || [];
        result.appendChild(el('div', { class: 'lbl', text: 'contents (' + contents.length + ')' }));
        contents.forEach(function (c) { renderContentBlock(result, { type: 'resource', resource: c }); });
        if (!contents.length) result.appendChild(el('pre', { text: JSON.stringify(res, null, 2) }));
      } catch (e) {
        result.textContent = '';
        result.appendChild(el('div', { class: 'rt err', text: S('error', 'Error') + (e.code ? ' ' + e.code : '') + ': ' + (e.message || e) }));
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
    if (!/^https?:\/\//i.test(ep)) throw new Error(S('setEndpointFirst', 'Set the MCP endpoint URL first.'));
    var u = new URL(ep);
    var prm = u.origin + '/.well-known/oauth-protected-resource' + u.pathname;   // RFC 9728 places the path after the well-known segment
    var meta = await getJson(prm, 'the protected-resource metadata');
    var servers = meta.authorization_servers || [];
    if (!servers.length) throw new Error('The endpoint names no authorization server in its metadata.');
    var asBase = String(servers[0]).replace(/\/$/, '');
    var asMeta = await getJson(asBase + '/.well-known/oauth-authorization-server', 'the authorization server metadata');
    if (!asMeta.token_endpoint) throw new Error('The authorization server metadata names no token endpoint.');
    return { tokenEndpoint: asMeta.token_endpoint, resource: meta.resource || ep, grants: asMeta.grant_types_supported || [] };
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
      return new Error('Could not reach ' + what + ' at ' + there + ' from this desktop (' + here + '). It is a different origin. ' +
        'The setup enables cross-origin (CORS) requests to it, so the usual cause is that this browser does not yet trust the server’s TLS certificate on that origin: a self-signed certificate is accepted per origin, and ' + there + ' is a different port from the desktop, so accepting it for the desktop did not cover it. ' +
        'Open ' + there + '/ in this browser and accept the certificate, then try again. ' +
        '(If the server was not built with CORS, mint a token outside the browser — the setup prints a curl — and paste it into Token instead.)');
    }
    return new Error('Could not reach ' + what + ' (' + (e && e.message || 'fetch failed') + ').');
  }
  async function mintToken(form, label) {
    setStatus(S('requestingToken', 'Requesting a token …'));
    var disc;
    try { disc = await discoverTokenEndpoint(); }
    catch (e) { setStatus('' + (e.message || e), 'err'); showError(e); return; }
    form.set('resource', disc.resource);
    if (!form.has('scope')) form.set('scope', 'cdmi:read cdmi:write cdmi:admin');
    var res;
    try { res = await fetch(disc.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), cache: 'no-store' }); }
    catch (e) { var err = crossOriginError(disc.tokenEndpoint, 'the token endpoint', e); setStatus('' + err.message, 'err'); showError(err); return; }
    var text = await res.text(), data = {}; try { data = JSON.parse(text); } catch (e) {}
    if (!res.ok || !data.access_token) {
      setStatus(S('tokenRefused', 'Token request refused: ') + (data.error || ('HTTP ' + res.status)) + (data.error_description ? ' — ' + data.error_description : ''), 'err');
      return;
    }
    token.value = data.access_token;
    setStatus(S('tokenObtained', 'Token obtained ') + label + (data.expires_in ? ' (expires in ' + data.expires_in + 's)' : '') + '. Click Connect.', 'ok');
  }

  getBtn.addEventListener('click', function () {
    if (!clientId.value.trim() || !clientSecret.value.trim()) { setStatus(S('enterClient', 'Enter the client id and secret.'), 'err'); return; }
    var form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', clientId.value.trim());
    form.set('client_secret', clientSecret.value.trim());
    mintToken(form, 'for client ' + clientId.value.trim());
  });

  userBtn.addEventListener('click', function () {
    // The desktop's own credential, as a Basic header, holds the signed-in user and password; the token is obtained by
    // the password grant, as that principal. The username is the realm-qualified identifier the desktop resolved.
    var auth = (CTX.headers && CTX.headers.Authorization) || '';
    if (!/^Basic /i.test(auth)) { setStatus('Sign in to the desktop with a username and password first (the logged-in credential is not a basic one here).', 'err'); return; }
    var decoded = ''; try { decoded = atob(auth.replace(/^Basic /i, '')); } catch (e) {}
    var i = decoded.indexOf(':');
    if (i < 0) { setStatus('The signed-in credential could not be read.', 'err'); return; }
    var pass = decoded.slice(i + 1);
    var username = CTX.principal || decoded.slice(0, i);   // the realm-qualified name the desktop resolved, else the bare one
    var form = new URLSearchParams();
    form.set('grant_type', 'password');
    form.set('username', username);
    form.set('password', pass);
    mintToken(form, 'for ' + username);
  });
  if (!(CTX.headers && /^Basic /i.test(String((CTX.headers || {}).Authorization || '')))) userBtn.disabled = true, userBtn.title = 'Sign in to the desktop with a username and password to use this.';

  connect.addEventListener('click', doConnect);
  [endpoint, token].forEach(function (n) { n.addEventListener('keydown', function (e) { if (e.key === 'Enter') doConnect(); }); });
})();
