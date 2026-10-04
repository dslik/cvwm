/*!
 * domains for cvwm: browses the domain objects of a CDMI server. Enter a server origin (https://host:port); the app
 * reads the root domain object at "/cdmi_domains/" and shows the domain hierarchy as a tree on the left, expandable
 * lazily, with the selected domain's fields and metadata on the right. It reads through the desktop, using its
 * credentials and the same rules cvwm's own discovery follows. Domains support is the cdmi_domains capability;
 * where a server does not maintain domains, the tree is empty.
 *
 * A new sub-domain can be created under the selected domain with "New domain…", but only where the server and the
 * domain's ACL permit it: the button is enabled only when the domain's cdmi_acl grants the signed-in principal the
 * ADD_SUBCONTAINER right (and the domain's capabilities advertise cdmi_create_domain). The server is the final
 * arbiter -- a refusal it returns is shown as-is.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var R = CTX.rsrc || null;
  function S(id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; }

  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code:#eff1f3;--sel:#0969da;--selbg:#ddf4ff;--ok:#1a7f37;--warn:#9a6700;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code:#151b23;--sel:#4493f8;--selbg:#132132;--ok:#3fb950;--warn:#d29922;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    'body{display:flex;flex-direction:column;}' +
    '#bar{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);flex:none;}' +
    '#bar input{flex:1;min-width:0;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#bar button{height:30px;padding:0 12px;font-size:13px;background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;cursor:pointer;}' +
    '#bar button:hover{border-color:var(--muted);}' +
    '#bar button:disabled{opacity:.5;cursor:default;}' +
    '#bar button:disabled:hover{border-color:var(--border);}' +
    '#bar button.pri{background:var(--sel);color:#fff;border-color:var(--sel);}' +
    '#bar button.pri:hover:not(:disabled){filter:brightness(1.08);}' +
    '#split{flex:1;min-height:0;display:flex;}' +
    '#tree{flex:0 0 44%;min-width:180px;max-width:60%;overflow:auto;border-right:1px solid var(--border);padding:6px 0;}' +
    '#detail{flex:1;min-width:0;overflow:auto;padding:12px 14px;}' +
    '.node{}' +
    '.row{display:flex;align-items:center;gap:2px;padding:2px 8px;cursor:pointer;white-space:nowrap;user-select:none;}' +
    '.row:hover{background:var(--panel);}' +
    '.row.sel{background:var(--selbg);}' +
    '.tw{width:16px;flex:none;text-align:center;color:var(--muted);font-size:10px;}' +
    '.ic{flex:none;margin:0 4px 0 0;}' +
    '.nm{overflow:hidden;text-overflow:ellipsis;}' +
    '.nm.disabled{color:var(--muted);text-decoration:line-through;}' +
    '.kids{margin-left:14px;}' +
    '.msg{color:var(--muted);padding:20px 10px;}' +
    'h2.dh{margin:0 0 2px;font-size:16px;word-break:break-all;}' +
    '.durl{font:12px ui-monospace,monospace;color:var(--muted);word-break:break-all;margin:0 0 12px;}' +
    'table.f{border-collapse:collapse;width:100%;margin:0 0 14px;}' +
    'table.f th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:6px 8px;border-bottom:1px solid var(--border);}' +
    'table.f td{padding:5px 8px;border-bottom:1px solid var(--border);vertical-align:top;font:12px ui-monospace,monospace;word-break:break-all;}' +
    'table.f td.k{color:var(--muted);white-space:nowrap;width:1%;}' +
    '.sec{font-weight:600;margin:0 0 6px;}' +
    '.pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;background:var(--code);color:var(--muted);margin-left:6px;}' +
    '.pill.on{color:var(--ok);}.pill.off{color:var(--warn);}' +
    /* structured (JSON) metadata values */
    'table.jv-obj{border-collapse:collapse;width:100%;margin:0;}' +
    'table.jv-obj td{padding:2px 6px;border:0;vertical-align:top;font:12px ui-monospace,monospace;word-break:break-all;}' +
    'table.jv-obj td.jv-k{color:var(--muted);white-space:nowrap;width:1%;padding-right:10px;}' +
    '.jv-v{min-width:0;}' +
    '.jv-arr{display:flex;flex-direction:column;gap:4px;}' +
    '.jv-item{display:flex;gap:8px;align-items:flex-start;border-left:2px solid var(--border);padding-left:8px;}' +
    '.jv-idx{flex:none;font:11px ui-monospace,monospace;color:var(--muted);min-width:1.5em;text-align:right;padding-top:2px;}' +
    '.jv-cell{flex:1;min-width:0;}' +
    '.jv-pills{display:flex;flex-wrap:wrap;gap:4px;}' +
    '.jv-pill{font:12px ui-monospace,monospace;background:var(--code);border:1px solid var(--border);border-radius:5px;padding:1px 7px;word-break:break-all;}' +
    '.jv-empty{color:var(--muted);font-style:italic;}' +
    '.jv-raw{font:12px ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;}' +
    '.hint{color:var(--muted);font-size:12px;margin:0 0 12px;}' +
    '.hint.warn{color:var(--warn);}' +
    /* modal */
    '#ov{position:fixed;inset:0;background:rgba(0,0,0,.32);display:none;align-items:center;justify-content:center;z-index:20;}' +
    '#ov.on{display:flex;}' +
    '.dlg{background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:10px;width:380px;max-width:calc(100% - 32px);box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;}' +
    '.dlg h3{margin:0;padding:12px 16px;font-size:14px;border-bottom:1px solid var(--border);}' +
    '.dlg .bd{padding:14px 16px;display:flex;flex-direction:column;gap:10px;}' +
    '.dlg label.fl{font-size:12px;color:var(--muted);display:block;margin:0 0 4px;}' +
    '.dlg input[type=text]{width:100%;box-sizing:border-box;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '.dlg .ck{display:flex;align-items:center;gap:7px;font-size:13px;}' +
    '.dlg .under{font:12px ui-monospace,monospace;color:var(--muted);word-break:break-all;}' +
    '.dlg .err{color:#cf222e;font-size:12px;min-height:1px;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .dlg .err{color:#ff7b72;}}' +
    '.dlg .ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border);}' +
    '.dlg .ft button{height:30px;padding:0 14px;font-size:13px;border-radius:6px;border:1px solid var(--border);background:var(--code);color:var(--fg);cursor:pointer;}' +
    '.dlg .ft button.pri{background:var(--sel);color:#fff;border-color:var(--sel);}' +
    '.dlg .ft button:disabled{opacity:.5;cursor:default;}';
  style.textContent = (R && R.text('styles', 'domains')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(t, p, k) { var e = document.createElement(t); for (var x in (p || {})) { if (x === 'text') e.textContent = p[x]; else if (x === 'html') e.innerHTML = p[x]; else e.setAttribute(x, p[x]); } (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
  function domainIcon(sz) {
    return '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 16 16" style="display:block"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><ellipse cx="8" cy="8" rx="2.6" ry="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 8h12M3 5h10M3 11h10" stroke="currentColor" stroke-width="1"/></svg>';
  }

  // ---- Structured value rendering ------------------------------------------
  // A metadata value that is (or, as a string, parses to) a JSON array or object is shown as a nested structure
  // rather than a single line of JSON: objects become key/value tables, arrays of scalars become a row of pills,
  // and arrays of objects become indexed cells. Everything else is shown as plain text. Depth is bounded so a
  // pathological value falls back to compact JSON instead of nesting without end.
  var JV_MAX_DEPTH = 6;
  function looksJson(s) { s = s.trim(); return (s.charAt(0) === '{' && s.charAt(s.length - 1) === '}') || (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']'); }
  function coerce(v) {
    if (typeof v === 'string' && looksJson(v)) { try { var p = JSON.parse(v); if (p && typeof p === 'object') return p; } catch (e) { /* not JSON after all */ } }
    return v;
  }
  function isScalar(v) { return v === null || typeof v !== 'object'; }
  function scalarText(v) { return v === null ? 'null' : String(v); }
  function jsonView(value, depth) {
    depth = depth || 0;
    value = coerce(value);
    if (Array.isArray(value)) return arrView(value, depth);
    if (value && typeof value === 'object') return objView(value, depth);
    return document.createTextNode(scalarText(value));
  }
  function objView(obj, depth) {
    var keys = Object.keys(obj);
    if (!keys.length) return el('span', { class: 'jv-empty', text: S('empty-obj','{ } empty') });
    if (depth >= JV_MAX_DEPTH) return el('code', { class: 'jv-raw', text: JSON.stringify(obj) });
    var t = el('table', { class: 'jv-obj' });
    keys.forEach(function (k) {
      t.appendChild(el('tr', null, [el('td', { class: 'jv-k', text: k }), el('td', { class: 'jv-v' }, [jsonView(obj[k], depth + 1)])]));
    });
    return t;
  }
  function arrView(arr, depth) {
    if (!arr.length) return el('span', { class: 'jv-empty', text: S('empty-arr','[ ] empty') });
    if (depth >= JV_MAX_DEPTH) return el('code', { class: 'jv-raw', text: JSON.stringify(arr) });
    var allScalar = arr.every(function (x) { return isScalar(coerce(x)); });
    if (allScalar) {
      return el('div', { class: 'jv-pills' }, arr.map(function (x) { return el('span', { class: 'jv-pill', text: scalarText(x) }); }));
    }
    return el('div', { class: 'jv-arr' }, arr.map(function (x, i) {
      return el('div', { class: 'jv-item' }, [el('span', { class: 'jv-idx', text: String(i) }), el('div', { class: 'jv-cell' }, [jsonView(x, depth + 1)])]);
    }));
  }

  var input = el('input', { type: 'text', placeholder: S('origin-placeholder','https://host:port'), spellcheck: 'false' });
  var goBtn = el('button', { type: 'button', text: S('load','Load') });
  var newBtn = el('button', { type: 'button', class: 'pri', text: S('new-domain', 'New domain…') });
  newBtn.disabled = true;
  var bar = el('div', { id: 'bar' }, [input, goBtn, newBtn]);
  var tree = el('div', { id: 'tree' });
  var detail = el('div', { id: 'detail' });
  var split = el('div', { id: 'split' }, [tree, detail]);
  document.body.appendChild(bar); document.body.appendChild(split);
  if (CTX.resize) CTX.resize(760, 520);
  if (CTX.setTitle) CTX.setTitle(S('title','domains'));

  // default the origin to the desktop's own server
  (function () {
    try {
      var m = (D.mounted && D.mounted()) || [];
      var base = (m[0] && m[0].base) || CTX.baseURI || CTX.origin || '';
      var u = base && new URL(base); if (u) input.value = u.protocol + '//' + u.host;
    } catch (e) { if (CTX.origin) input.value = CTX.origin; }
  })();

  var selectedRow = null, selectedNode = null;

  function select(node, info) {
    var row = node && node.row;
    if (selectedRow) selectedRow.classList.remove('sel');
    selectedRow = row || null; if (row) row.classList.add('sel');
    selectedNode = node || null;
    renderDetail(info);
    refreshCreatePermission(node, info);
  }

  // Enable "New domain…" only where the selected domain lets this principal add a sub-domain (its ACL grants
  // ADD_SUBCONTAINER and the server advertises cdmi_create_domain). Runs per selection; the token guards against
  // a slow check landing after the selection has moved on.
  var permToken = 0;
  function refreshCreatePermission(node, info) {
    newBtn.disabled = true; newBtn.removeAttribute('title');
    if (!node || !info || !info.url) return;
    var my = ++permToken, url = info.url;
    Promise.resolve(D.domainCreatePermission ? D.domainCreatePermission(url, info.rep) : { allowed: true })
      .then(function (p) {
        if (my !== permToken) return;                 // selection changed while we were checking
        newBtn.disabled = !p.allowed;
        newBtn.title = p.allowed
          ? S('create-tip','Create a sub-domain under this domain')
          : (p.reason || S('cannot-add','You cannot add a sub-domain here.'));
      })
      .catch(function () { if (my === permToken) { newBtn.disabled = false; newBtn.title = S('create-tip','Create a sub-domain under this domain'); } });
  }

  function fieldRows(rep) {
    var order = ['objectType', 'objectID', 'objectName', 'parentURI', 'parentID', 'domainURI', 'capabilitiesURI', 'completionStatus', 'percentComplete'];
    var rows = [];
    order.forEach(function (k) { if (rep[k] != null && rep[k] !== '') rows.push([k, String(rep[k])]); });
    return rows;
  }

  function renderDetail(info) {
    detail.textContent = '';
    if (!info) { detail.appendChild(el('div', { class: 'msg', text: S('select-domain','Select a domain to see its details.') })); return; }
    var rep = info.rep || {};
    var isRoot = /\/cdmi_domains\/$/.test(info.url);
    var name = isRoot ? '/' : ((info.name) || (rep.objectName && rep.objectName.replace(/\/$/, '')) || '/');
    var enabled = rep.metadata && (rep.metadata.cdmi_domain_enabled === 'true' || rep.metadata.cdmi_domain_enabled === true);
    var enabledSet = rep.metadata && rep.metadata.cdmi_domain_enabled != null;
    var head = el('h2', { class: 'dh' }, [name === '/' ? 'Root domain' : name]);
    if (enabledSet) head.appendChild(el('span', { class: 'pill ' + (enabled ? 'on' : 'off'), text: enabled ? 'enabled' : 'disabled' }));
    detail.appendChild(head);
    detail.appendChild(el('div', { class: 'durl', text: info.url }));

    var frows = fieldRows(rep);
    if (frows.length) {
      var t = el('table', { class: 'f' }, [el('tr', null, [el('th', { text: S('field','Field') }), el('th', { text: 'Value' })])]);
      frows.forEach(function (r) { t.appendChild(el('tr', null, [el('td', { class: 'k', text: r[0] }), el('td', { text: r[1] })])); });
      detail.appendChild(t);
    }
    var md = rep.metadata || {};
    var keys = Object.keys(md).sort();
    detail.appendChild(el('div', { class: 'sec', text: S('metadata','Metadata') + (keys.length ? '' : S('metadata-none-suffix',' (none)')) }));
    if (keys.length) {
      var mt = el('table', { class: 'f' }, [el('tr', null, [el('th', { text: S('item','Item') }), el('th', { text: 'Value' })])]);
      keys.forEach(function (k) {
        mt.appendChild(el('tr', null, [el('td', { class: 'k', text: k }), el('td', null, [jsonView(md[k])])]));
      });
      detail.appendChild(mt);
    }
    var childCount = (info.children || []).length;
    detail.appendChild(el('div', { class: 'sec', text: S('subdomains','Sub-domains: ') + childCount }));
  }

  // A tree node: a row (twisty + icon + name) and a lazily-filled kids container.
  function makeNode(name, url, depth) {
    var twisty = el('span', { class: 'tw', text: '' });
    var icon = el('span', { class: 'ic', html: domainIcon(14) });
    var label = el('span', { class: 'nm', text: name === '/' ? 'Root domain' : name });
    var row = el('div', { class: 'row', title: url }, [twisty, icon, label]);
    var kids = el('div', { class: 'kids' });
    var node = el('div', { class: 'node' }, [row, kids]);
    var loaded = false, open = false, info = null, hasKids = null;
    var self;

    async function ensureInfo() {
      if (info) return info;
      info = await D.domainInfo(url);
      hasKids = (info.children || []).length > 0;
      var dis = info.rep && info.rep.metadata && info.rep.metadata.cdmi_domain_enabled === 'false';
      label.classList.toggle('disabled', !!dis);
      twisty.textContent = hasKids ? '\u25B6' : '';
      return info;
    }
    async function expand() {
      await ensureInfo();
      if (!hasKids) return;
      if (!loaded) {
        loaded = true;
        info.children.forEach(function (c) { kids.appendChild(makeNode(c.name, c.url, depth + 1).node); });
      }
      open = true; kids.style.display = ''; twisty.textContent = '\u25BC';
    }
    function collapse() { open = false; kids.style.display = 'none'; twisty.textContent = hasKids ? '\u25B6' : ''; }
    kids.style.display = 'none';

    // Re-read this domain and rebuild its child rows (used after a sub-domain is created here).
    async function reloadChildren() {
      info = null; loaded = false; kids.textContent = ''; kids.style.display = 'none'; open = false;
      await ensureInfo();
      await expand();
    }

    twisty.addEventListener('click', function (ev) { ev.stopPropagation(); if (open) collapse(); else expand(); });
    row.addEventListener('click', async function () {
      try { await ensureInfo(); select(self, info); if (hasKids && !open) expand(); }
      catch (e) { select(self, null); detail.textContent = ''; detail.appendChild(el('div', { class: 'msg', text: S('could-not-read','Could not read ') + url + '\n\n' + ((e && e.message) || '') })); }
    });

    self = { node: node, expand: expand, ensureInfo: ensureInfo, reloadChildren: reloadChildren, row: row, url: url, name: name, getInfo: function () { return info; } };
    return self;
  }

  async function load() {
    var origin = input.value.trim().replace(/\/+$/, '');
    tree.textContent = ''; detail.textContent = ''; selectedNode = null; newBtn.disabled = true;
    if (!/^https:\/\//i.test(origin)) { tree.appendChild(el('div', { class: 'msg', text: S('origin-help','A server origin is an https: URL, e.g. https://cdmi.example.local:9443') })); return; }
    tree.appendChild(el('div', { class: 'msg', text: S('reading','Reading \u2026') }));
    var rootURL = (D.domainsRoot && D.domainsRoot(origin)) || (origin + '/cdmi_domains/');
    try {
      var root = makeNode('/', rootURL, 0);
      await root.ensureInfo();
      tree.textContent = '';
      tree.appendChild(root.node);
      await root.expand();                          // show the top level
      select(root, root.getInfo());                 // select the root by default
    } catch (e) {
      tree.textContent = '';
      var m = (e && e.message) || 'The server did not answer.';
      tree.appendChild(el('div', { class: 'msg', html: 'Could not read the domains at <code>' + rootURL + '</code><br><br>' + m + '<br><br>This server may not maintain domains (the cdmi_domains capability).' }));
    }
  }

  // ---- New domain dialog ----------------------------------------------------
  var dlgName, dlgEnabled, dlgUnder, dlgErr, dlgCreate, overlay, creating = false;
  function buildDialog() {
    dlgName = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: S('name-placeholder','a domain name') });
    dlgEnabled = el('input', { type: 'checkbox' }); dlgEnabled.checked = true;
    dlgUnder = el('div', { class: 'under' });
    dlgErr = el('div', { class: 'err' });
    var cancel = el('button', { type: 'button', text: S('cancel','Cancel') });
    dlgCreate = el('button', { type: 'button', class: 'pri', text: S('create','Create') });
    var dlg = el('div', { class: 'dlg' }, [
      el('h3', { text: S('dlg-title','New domain') }),
      el('div', { class: 'bd' }, [
        el('div', null, [el('label', { class: 'fl', text: S('create-under','Create under') }), dlgUnder]),
        el('div', null, [el('label', { class: 'fl', text: S('name','Name') }), dlgName]),
        el('label', { class: 'ck' }, [dlgEnabled, document.createTextNode(S('enabled-field','Enabled (cdmi_domain_enabled)'))]),
        dlgErr
      ]),
      el('div', { class: 'ft' }, [cancel, dlgCreate])
    ]);
    overlay = el('div', { id: 'ov' }, [dlg]);
    document.body.appendChild(overlay);
    cancel.addEventListener('click', closeDialog);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeDialog(); });
    dlgCreate.addEventListener('click', doCreate);
    dlgName.addEventListener('keydown', function (e) { if (e.key === 'Enter') doCreate(); if (e.key === 'Escape') closeDialog(); });
    dlgName.addEventListener('input', function () { dlgErr.textContent = ''; });
  }
  function openDialog() {
    if (!selectedNode) return;
    if (!overlay) buildDialog();
    var here = selectedNode.name === '/' ? 'Root domain' : selectedNode.name;
    dlgUnder.textContent = here + '   ' + selectedNode.url;
    dlgName.value = ''; dlgEnabled.checked = true; dlgErr.textContent = '';
    dlgCreate.disabled = false; creating = false;
    overlay.classList.add('on');
    setTimeout(function () { dlgName.focus(); }, 0);
  }
  function closeDialog() { if (overlay && !creating) overlay.classList.remove('on'); }

  async function doCreate() {
    if (creating || !selectedNode) return;
    var name = dlgName.value.trim();
    if (!name) { dlgErr.textContent = S('enter-name','Enter a name for the domain.'); dlgName.focus(); return; }
    if (/[\/?#]/.test(name)) { dlgErr.textContent = S('bad-name','A domain name cannot contain / ? or #.'); return; }
    creating = true; dlgCreate.disabled = true; dlgCreate.textContent = S('creating','Creating\u2026'); dlgErr.textContent = '';
    var parent = selectedNode;
    var res = await (D.createDomain ? D.createDomain(parent.url, name, { enabled: dlgEnabled.checked })
      : Promise.resolve({ ok: false, error: S('cannot-create','This desktop cannot create domains.') }));
    creating = false; dlgCreate.textContent = S('create','Create'); dlgCreate.disabled = false;
    if (!res || !res.ok) { dlgErr.textContent = (res && res.error) || S('could-not-create','The domain could not be created.'); return; }
    overlay.classList.remove('on');
    try {
      await parent.reloadChildren();
      select(parent, parent.getInfo());            // refresh detail (sub-domain count) and re-check permission
    } catch (e) { /* the create succeeded; a refresh hiccup is non-fatal */ }
  }

  newBtn.addEventListener('click', openDialog);
  goBtn.addEventListener('click', load);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
  if (input.value) load();
})();
