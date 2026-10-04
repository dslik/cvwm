/*!
 * queues for cvwm: a manager for CDMI queue objects (application/cdmi-queue). A queue holds values in FIFO order,
 * each with a monotonic designator that is never reused. This app:
 *   - Peek   reads the values non-destructively (GET, oldest -> newest) and lists them; the head (oldest) is marked.
 *   - Enqueue appends a value (POST { value:[v], mimetype:[m], valuetransferencoding:[vte] }). A value can be a typed
 *             string, a CDMI object chosen with the desktop's Open dialog, or a CDMI data object dragged onto this
 *             window (the desktop hands it over via CTX.onObjectDrop -- an iframe cannot see an internal drag itself).
 *   - Dequeue removes the head. It is offered as "Save as...": the head value is written to a container the user
 *             chooses (PUT a data object) and only then removed (DELETE ?values=1). Head-only, per the no-gap rule.
 *   - New / Delete create or delete the queue object itself.
 * All requests carry CTX.headers (the signed-in credential) and go to the queue's own origin.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var HDRS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default below. S() reads a string with optional {token} substitution; the stylesheet is pulled below.
  var R = CTX.rsrc || null;
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var MT_QUEUE = 'application/cdmi-queue', MT_OBJECT = 'application/cdmi-object', MT_CONTAINER = 'application/cdmi-container';

  if (CTX.setTitle) CTX.setTitle(S('title', 'queues'));
  if (CTX.resize) CTX.resize(760, 520);

  // ---- style (house tokens, shared with servers/relationships/namespaces) ----
  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code:#eff1f3;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--head:#8250df;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}' +
    '@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code:#151b23;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--head:#c297ff;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    'body{display:flex;flex-direction:column;}' +
    '.bar{flex:none;display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border);}' +
    '.bar label{font:11px var(--mono);color:var(--muted);flex:none;}' +
    '.bar input{flex:1 1 0;min-width:0;height:28px;box-sizing:border-box;font:12px var(--mono);padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    'button{height:28px;flex:none;padding:0 12px;border:1px solid var(--border);border-radius:6px;background:var(--code);color:var(--fg);cursor:pointer;font-size:12px;}' +
    'button:hover{border-color:var(--accent);}button.go{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600;}button.danger:hover{border-color:var(--err);color:var(--err);}button:disabled{opacity:.5;cursor:default;}' +
    '#enq{flex:none;display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border);background:var(--panel);}' +
    '#enq .hint{font:11px var(--mono);color:var(--muted);flex:none;}' +
    '#list{flex:1;min-height:0;overflow-y:auto;padding:6px 0;}' +
    '.item{display:flex;gap:10px;align-items:flex-start;padding:7px 12px;border-bottom:1px solid var(--border);}' +
    '.item .lead{flex:none;width:66px;display:flex;flex-direction:column;gap:3px;}' +
    '.item .desig{font:600 12px var(--mono);color:var(--fg);}' +
    '.item.head .desig{color:var(--head);}' +
    '.item .badge{font:9px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:#fff;background:var(--head);border-radius:4px;padding:1px 5px;align-self:flex-start;}' +
    '.item .body{flex:1;min-width:0;}' +
    '.item .meta{font:10px var(--mono);color:var(--muted);margin-bottom:2px;}' +
    '.item .val{font:12px var(--mono);white-space:pre-wrap;word-break:break-word;max-height:5.4em;overflow:hidden;}' +
    '.item .act{flex:none;display:flex;flex-direction:column;gap:5px;}' +
    '.empty{color:var(--muted);font:12px var(--mono);padding:20px 14px;text-align:center;}.empty.err{color:var(--err);}' +
    '#status{flex:none;padding:5px 10px;border-top:1px solid var(--border);font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}#status .ok{color:var(--ok);}#status .err{color:var(--err);}' +
    '.over{outline:2px dashed var(--accent);outline-offset:-6px;}' +
    '.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9;}' +
    '.dlg{background:var(--bg);border:1px solid var(--border);border-radius:8px;width:min(460px,92vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.4);}' +
    '.dlg h3{margin:0;padding:10px 14px;font-size:13px;border-bottom:1px solid var(--border);}' +
    '.dlg .cnt{padding:12px 14px;overflow:auto;}' +
    '.dlg .foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--border);}' +
    '.dlg .note{font:11px var(--mono);color:var(--muted);min-height:1em;}.dlg .note.err{color:var(--err);}';
  style.textContent = (R && R.text('styles', 'queues')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }
  function assign(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function esc(s) { return String(s == null ? '' : s); }
  function dirOf(u) { u = String(u || '').replace(/[?#].*$/, ''); return u.slice(0, u.lastIndexOf('/') + 1); }

  // ---- CDMI transport (credential from the desktop; same-origin) ----
  function req(method, url, opts) {
    opts = opts || {};
    var headers = assign(HDRS, {});
    if (opts.accept) headers.Accept = opts.accept;
    if (opts.type) headers['Content-Type'] = opts.type;
    return fetch(url, { method: method, headers: headers, credentials: 'same-origin', body: opts.body });
  }
  async function readJson(res) { var t = await res.text(); try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  async function fail(res) { var j = await readJson(res.clone ? res.clone() : res); return (j && (j.title || j.detail)) || ('HTTP ' + res.status); }

  // ---- header bar ----
  var urlIn = el('input'); urlIn.type = 'text'; urlIn.spellcheck = false; urlIn.placeholder = S('urlPlaceholder', 'queue object URL, e.g. https://host/cdmi/3.0.0/~/work/jobs');
  var bOpen = el('button', null, S('open', 'Open')); var bNew = el('button', null, S('new', 'New…')); var bRefresh = el('button', null, S('refresh', 'Refresh')); var bDelete = el('button', 'danger', S('deleteQueue', 'Delete queue'));
  var bar = el('div', 'bar'); bar.appendChild(el('label', null, S('queueLabel', 'Queue'))); bar.appendChild(urlIn);
  bar.appendChild(bOpen); bar.appendChild(bNew); bar.appendChild(bRefresh); bar.appendChild(bDelete);

  // ---- enqueue bar ----
  var textIn = el('input'); textIn.type = 'text'; textIn.placeholder = S('enqueuePlaceholder', 'type a value to enqueue…'); textIn.style.flex = '1 1 0'; textIn.style.minWidth = '0';
  textIn.style.height = '28px'; textIn.style.boxSizing = 'border-box'; textIn.style.font = '12px var(--mono)'; textIn.style.padding = '0 8px';
  textIn.style.border = '1px solid var(--border)'; textIn.style.borderRadius = '6px'; textIn.style.background = 'var(--bg)'; textIn.style.color = 'var(--fg)';
  var bEnqText = el('button', 'go', S('enqueue', 'Enqueue')); var bEnqObj = el('button', null, S('enqueueObject', 'Enqueue object…'));
  var enq = el('div'); enq.id = 'enq';
  enq.appendChild(el('span', 'hint', S('enqueue', 'Enqueue'))); enq.appendChild(textIn); enq.appendChild(bEnqText); enq.appendChild(bEnqObj);
  enq.appendChild(el('span', 'hint', S('dropHint', '· or drop a data object onto this window')));

  var listEl = el('div'); listEl.id = 'list';
  var statusEl = el('div'); statusEl.id = 'status'; statusEl.textContent = S('statusStart', 'Open or create a queue.');

  document.body.appendChild(bar); document.body.appendChild(enq); document.body.appendChild(listEl); document.body.appendChild(statusEl);

  function setStatus(text, cls) { statusEl.innerHTML = ''; statusEl.appendChild(el('span', cls || '', text)); }

  // ---- state ----
  var queueURL = '';
  var head = null;   // { value, mimetype, vte, designator } of the oldest value, for Save as

  function normURL(u) {
    u = String(u || '').trim(); if (!u) return '';
    try { return new URL(u, CTX.baseURI || CTX.origin).href; } catch (e) { return ''; }
  }
  function homeBase() { return CTX.homeURI || CTX.baseURI || (CTX.origin ? CTX.origin + '/' : ''); }

  // ---- size / preview of a value, by its transfer encoding ----
  function sizeOf(value, vte) {
    try {
      if (vte === 'base64') return atob(value).length;
      if (vte === 'json') return new TextEncoder().encode(JSON.stringify(value)).length;
      return new TextEncoder().encode(String(value)).length;
    } catch (e) { return null; }
  }
  function previewOf(value, vte) {
    if (vte === 'base64') return null;                       // binary: no text preview
    var t = vte === 'json' ? JSON.stringify(value, null, 2) : String(value);
    return t.length > 600 ? t.slice(0, 600) + '…' : t;
  }

  // ---- peek: read the values, non-destructive ----
  async function peek() {
    head = null;
    if (!queueURL) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty', S('emptyOpen', 'Open or create a queue to see its values.'))); refreshButtons(); return; }
    setStatus('Reading ' + queueURL + ' …');
    var res;
    try { res = await req('GET', queueURL + '?objectID&objectName&queueValues&mimetype&value&valuetransferencoding&metadata', { accept: MT_QUEUE }); }
    catch (e) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty err', S('unreachable', 'Could not reach the queue: {e}', { e: e.message }))); setStatus(S('readFailed', 'Read failed'), 'err'); refreshButtons(); return; }
    if (!res.ok) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty err', S('readFailedMsg', 'Read failed: {e}', { e: await fail(res) }))); setStatus(S('readFailed', 'Read failed'), 'err'); refreshButtons(); return; }
    var rep = await readJson(res) || {};
    if (rep.objectType && rep.objectType !== MT_QUEUE) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty err', S('notQueue', 'That object is not a queue ({t}).', { t: rep.objectType }))); setStatus(S('notQueueShort', 'Not a queue'), 'err'); refreshButtons(); return; }
    render(rep);
  }

  function render(rep) {
    listEl.innerHTML = '';
    var values = Array.isArray(rep.value) ? rep.value : [];
    var mimes = Array.isArray(rep.mimetype) ? rep.mimetype : [];
    var vtes = Array.isArray(rep.valuetransferencoding) ? rep.valuetransferencoding : [];
    var span = typeof rep.queueValues === 'string' ? rep.queueValues : '';
    var lo = span ? parseInt(span.split('-')[0], 10) : null;
    var hi = span ? parseInt(span.split('-')[1] || span.split('-')[0], 10) : null;

    if (!values.length) {
      listEl.appendChild(el('div', 'empty', S('emptyQueue', 'The queue is empty. Enqueue a value, or drop an object onto this window.')));
    } else {
      values.forEach(function (v, i) {
        var vte = vtes[i] || 'utf-8', mime = mimes[i] || 'application/octet-stream';
        var isHead = i === 0;
        var item = el('div', 'item' + (isHead ? ' head' : ''));
        var lead = el('div', 'lead');
        lead.appendChild(el('div', 'desig', lo != null ? '#' + (lo + i) : '#' + (i + 1)));
        if (isHead) lead.appendChild(el('span', 'badge', S('head', 'head')));
        item.appendChild(lead);
        var bodyEl = el('div', 'body');
        var sz = sizeOf(v, vte);
        bodyEl.appendChild(el('div', 'meta', mime + ' · ' + vte + (sz != null ? ' · ' + sz + ' B' : '')));
        var prev = previewOf(v, vte);
        bodyEl.appendChild(el('div', 'val', prev != null ? prev : '(binary, ' + (sz != null ? sz + ' bytes' : 'value') + ')'));
        item.appendChild(bodyEl);
        if (isHead) {
          head = { value: v, mimetype: mime, vte: vte, designator: lo };
          var act = el('div', 'act');
          var bSave = el('button', null, S('saveAs', 'Save as…'));
          bSave.addEventListener('click', function () { saveAsDialog(head); });
          var bDel = el('button', 'danger', S('delete', 'Delete'));
          bDel.addEventListener('click', function () { deleteHead(head); });
          act.appendChild(bSave); act.appendChild(bDel); item.appendChild(act);
        }
        listEl.appendChild(item);
      });
    }
    setStatus(values.length + ' ' + (values.length === 1 ? S('valueSingular', 'value') : S('valuePlural', 'values')) + (span ? ' · designators ' + lo + '–' + hi : '') + ' · ' + queueURL, values.length ? 'ok' : '');
    refreshButtons();
  }

  function refreshButtons() {
    var has = !!queueURL;
    bRefresh.disabled = !has; bDelete.disabled = !has; bEnqText.disabled = !has; bEnqObj.disabled = !has;
  }

  // ---- enqueue ----
  async function enqueue(value, mimetype, vte, label) {
    if (!queueURL) { setStatus(S('openFirst', 'Open or create a queue first.'), 'err'); return false; }
    setStatus(S('enqueueing', 'Enqueueing …'));
    var body = JSON.stringify({ value: [value], mimetype: [mimetype], valuetransferencoding: [vte] });
    var res;
    try { res = await req('POST', queueURL, { type: MT_QUEUE, accept: MT_QUEUE, body: body }); }
    catch (e) { setStatus(S('enqueueFailed', 'Enqueue failed: {e}', { e: e.message }), 'err'); return false; }
    if (!res.ok) { setStatus(S('enqueueFailed', 'Enqueue failed: {e}', { e: await fail(res) }), 'err'); return false; }
    setStatus(S('enqueued', 'Enqueued {label}', { label: label || S('valueSingular', 'value') }), 'ok');
    await peek();
    return true;
  }

  // Read a CDMI data object's value and enqueue it (used by the object picker and by a dropped object).
  async function enqueueObject(objURL) {
    setStatus('Reading ' + objURL + ' …');
    var res;
    try { res = await req('GET', objURL + '?mimetype&valuetransferencoding&value', { accept: MT_OBJECT }); }
    catch (e) { setStatus(S('readObjFailed', 'Could not read the object: {e}', { e: e.message }), 'err'); return; }
    if (!res.ok) { setStatus(S('readObjFailed', 'Could not read the object: {e}', { e: await fail(res) }), 'err'); return; }
    var rep = await readJson(res) || {};
    var vte = rep.valuetransferencoding || 'utf-8', mime = typeof rep.mimetype === 'string' ? rep.mimetype : 'application/octet-stream';
    var value = rep.value;
    if (value === undefined || value === null) { setStatus(S('noValue', 'That object has no value to enqueue.'), 'err'); return; }
    if (vte === 'json') { value = JSON.stringify(value); vte = 'utf-8'; }     // carry a json value as its text
    var name = decodeURIComponent(String(objURL).replace(/[?#].*$/, '').replace(/\/$/, '').split('/').pop() || 'object');
    await enqueue(value, mime, vte, name);
  }

  // The desktop hands over a data object dragged onto this window (see cvwm.js onObjectDrop).
  CTX.objectDropHint = 'Enqueue';
  CTX.onObjectDrop = function (info) {
    if (!info || !info.url) return;
    if (info.kind && info.kind !== 'object') { setStatus(S('onlyDataObjects', 'Only data objects can be enqueued.'), 'err'); return; }
    enqueueObject(info.url);
  };

  bEnqText.addEventListener('click', function () {
    var t = textIn.value; if (t === '') { setStatus(S('typeValue', 'Type a value to enqueue.'), 'err'); return; }
    enqueue(t, 'text/plain', 'utf-8', 'text').then(function (ok) { if (ok) textIn.value = ''; });
  });
  textIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') bEnqText.click(); });
  bEnqObj.addEventListener('click', function () {
    if (!D.pickObject) { setStatus(S('noOpenDialog', 'The Open dialog is not available.'), 'err'); return; }
    D.pickObject({ title: S('enqueueObjectTitle', 'Enqueue object') }).then(function (u) { if (u) enqueueObject(u); });
  });

  // ---- dequeue via Save as: pick a destination with the desktop's standard dialog, write the head value there,
  //      then DELETE ?values=1. Same dialog (save mode) the New button uses, for consistency. ----
  function saveAsDialog(hv) {
    if (!D.pickObject) { setStatus(S('noOpenDialog', 'The Open dialog is not available.'), 'err'); return; }
    D.pickObject({ mode: 'save', title: S('saveHeadTitle', 'Save head value as'), saveLabel: S('saveDequeueLabel', 'Save & dequeue'),
      name: 'queue-' + (hv.designator != null ? hv.designator : Date.now()), namePlaceholder: 'object name',
      startURI: dirOf(queueURL) || homeBase() }).then(function (destURL) { if (destURL) saveAndDequeue(hv, destURL); });
  }
  // Remove the head value. A CDMI dequeue names the values to remove by a range of designators beginning at the
  // oldest (a bare count is refused, and the no-gap rule requires it start at the oldest), so the head, designator
  // d, is removed by "?values=d-d". Returns the response.
  function dequeueHead(designator) {
    return req('DELETE', queueURL + '?values=' + designator + '-' + designator, { accept: MT_QUEUE });
  }

  async function saveAndDequeue(hv, destURL) {
    destURL = String(destURL).replace(/[?#].*$/, '');
    if (hv.designator == null) { setStatus(S('noDesignator', 'The head has no designator to remove.'), 'err'); return; }
    setStatus(S('savingTo', 'Saving head value to {u} …', { u: destURL }));
    var objBody = { mimetype: hv.mimetype, valuetransferencoding: hv.vte, value: hv.value, metadata: {} };
    var put;
    try { put = await req('PUT', destURL, { type: MT_OBJECT, accept: MT_OBJECT, body: JSON.stringify(objBody) }); }
    catch (e) { setStatus(S('saveFailed', 'Save failed: {e}', { e: e.message }), 'err'); return; }
    if (!(put.status === 201 || put.status === 202 || put.status === 204)) { setStatus(S('saveFailed', 'Save failed: {e}', { e: await fail(put) }), 'err'); return; }
    // Only now remove the head from the queue.
    var del;
    try { del = await dequeueHead(hv.designator); }
    catch (e) { setStatus(S('savedDequeueFailed', 'Saved to {u}, but dequeue failed: {e} (value is now in both places).', { u: destURL, e: e.message }), 'err'); return; }
    if (!(del.status === 200 || del.status === 204)) { setStatus(S('savedDequeueFailed', 'Saved to {u}, but dequeue failed: {e} (value is now in both places).', { u: destURL, e: await fail(del) }), 'err'); return; }
    setStatus(S('savedAndDequeued', 'Saved to {u} and dequeued the head', { u: destURL }), 'ok'); peek();
  }

  // Delete the oldest value outright (no save), with a confirm.
  function deleteHead(hv) {
    if (hv.designator == null) { setStatus(S('noDesignator', 'The head has no designator to remove.'), 'err'); return; }
    var overlay = el('div', 'modal'), dlg = el('div', 'dlg');
    dlg.appendChild(el('h3', null, S('deleteOldest', 'Delete oldest value')));
    var cnt = el('div', 'cnt'); cnt.appendChild(el('div', 'note', S('deleteOldestNote', 'Remove the head value (#{d}) from the queue without saving it? This cannot be undone.', { d: hv.designator }))); dlg.appendChild(cnt);
    var foot = el('div', 'foot'), c = el('button', null, S('cancel', 'Cancel')), del = el('button', 'danger', S('delete', 'Delete')); foot.appendChild(c); foot.appendChild(del); dlg.appendChild(foot);
    overlay.appendChild(dlg); document.body.appendChild(overlay);
    c.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    del.addEventListener('click', async function () {
      del.disabled = true;
      var res;
      try { res = await dequeueHead(hv.designator); }
      catch (e) { overlay.remove(); setStatus(S('deleteFailed', 'Delete failed: {e}', { e: e.message }), 'err'); return; }
      if (!(res.status === 200 || res.status === 204)) { overlay.remove(); setStatus(S('deleteFailed', 'Delete failed: {e}', { e: await fail(res) }), 'err'); return; }
      overlay.remove(); setStatus(S('deletedOldest', 'Deleted the oldest value (#{d})', { d: hv.designator }), 'ok'); peek();
    });
  }

  // ---- open / new / delete ----
  function open(u) { var n = normURL(u); if (!n) { setStatus(S('invalidUrl', 'That is not a valid URL.'), 'err'); return; } queueURL = n.replace(/[?#].*$/, ''); urlIn.value = queueURL; peek(); }
  urlIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') open(urlIn.value); });   // paste-a-URL convenience
  bRefresh.addEventListener('click', peek);

  // Open uses the desktop's standard Open dialog to choose an existing queue object; open() then checks the type.
  bOpen.addEventListener('click', function () {
    if (!D.pickObject) { open(urlIn.value); return; }
    D.pickObject({ title: S('openQueueTitle', 'Open queue'), startURI: queueURL || CTX.startURI || homeBase() }).then(function (u) { if (u) open(u); });
  });

  async function createQueue(target) {
    target = String(target || '').replace(/[?#].*$/, '');
    if (!target || /\/$/.test(target)) { setStatus(S('noTrailingSlash', 'A queue name has no trailing "/" (that is a container).'), 'err'); return; }
    setStatus(S('creating', 'Creating queue {u} …', { u: target }));
    var res;
    try { res = await req('PUT', target, { type: MT_QUEUE, accept: MT_QUEUE, body: JSON.stringify({ metadata: {} }) }); }
    catch (e) { setStatus(S('createFailed', 'Create failed: {e}', { e: e.message }), 'err'); return; }
    if (!(res.status === 201 || res.status === 202 || res.status === 204)) { setStatus(S('createFailed', 'Create failed: {e}', { e: await fail(res) }), 'err'); return; }
    queueURL = target; urlIn.value = target; setStatus(S('created', 'Created {u}', { u: target }), 'ok'); peek();
  }

  // New uses the same dialog in "save" mode: choose a container and name the queue object to create.
  bNew.addEventListener('click', function () {
    if (!D.pickObject) { setStatus(S('noOpenDialog', 'The Open dialog is not available.'), 'err'); return; }
    D.pickObject({ mode: 'save', title: S('newQueueTitle', 'New queue'), saveLabel: S('create', 'Create'), name: 'queue', namePlaceholder: S('newQueueName', 'new queue name'), startURI: dirOf(queueURL) || homeBase() })
      .then(function (u) { if (u) createQueue(u); });
  });

  bDelete.addEventListener('click', function () {
    if (!queueURL) return;
    var overlay = el('div', 'modal'); var dlg = el('div', 'dlg');
    dlg.appendChild(el('h3', null, S('deleteQueueTitle', 'Delete queue')));
    var cnt = el('div', 'cnt'); cnt.appendChild(el('div', 'note', S('deleteQueueNote', 'Delete the queue object {u} and every value it holds? This cannot be undone.', { u: queueURL }))); dlg.appendChild(cnt);
    var foot = el('div', 'foot'); var c = el('button', null, S('cancel', 'Cancel')); var del = el('button', 'danger', S('delete', 'Delete')); foot.appendChild(c); foot.appendChild(del); dlg.appendChild(foot);
    overlay.appendChild(dlg); document.body.appendChild(overlay);
    c.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    del.addEventListener('click', async function () {
      del.disabled = true;
      var res;
      try { res = await req('DELETE', queueURL, { accept: MT_QUEUE }); }
      catch (e) { overlay.remove(); setStatus(S('deleteFailed', 'Delete failed: {e}', { e: e.message }), 'err'); return; }
      if (!(res.status === 200 || res.status === 204)) { overlay.remove(); setStatus(S('deleteFailed', 'Delete failed: {e}', { e: await fail(res) }), 'err'); return; }
      overlay.remove(); var gone = queueURL; queueURL = ''; head = null; urlIn.value = ''; listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty', S('deletedQueueEmpty', 'Deleted {u}. Open or create a queue.', { u: gone }))); setStatus(S('deletedQueue', 'Deleted {u}', { u: gone }), 'ok'); refreshButtons();
    });
  });

  // ---- start ----
  if (CTX.startURI) { open(CTX.startURI); } else { urlIn.value = ''; refreshButtons(); peek(); }
})();
