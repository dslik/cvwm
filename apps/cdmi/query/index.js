/*!
 * query for cvwm: a Sherlock-style CDMI query application (13.x). A CDMI query is run by a query queue -- a queue
 * object carrying cdmi_queue_type = "cdmi_query_queue", a cdmi_scope_specification (the objects to match), and a
 * cdmi_results_specification (the fields each result carries). The server walks its namespace, enqueues one value
 * per matching object, and reports progress in cdmi_query_status (Processing -> Current when done).
 *
 * This app builds a scope from AND-groups joined by OR (which is exactly what a scope specification expresses: each
 * array clause ANDs its fields, and the clauses OR together), creates the query queue INSIDE its own container,
 * polls it, and lists the matches. A single click selects; a double-click opens the object via the desktop.
 *
 * Its controls and result list reuse cvwm's own look -- the .fv-btn buttons, .fv-in fields, the .fv-lhead sticky
 * list header, and the monospace list rows with the black selection of the container browser's list view, and the
 * bordered condition panels of the ACL builder -- so the app sits within the desktop rather than beside it.
 *
 * The app's own container is read-only where cvwm installs it under /apps/, so where creating the queue there is
 * refused the app falls back to a hidden container in the user's home. The queue is transient: it is recreated on
 * each Find and deleted when the app closes.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var HDRS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default below and the app runs exactly as before. S() reads a string; data tables and the stylesheet and
  // icons are pulled where present further down.
  var R = CTX.rsrc || null;
  function S(id, vars) { var v = R && R.text('strings', id); if (v == null) return id; if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]); return v; }
  function slash(u) { return u && !/\/$/.test(u) ? u + '/' : u; }
  var CONTAINER = slash(CTX.containerURI || CTX.baseURI || '');
  var BASE = slash(CTX.baseURI || CONTAINER);           // the disk base the app is on (a home may be a sub-path of the root)
  var HOME = CTX.homeURI ? slash(CTX.homeURI) : null;
  // Running a scope and showing its results is the shared engine (code/engine), loaded from this app's fork; this app
  // only builds the scope and hands it to engine.run(). A smart folder loads the same engine from its own fork.
  var engine = null;

  if (CTX.setTitle) CTX.setTitle(S('title'));
  if (CTX.resize) CTX.resize(720, 512);

  var FIELDS = [
    { v: 'objectName', label: 'Name', t: 'top', k: 'objectName' },
    { v: 'objectType', label: 'Type', t: 'top', k: 'objectType' },
    { v: 'cdmi_size', label: 'Size', t: 'meta', k: 'cdmi_size' },
    { v: 'cdmi_mtime', label: 'Modified', t: 'meta', k: 'cdmi_mtime' },
    { v: 'cdmi_ctime', label: 'Created', t: 'meta', k: 'cdmi_ctime' },
    { v: 'cdmi_owner', label: 'Owner', t: 'meta', k: 'cdmi_owner' },
    { v: 'cvwm_tags', label: 'Tags…', t: 'meta', k: 'cvwm_tags' },
    { v: '_metakey', label: 'Metadata key…', t: 'metakey' }
  ];
  var OPS = [
    { v: 'contains', label: 'contains', tok: 'contains' },
    { v: '!contains', label: 'does not contain', tok: '!contains' },
    { v: 'starts', label: 'starts with', tok: 'starts' },
    { v: 'ends', label: 'ends with', tok: 'ends' },
    { v: '==', label: 'is', tok: '==' },
    { v: '!=', label: 'is not', tok: '!=' },
    { v: '=~', label: 'matches regex', tok: '=~' },
    { v: 'tag', label: 'has tag', tok: 'tag' },
    { v: '*', label: 'exists', tok: '*' },
    { v: '>=', label: '≥', tok: '>=' },
    { v: '<=', label: '≤', tok: '<=' },
    { v: '>', label: '>', tok: '>' },
    { v: '<', label: '<', tok: '<' }
  ];
  // The field and operator tables come from the data fork where present (data/fields, data/operators), else the
  // built-ins above. Their `label` members are the UI strings, so they travel with the table.
  if (R) { var _f = R.json('data', 'fields'); if (Array.isArray(_f) && _f.length) FIELDS = _f; var _o = R.json('data', 'operators'); if (Array.isArray(_o) && _o.length) OPS = _o; }
  var NO_CONST = { '*': 1, '!*': 1 };
  var COLS = '34px minmax(160px,1fr) 120px 78px minmax(120px,1.3fr)';   // match | Name | Kind | Size | Location

  // ---- look: cvwm's own tokens and component rules, reproduced for this iframe document ----
  var style = document.createElement('style');
  // The stylesheet from the app fork (styles/query) where present, else the built-in default above.
  style.textContent = R.text('styles', 'query');
  document.head.appendChild(style);

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function btn(cls, txt) { var b = el('button', 'fv-btn' + (cls ? ' ' + cls : ''), txt); b.type = 'button'; return b; }
  function opt(v, label) { var o = el('option'); o.value = v; o.textContent = label; return o; }
  // ---- scope model: groups[] of conditions[] ; each group is one OR-clause of AND-conditions ----
  var groups = [];
  function newCond() { return { field: 'objectName', op: 'contains', metakey: '', value: '' }; }
  function newGroup() { return { conds: [newCond()] }; }
  groups.push(newGroup());

  var scopeRootNs = '';
  var scopeRootLabel = S('everywhere');

  // ---- toolbar ----
  var bar = el('div', 'bar');
  var findInBtn = btn('sm scoperoot', S('find-in-prefix') + scopeRootLabel + '  ▾'); findInBtn.title = S('find-in-title');
  var clrRoot = btn('sm rm', '×'); clrRoot.title = S('clear-root-title'); clrRoot.style.display = 'none';
  var findBtn = btn('find', S('find'));
  var saveBtn = btn('sm', S('save-sf')); saveBtn.title = S('save-sf-title');
  bar.appendChild(el('span', 'lab', S('find'))); bar.appendChild(findInBtn); bar.appendChild(clrRoot);
  bar.appendChild(el('span', 'sp')); bar.appendChild(saveBtn); bar.appendChild(findBtn);

  var scopeEl = el('div', 'scope');

  function selWith(cls, items, value, onchange) {
    var s = el('select', 'fv-in ' + cls);
    items.forEach(function (it) { s.appendChild(opt(it.v, it.label)); });
    s.value = value; s.onchange = function () { onchange(s.value); };
    return s;
  }

  function drawScope() {
    scopeEl.textContent = '';
    groups.forEach(function (g, gi) {
      if (gi > 0) { var od = el('div', 'ordiv'); od.appendChild(el('span', 'ln')); od.appendChild(document.createTextNode(S('or'))); od.appendChild(el('span', 'ln')); scopeEl.appendChild(od); }
      var box = el('div', 'grp');
      box.appendChild(el('div', 'gh', S('match-all')));
      g.conds.forEach(function (c, ci) {
        var row = el('div', 'stmt');
        row.appendChild(el('span', 'join', ci === 0 ? S('where') : S('and')));
        row.appendChild(selWith('field', FIELDS, c.field, function (v) { c.field = v; if (v === 'cvwm_tags' && opOf(c.op).tok !== 'tag') c.op = 'tag'; drawScope(); }));
        if (c.field === '_metakey') {
          var mk = el('input', 'fv-in mkey'); mk.type = 'text'; mk.placeholder = S('metakey-placeholder'); mk.value = c.metakey;
          mk.oninput = function () { c.metakey = mk.value; };
          row.appendChild(mk);
        }
        row.appendChild(selWith('op', OPS, c.op, function (v) { c.op = v; drawScope(); }));
        if (!NO_CONST[c.op]) {
          var val = el('input', 'fv-in val'); val.type = 'text'; val.value = c.value; val.placeholder = S('value-placeholder');
          val.oninput = function () { c.value = val.value; };
          val.onkeydown = function (e) { if (e.key === 'Enter') runFind(); };
          row.appendChild(val);
        } else { row.appendChild(el('span', 'sp')); }
        var rm = btn('sm rm', '–'); rm.title = S('remove');
        rm.onclick = function () {
          g.conds.splice(ci, 1);
          if (g.conds.length === 0) { groups.splice(gi, 1); if (groups.length === 0) groups.push(newGroup()); }
          drawScope();
        };
        row.appendChild(rm);
        box.appendChild(row);
      });
      var addc = btn('sm addc', S('add-and')); addc.style.alignSelf = 'flex-start';
      addc.onclick = function () { g.conds.push(newCond()); drawScope(); };
      box.appendChild(addc);
      scopeEl.appendChild(box);
    });
    var addg = btn('sm addg', S('add-or'));
    addg.onclick = function () { groups.push(newGroup()); drawScope(); };
    scopeEl.appendChild(addg);
  }

  document.body.appendChild(bar);
  document.body.appendChild(scopeEl);
  drawScope();

  function showEngineError(msg) {
    var e = el('div', '', msg); e.style.cssText = 'margin:10px;color:#a00;font:12px var(--mono)';
    document.body.appendChild(e); findBtn.disabled = true;
  }
  (function loadEngine() {
    if (!(R && R.module)) { showEngineError(S('no-engine')); return; }
    R.module('code', 'engine').then(function (mod) {
      engine = (mod.createEngine || mod.default)({
        headers: HDRS, desktop: D, rsrc: R, container: CONTAINER, base: BASE, home: HOME, S: S,
        onBusy: function (b) { findBtn.disabled = b; }
      });
      document.body.appendChild(engine.el);
    }, function (e) { showEngineError(S('no-engine') + ' ' + (e && e.message || e)); });
  })();

  var terms = [];

  // ---- build the scope specification from the groups ----
  function fieldOf(v) { for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].v === v) return FIELDS[i]; return FIELDS[0]; }
  function opOf(v) { for (var i = 0; i < OPS.length; i++) if (OPS[i].v === v) return OPS[i]; return OPS[0]; }
  function exprFor(c) { var o = opOf(c.op); return NO_CONST[o.tok] ? o.tok : o.tok + ' ' + c.value; }
  function mergeExpr(obj, key, expr) {
    if (!(key in obj)) { obj[key] = expr; return; }
    if (Array.isArray(obj[key])) obj[key].push(expr); else obj[key] = [obj[key], expr];
  }
  function buildScope() {
    terms = [];
    var scope = [];
    groups.forEach(function (g) {
      var clause = {}, meta = {}, any = false;
      g.conds.forEach(function (c) {
        var f = fieldOf(c.field), o = opOf(c.op);
        if (!NO_CONST[o.tok] && c.value === '') return;
        if (f.t === 'metakey' && !c.metakey) return;
        var expr = exprFor(c);
        if (!NO_CONST[o.tok] && (o.tok === 'contains' || o.tok === 'starts' || o.tok === 'ends' || o.tok === '==' || o.tok === 'tag')) terms.push(String(c.value).toLowerCase());
        if (f.t === 'top') mergeExpr(clause, f.k, expr);
        else if (f.t === 'meta') mergeExpr(meta, f.k, expr);
        else if (f.t === 'metakey') mergeExpr(meta, c.metakey, expr);
        any = true;
      });
      if (scopeRootNs) clause.parentURI = 'starts ' + scopeRootNs;
      if (Object.keys(meta).length) clause.metadata = meta;
      if (any || scopeRootNs) scope.push(clause);
    });
    return scope;
  }

  // ---- run: hand the built scope (and its collected match terms) to the shared engine ----
  function runFind() { if (engine) engine.run(buildScope(), terms); }

  // ---- Find in: choose a container to scope to (a subtree of this server) ----
  findInBtn.onclick = async function () {
    if (!D.pickObject) return;
    var picked = await D.pickObject({ title: S('find-in-dialog') });
    if (!picked) return;
    var u = String(picked);
    if (u.indexOf(BASE) !== 0) { if (engine) engine.setStatus('err', S('pick-container')); return; }
    var rest = u.slice(BASE.length).split('?')[0];
    if (!/\/$/.test(rest)) rest = rest.replace(/[^/]*$/, '');
    scopeRootNs = '/' + rest;
    scopeRootLabel = scopeRootNs;
    findInBtn.textContent = S('find-in-prefix') + scopeRootLabel + '  ▾';
    clrRoot.style.display = '';
  };
  clrRoot.onclick = function () {
    scopeRootNs = ''; scopeRootLabel = S('everywhere');
    findInBtn.textContent = S('find-in-prefix') + scopeRootLabel + '  ▾';
    clrRoot.style.display = 'none';
  };

  findBtn.onclick = runFind;
  // the engine owns the query queue and cleans it up on unload.

  // ---- Save as Smart Folder: stamp a self-contained container carrying this scope in its cvwm_query metadata, with
  //      the bootstrap and a copy of the engine in its own fork, wherever the user chooses. Opening it re-runs the
  //      scope live. No reference between the folder and this app -- the folder can simply be copied. ----
  function put(url, mimetype, body) {
    return fetch(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': mimetype, Accept: mimetype }, HDRS), credentials: 'same-origin', body: JSON.stringify(body) });
  }
  function okStatus(s) { return s === 200 || s === 201 || s === 202 || s === 204; }
  function putObject(url, mimetype, value, enc) { return put(url, 'application/cdmi-object', { mimetype: mimetype, valuetransferencoding: enc || 'utf-8', value: value, metadata: {} }); }
  async function ensureCont(url) { var r = await put(url, 'application/cdmi-container', { metadata: {} }); return okStatus(r.status) || r.status === 409; }
  async function createSmartFolder(destContainer, name, scope) {
    var bootstrap = R && R.text('code', 'bootstrap');
    var engineSrc = R && R.text('code', 'engine');
    if (!bootstrap || !engineSrc) throw new Error(S('save-no-resources'));
    var dest = slash(destContainer) + encodeURIComponent(name) + '/';
    var r = await put(dest, 'application/cdmi-container', { metadata: { cvwm_query: scope } });   // the folder, carrying the scope
    if (!okStatus(r.status)) throw new Error('create ' + name + ' — HTTP ' + r.status);
    await putObject(dest + 'index.js', 'text/javascript', bootstrap);
    var icon = R && R.dataURL && R.dataURL('icons', 'smartfolder');
    if (icon) await putObject(dest + 'index.png', 'image/png', String(icon).replace(/^data:[^,]*,/, ''), 'base64');
    await ensureCont(dest + 'rsrc/');
    await ensureCont(dest + 'rsrc/code/');
    await putObject(dest + 'rsrc/code/engine', 'text/javascript', engineSrc);
    return dest;
  }
  function openSaveDialog() {
    var scope = buildScope();
    if (!scope.length) { if (engine) engine.setStatus('err', S('save-empty')); return; }
    var loc = HOME || BASE;
    var ov = el('div'); ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:1000';
    var box = el('div'); box.style.cssText = 'background:#bfbfbf;border:2px solid;border-color:rgba(255,255,255,.6) rgba(0,0,0,.55) rgba(0,0,0,.55) rgba(255,255,255,.6);padding:12px;width:360px;max-width:92%;display:flex;flex-direction:column;gap:8px;font:13px Helvetica,Arial,sans-serif';
    box.appendChild(el('div', '', S('save-title')));
    var nameIn = el('input', 'fv-in'); nameIn.type = 'text'; nameIn.placeholder = S('save-name'); nameIn.style.width = '100%'; nameIn.style.boxSizing = 'border-box';
    box.appendChild(nameIn);
    var locRow = el('div'); locRow.style.cssText = 'display:flex;gap:6px;align-items:center';
    var locEl = el('span'); locEl.style.cssText = 'flex:1;font:11px "DejaVu Sans Mono",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; locEl.textContent = loc;
    var chooseBtn = btn('sm', S('save-choose'));
    locRow.appendChild(el('span', '', S('save-in'))); locRow.appendChild(locEl); locRow.appendChild(chooseBtn);
    box.appendChild(locRow);
    var msg = el('div'); msg.style.cssText = 'color:#a00;font:11px "DejaVu Sans Mono",monospace;min-height:14px';
    box.appendChild(msg);
    var row = el('div'); row.style.cssText = 'display:flex;justify-content:flex-end;gap:6px';
    var cancel = btn('sm', S('cancel')); var save = btn('sm', S('save'));
    row.appendChild(cancel); row.appendChild(save); box.appendChild(row);
    ov.appendChild(box); document.body.appendChild(ov); nameIn.focus();
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    cancel.onclick = close;
    chooseBtn.onclick = async function () { if (!D.pickObject) { msg.textContent = S('save-no-picker'); return; } var p = await D.pickObject({ title: S('save-pick') }); if (p) { loc = slash(String(p).split('?')[0]); locEl.textContent = loc; } };
    save.onclick = async function () {
      var nm = (nameIn.value || '').trim().replace(/\/+$/, '');
      if (!nm) { msg.style.color = '#a00'; msg.textContent = S('save-need-name'); return; }
      save.disabled = true; msg.style.color = '#333'; msg.textContent = S('saving');
      try { var dest = await createSmartFolder(loc, nm, scope); close(); if (D.open) D.open(dest); }
      catch (e) { save.disabled = false; msg.style.color = '#a00'; msg.textContent = (e && e.message) || 'failed'; }
    };
    nameIn.onkeydown = function (e) { if (e.key === 'Enter') save.onclick(); else if (e.key === 'Escape') close(); };
  }
  saveBtn.onclick = openSaveDialog;
})();
