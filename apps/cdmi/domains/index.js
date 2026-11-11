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
  function S(id, vars) { var v = R && R.text('strings', id); if (v == null) return id; if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]); return v; }

  var style = document.createElement('style');
  style.textContent = R.text('styles', 'domains');
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
    if (!keys.length) return el('span', { class: 'jv-empty', text: S('empty-obj') });
    if (depth >= JV_MAX_DEPTH) return el('code', { class: 'jv-raw', text: JSON.stringify(obj) });
    var t = el('table', { class: 'jv-obj' });
    keys.forEach(function (k) {
      t.appendChild(el('tr', null, [el('td', { class: 'jv-k', text: k }), el('td', { class: 'jv-v' }, [jsonView(obj[k], depth + 1)])]));
    });
    return t;
  }
  function arrView(arr, depth) {
    if (!arr.length) return el('span', { class: 'jv-empty', text: S('empty-arr') });
    if (depth >= JV_MAX_DEPTH) return el('code', { class: 'jv-raw', text: JSON.stringify(arr) });
    var allScalar = arr.every(function (x) { return isScalar(coerce(x)); });
    if (allScalar) {
      return el('div', { class: 'jv-pills' }, arr.map(function (x) { return el('span', { class: 'jv-pill', text: scalarText(x) }); }));
    }
    return el('div', { class: 'jv-arr' }, arr.map(function (x, i) {
      return el('div', { class: 'jv-item' }, [el('span', { class: 'jv-idx', text: String(i) }), el('div', { class: 'jv-cell' }, [jsonView(x, depth + 1)])]);
    }));
  }

  var input = el('input', { type: 'text', placeholder: S('origin-placeholder'), spellcheck: 'false' });
  var goBtn = el('button', { type: 'button', text: S('load') });
  var newBtn = el('button', { type: 'button', class: 'pri', text: S('new-domain') });
  newBtn.disabled = true;
  var bar = el('div', { id: 'bar' }, [input, goBtn, newBtn]);
  var tree = el('div', { id: 'tree' });
  var detail = el('div', { id: 'detail' });
  var split = el('div', { id: 'split' }, [tree, detail]);
  document.body.appendChild(bar); document.body.appendChild(split);
  // One light/dark setting serves the whole desktop: the shared cvwm.dark key in localStorage, which the desktop
  // toggles (View > Dark mode) and every app follows by mirroring it onto body.dark.
  function setDark(on) { document.body.classList.toggle('dark', !!on); }
  try { setDark(localStorage.getItem('cvwm.dark') === 'on'); } catch (e) { /* no storage */ }
  window.addEventListener('storage', function (ev) { if (ev.key === 'cvwm.dark') setDark(ev.newValue === 'on'); });
  if (CTX.resize) CTX.resize(760, 520);
  if (CTX.setTitle) CTX.setTitle(S('title'));

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
          ? S('create-tip')
          : (p.reason || S('cannot-add'));
      })
      .catch(function () { if (my === permToken) { newBtn.disabled = false; newBtn.title = S('create-tip'); } });
  }

  function fieldRows(rep) {
    var order = ['objectType', 'objectID', 'objectName', 'parentURI', 'parentID', 'domainURI', 'capabilitiesURI', 'completionStatus', 'percentComplete'];
    var rows = [];
    order.forEach(function (k) { if (rep[k] != null && rep[k] !== '') rows.push([k, String(rep[k])]); });
    return rows;
  }

  function renderDetail(info) {
    detail.textContent = '';
    if (!info) { detail.appendChild(el('div', { class: 'msg', text: S('select-domain') })); return; }
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
      var t = el('table', { class: 'f' }, [el('tr', null, [el('th', { text: S('field') }), el('th', { text: 'Value' })])]);
      frows.forEach(function (r) { t.appendChild(el('tr', null, [el('td', { class: 'k', text: r[0] }), el('td', { text: r[1] })])); });
      detail.appendChild(t);
    }
    var md = rep.metadata || {};
    var keys = Object.keys(md).sort();
    detail.appendChild(el('div', { class: 'sec', text: S('metadata') + (keys.length ? '' : S('metadata-none-suffix')) }));
    if (keys.length) {
      var mt = el('table', { class: 'f' }, [el('tr', null, [el('th', { text: S('item') }), el('th', { text: 'Value' })])]);
      keys.forEach(function (k) {
        mt.appendChild(el('tr', null, [el('td', { class: 'k', text: k }), el('td', null, [jsonView(md[k])])]));
      });
      detail.appendChild(mt);
    }
    var childCount = (info.children || []).length;
    detail.appendChild(el('div', { class: 'sec', text: S('subdomains') + childCount }));
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
      catch (e) { select(self, null); detail.textContent = ''; detail.appendChild(el('div', { class: 'msg', text: S('could-not-read') + url + '\n\n' + ((e && e.message) || '') })); }
    });

    self = { node: node, expand: expand, ensureInfo: ensureInfo, reloadChildren: reloadChildren, row: row, url: url, name: name, getInfo: function () { return info; } };
    return self;
  }

  async function load() {
    var origin = input.value.trim().replace(/\/+$/, '');
    tree.textContent = ''; detail.textContent = ''; selectedNode = null; newBtn.disabled = true;
    if (!/^https:\/\//i.test(origin)) { tree.appendChild(el('div', { class: 'msg', text: S('origin-help') })); return; }
    tree.appendChild(el('div', { class: 'msg', text: S('reading') }));
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
    dlgName = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: S('name-placeholder') });
    dlgEnabled = el('input', { type: 'checkbox' }); dlgEnabled.checked = true;
    dlgUnder = el('div', { class: 'under' });
    dlgErr = el('div', { class: 'err' });
    var cancel = el('button', { type: 'button', text: S('cancel') });
    dlgCreate = el('button', { type: 'button', class: 'pri', text: S('create') });
    var dlg = el('div', { class: 'dlg' }, [
      el('h3', { text: S('dlg-title') }),
      el('div', { class: 'bd' }, [
        el('div', null, [el('label', { class: 'fl', text: S('create-under') }), dlgUnder]),
        el('div', null, [el('label', { class: 'fl', text: S('name') }), dlgName]),
        el('label', { class: 'ck' }, [dlgEnabled, document.createTextNode(S('enabled-field'))]),
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
    if (!name) { dlgErr.textContent = S('enter-name'); dlgName.focus(); return; }
    if (/[\/?#]/.test(name)) { dlgErr.textContent = S('bad-name'); return; }
    creating = true; dlgCreate.disabled = true; dlgCreate.textContent = S('creating'); dlgErr.textContent = '';
    var parent = selectedNode;
    var res = await (D.createDomain ? D.createDomain(parent.url, name, { enabled: dlgEnabled.checked })
      : Promise.resolve({ ok: false, error: S('cannot-create') }));
    creating = false; dlgCreate.textContent = S('create'); dlgCreate.disabled = false;
    if (!res || !res.ok) { dlgErr.textContent = (res && res.error) || S('could-not-create'); return; }
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
