/*!
 * engine.js — the shared "run a CDMI query scope and show its results" engine for cvwm.
 *
 * A CDMI query is run by a query queue: a queue object carrying cdmi_queue_type = "cdmi_query_queue", a
 * cdmi_scope_specification (the objects to match) and a cdmi_results_specification (the fields each result carries).
 * The server walks its namespace, enqueues one value per matching object, and reports progress in cdmi_query_status
 * (Processing -> Current when done). This module creates that queue inside a given container, polls it, and renders
 * the matches as a cvwm list view; a double-click opens a result via the desktop.
 *
 * It is a resource (code/engine) so it can be shared by its two hosts without a reference between them, each carrying
 * its own copy in its fork: the query app (which builds a scope interactively and hands it here to run) and a smart
 * folder (an ordinary container whose index.js reads a saved scope from its own metadata and runs it here). Because
 * the engine travels in the fork, a smart folder is self-contained and can simply be copied.
 *
 * createEngine(cfg) -> { el, run(scope, terms), setStatus, destroy }
 *   cfg: { headers, desktop, rsrc, container, base, home, S?, onBusy? }
 *     headers   request headers (auth) to send with every call
 *     desktop   CTX.desktop (for open())
 *     rsrc      CTX.rsrc or null (icons/strings overrides; the engine has built-in fallbacks)
 *     container the container the query queue is created inside (writable)
 *     base      the disk base the host is on (fallback binding root for resolving results)
 *     home      the user's home base, or null (a read-only container falls back to a hidden queue there)
 *     S         optional string lookup S(id, fallback); one is built from rsrc when omitted
 *     onBusy    optional callback(bool) while a query runs (so a host can disable its Find button)
 */
export function createEngine(cfg) {
  cfg = cfg || {};
  var HDRS = cfg.headers || {};
  var D = cfg.desktop || {};
  var R = cfg.rsrc || null;
  var onBusy = typeof cfg.onBusy === 'function' ? cfg.onBusy : function () {};
  var MT_QUEUE = 'application/cdmi-queue', MT_CONTAINER = 'application/cdmi-container';
  function slash(u) { return u && !/\/$/.test(u) ? u + '/' : u; }
  var CONTAINER = slash(cfg.container || cfg.base || '');
  var BASE = slash(cfg.base || CONTAINER);
  var HOME = cfg.home ? slash(cfg.home) : null;
  var QNAME = '.cvwm-query';
  var qcont = CONTAINER, qurl = qcont + QNAME;
  var bindingRoot = BASE;
  var S = typeof cfg.S === 'function' ? cfg.S : function (id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; };

  var COLS = '34px minmax(160px,1fr) 120px 78px minmax(120px,1.3fr)';   // match | Name | Kind | Size | Location
  var ENGINE_CSS =
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);' +
    '--line:rgba(0,0,0,.28);--panel:#b4b4b4;--muted:#555;' +
    '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace}' +
    '.fv-btn{min-width:0;height:28px;padding:0 12px;background:var(--grey);font:700 13px var(--sans);color:#000;border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt);white-space:nowrap}' +
    '.fv-btn:active{border-color:var(--dk) var(--lt) var(--lt) var(--dk)}' +
    '.fv-btn:focus-visible{outline:1px solid #000;outline-offset:2px}' +
    '.fv-btn.sm{height:22px;padding:0 8px;font-size:12px}' +
    '.fv-btn:disabled{color:#7a7a7a;text-shadow:1px 1px 0 rgba(255,255,255,.6)}' +
    '.fv-in{height:26px;padding:0 6px;background:#fff;color:#000;font:13px var(--mono);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);box-sizing:border-box}' +
    '.fv-in:focus{outline:1px solid #000}' +
    '.eng{flex:1;min-height:0;display:flex;flex-direction:column}' +
    '.res{flex:1;min-height:0;background:#fff;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);margin:0 6px;display:flex;flex-direction:column;overflow:hidden}' +
    '.lhead{display:grid;grid-template-columns:' + COLS + ';align-items:center;column-gap:8px;padding:0 8px;position:sticky;top:0;z-index:1;background:var(--grey);border-bottom:1px solid var(--dk);height:22px;flex:none}' +
    '.lhead>div{font:700 11px var(--sans);color:#000;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lhead .num{text-align:right}' +
    '.rows{flex:1;overflow:auto}' +
    '.item{display:grid;grid-template-columns:' + COLS + ';align-items:center;column-gap:8px;padding:0 8px;height:22px;border-bottom:1px solid #eee;cursor:default}' +
    '.item>span{font:12px/22px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.item .nm{display:flex;align-items:center;gap:5px;min-width:0}.item .nm span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.item .num{text-align:right}.item .loc{color:#555}' +
    '.item.sel{background:#000}.item.sel span{color:#fff}.item.sel .loc{color:#cfcfcf}.item.sel svg{filter:invert(1)}' +
    '.ic{width:16px;height:16px;flex:none}' +
    '.rel{display:flex;align-items:center}.rel .barfill{width:100%;height:3px;background:#7fb0d8;border:1px solid #4d7ea6;border-radius:2px}.item.sel .rel .barfill{background:#fff;border-color:#fff}' +
    '.empty{padding:14px;color:#8a8a8a;font:12px var(--mono)}' +
    '.foot{flex:none;border-top:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:5px 8px;display:flex;align-items:center;gap:10px;font:11px var(--sans);color:#333}' +
    '.foot .path{font:11px var(--mono);color:#222;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.foot .cnt{font-weight:700}' +
    '.foot .st{font-weight:700}.foot .st.run{color:#8a5a00}.foot .st.ok{color:#2a7d3a}.foot .st.err{color:#a00}';
  if (!document.getElementById('cvwm-engine-css')) {
    var st = document.createElement('style'); st.id = 'cvwm-engine-css'; st.textContent = ENGINE_CSS; document.head.appendChild(st);
  }

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function assign(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function enc(s) { return encodeURIComponent(s); }
  function req(method, url, o) {
    o = o || {}; var h = assign(HDRS, {});
    if (o.accept) h.Accept = o.accept;
    if (o.type) h['Content-Type'] = o.type;
    return fetch(url, { method: method, headers: h, credentials: 'same-origin', body: o.body });
  }
  async function readJson(res) { var t = await res.text(); try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  async function failText(res) { var j = await readJson(res); return (j && (j.title || j.detail)) || ('HTTP ' + res.status); }

  // ---- kind/size/url helpers over a result representation ----
  function isContainer(r) { return /cdmi-container/.test(r.objectType || '') || /\/$/.test(r.objectName || ''); }
  function isQueue(r) { return /cdmi-queue/.test(r.objectType || ''); }
  function kindOf(r) {
    if (isContainer(r)) return S('kind-container', 'Container');
    if (isQueue(r)) return S('kind-queue', 'Queue');
    var n = (r.objectName || ''), dot = n.lastIndexOf('.');
    if (dot > 0) return n.slice(dot + 1).toUpperCase() + S('kind-file-suffix', ' file');
    return S('kind-data', 'Data object');
  }
  function human(bytes) {
    var n = +bytes; if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }
  function urlOf(r) {
    var parent = typeof r.parentURI === 'string' ? r.parentURI : '';
    var name = (r.objectName || '').replace(/\/$/, '');
    var segs = parent.split('/').filter(Boolean).map(enc);
    return bindingRoot + (segs.length ? segs.join('/') + '/' : '') + enc(name) + (isContainer(r) ? '/' : '');
  }
  function iconSvg(r) {
    var kind = isContainer(r) ? 'container' : isQueue(r) ? 'queue' : 'object';
    var fork = R && R.text('icons', kind); if (fork) return fork;        // icons/<kind> where present
    if (kind === 'container') return '<svg class="ic" viewBox="0 0 16 16"><path d="M1 4h5l1.5 1.5H15V14H1z" fill="#e6c14a" stroke="#9a7d1e"/></svg>';
    if (kind === 'queue') return '<svg class="ic" viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="8" rx="1" fill="#cfe0f2" stroke="#4d7ea6"/><path d="M5 8h6M9 6l2 2-2 2" fill="none" stroke="#2a5f8a"/></svg>';
    return '<svg class="ic" viewBox="0 0 16 16"><path d="M3 1h7l3 3v11H3z" fill="#fff" stroke="#7a7a7a"/><path d="M10 1v3h3" fill="none" stroke="#7a7a7a"/><path d="M5 7h6M5 9h6M5 11h4" stroke="#aaa"/></svg>';
  }

  var terms = [];
  function relevance(r) {
    var name = (r.objectName || '').toLowerCase();
    if (!terms.length) return 0.6;
    var best = 0;
    terms.forEach(function (t) {
      if (!t) return;
      if (name.indexOf(t) >= 0) best = Math.max(best, Math.min(1, 0.55 + (t.length / Math.max(name.length, t.length)) * 0.45));
    });
    return best || 0.4;
  }

  // ---- results view ----
  var wrap = el('div', 'eng');
  var res = el('div', 'res');
  var head = el('div', 'lhead');
  head.appendChild(el('div', '', ' '));
  head.appendChild(el('div', '', S('col-name', 'Name')));
  head.appendChild(el('div', '', S('col-kind', 'Kind')));
  head.appendChild(el('div', 'num', S('col-size', 'Size')));
  head.appendChild(el('div', '', S('col-location', 'Location')));
  var rowsEl = el('div', 'rows');
  res.appendChild(head); res.appendChild(rowsEl);
  var foot = el('div', 'foot');
  var cntEl = el('span', 'cnt', S('ready', 'Ready')); var pathEl = el('span', 'path', ''); var stEl = el('span', 'st', '');
  foot.appendChild(cntEl); foot.appendChild(pathEl); foot.appendChild(stEl);
  wrap.appendChild(res); wrap.appendChild(foot);

  function setStatus(cls, text) { stEl.className = 'st ' + (cls || ''); stEl.textContent = text || ''; }

  var RESULTS = { objectName: '', parentURI: '', objectType: '', metadata: { cdmi_size: '', cdmi_mtime: '' } };

  // ---- run a query: (re)create the queue, poll status, read results ----
  var polling = null, lastResults = [];
  async function ensureContainer(url) {
    var r = await req('PUT', url, { type: MT_CONTAINER, accept: MT_CONTAINER, body: JSON.stringify({ metadata: {} }) });
    return r.ok || r.status === 409;
  }
  async function createQueue(scope) {
    var body = JSON.stringify({ metadata: { cdmi_queue_type: 'cdmi_query_queue', cdmi_scope_specification: scope, cdmi_results_specification: RESULTS } });
    var r = await req('PUT', qurl, { type: MT_QUEUE, accept: MT_QUEUE, body: body });
    if ((r.status === 403 || r.status === 401) && HOME && qcont !== HOME + '.cvwm/') {
      qcont = HOME + '.cvwm/'; qurl = qcont + QNAME;
      await ensureContainer(qcont);
      r = await req('PUT', qurl, { type: MT_QUEUE, accept: MT_QUEUE, body: body });
    }
    return r;
  }
  function deleteQueue() { return req('DELETE', qurl).catch(function () {}); }

  // The binding root the query runs against, from the queue itself: the full URL we created the queue at, minus the
  // queue's own server-reported parentURI + objectName. Every result's parentURI is a path relative to this root, so
  // the object's URL is bindingRoot + parentURI + objectName -- correct even when a home is mounted as a sub-path.
  async function deriveBindingRoot() {
    try {
      var r = await req('GET', qurl + '?objectName&parentURI', { accept: MT_QUEUE });
      if (!r.ok) return;
      var q = await readJson(r) || {};
      var parent = typeof q.parentURI === 'string' ? q.parentURI : '';
      var name = q.objectName || '';
      if (!name) return;
      var suffix = parent.replace(/^\//, '') + name;
      var full = decodeURI(qurl.split('?')[0]);
      if (suffix && full.slice(-suffix.length) === suffix) bindingRoot = slash(full.slice(0, full.length - suffix.length));
    } catch (e) {}
  }

  async function run(scope, scopeTerms) {
    terms = Array.isArray(scopeTerms) ? scopeTerms : [];
    if (polling) { clearTimeout(polling); polling = null; }
    if (!scope || !scope.length) { setStatus('err', S('add-condition', 'add a condition')); cntEl.textContent = S('nothing-to-search', 'Nothing to search for'); return; }
    rowsEl.textContent = ''; lastResults = []; pathEl.textContent = ''; cntEl.textContent = S('searching', 'Searching…'); setStatus('run', S('st-searching', '● searching'));
    onBusy(true);
    await deleteQueue();
    var r = await createQueue(scope);
    if (!r.ok) { onBusy(false); setStatus('err', '● ' + (await failText(r))); cntEl.textContent = S('query-not-created', 'Query not created'); return; }
    await deriveBindingRoot();
    poll(Date.now() + 30000);
  }

  async function poll(deadline) {
    var r = await req('GET', qurl + '?metadata=cdmi_query_status&queueValues&value&valuetransferencoding', { accept: MT_QUEUE });
    if (!r.ok) { onBusy(false); setStatus('err', '● ' + (await failText(r))); return; }
    var q = await readJson(r) || {};
    var status = (q.metadata && q.metadata.cdmi_query_status) || 'Processing';
    render(Array.isArray(q.value) ? q.value : []);
    if (status === 'Current' || status === 'Halted' || status === 'Error' || Date.now() > deadline) {
      onBusy(false); polling = null;
      if (status === 'Error') setStatus('err', S('st-error', '● query error'));
      else if (status === 'Halted') setStatus('ok', S('st-stopped', '● stopped'));
      else if (Date.now() > deadline && status !== 'Current') setStatus('err', S('st-timeout', '● timed out'));
      else setStatus('ok', S('st-complete', '● complete'));
      cntEl.textContent = lastResults.length + (lastResults.length === 1 ? S('found-one', ' item found') : S('found-many', ' items found'));
      return;
    }
    polling = setTimeout(function () { poll(deadline); }, 300);
  }

  var selectedRow = null;
  function render(values) {
    var reps = [];
    values.forEach(function (s) { try { var o = JSON.parse(s); if (o && typeof o === 'object') reps.push(o); } catch (e) {} });
    reps.forEach(function (r) { r.__rel = relevance(r); });
    reps.sort(function (a, b) { return b.__rel - a.__rel; });
    lastResults = reps;
    cntEl.textContent = reps.length + (reps.length === 1 ? S('found-one', ' item found') : S('found-many', ' items found'));
    rowsEl.textContent = ''; selectedRow = null;
    if (!reps.length) { rowsEl.appendChild(el('div', 'empty', S('no-matches', 'No matching objects.'))); return; }
    reps.forEach(function (r) {
      var url = urlOf(r);
      var row = el('div', 'item');
      var rel = el('div', 'rel'); var fill = el('div', 'barfill'); fill.style.width = Math.round(r.__rel * 100) + '%'; rel.appendChild(fill); row.appendChild(rel);
      var nm = el('div', 'nm'); nm.innerHTML = iconSvg(r); nm.appendChild(el('span', '', (r.objectName || '').replace(/\/$/, ''))); row.appendChild(nm);
      row.appendChild(el('span', '', kindOf(r)));
      row.appendChild(el('span', 'num', isContainer(r) ? '' : human(r.metadata && r.metadata.cdmi_size)));
      row.appendChild(el('span', 'loc', r.parentURI || '/'));
      row.onclick = function () { if (selectedRow) selectedRow.classList.remove('sel'); selectedRow = row; row.classList.add('sel'); pathEl.textContent = (r.parentURI || '/') + (r.objectName || '') + S('dblclick-hint', '  ·  double-click to open'); };
      row.ondblclick = function () { try { if (D.open) D.open(url); } catch (e) {} };
      rowsEl.appendChild(row);
    });
  }

  function destroy() { if (polling) { clearTimeout(polling); polling = null; } deleteQueue(); }
  window.addEventListener('beforeunload', function () { deleteQueue(); });

  return { el: wrap, run: run, setStatus: setStatus, destroy: destroy, getBindingRoot: function () { return bindingRoot; } };
}

export default createEngine;
