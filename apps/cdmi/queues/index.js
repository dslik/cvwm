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
  function S(id, vars) {
    var v = R && R.text('strings', id); if (v == null) return id;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var MT_QUEUE = 'application/cdmi-queue', MT_OBJECT = 'application/cdmi-object', MT_CONTAINER = 'application/cdmi-container';

  if (CTX.setTitle) CTX.setTitle(S('title'));
  if (CTX.resize) CTX.resize(760, 520);

  // ---- style (house tokens, shared with servers/relationships/namespaces) ----
  var style = document.createElement('style');
  style.textContent = R.text('styles', 'queues');
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
  var urlIn = el('input'); urlIn.type = 'text'; urlIn.spellcheck = false; urlIn.placeholder = S('urlPlaceholder');
  var bOpen = el('button', null, S('open')); var bNew = el('button', null, S('new')); var bRefresh = el('button', null, S('refresh')); var bDelete = el('button', 'danger', S('deleteQueue'));
  var bar = el('div', 'bar'); bar.appendChild(el('label', null, S('queueLabel'))); bar.appendChild(urlIn);
  bar.appendChild(bOpen); bar.appendChild(bNew); bar.appendChild(bRefresh); bar.appendChild(bDelete);

  // ---- enqueue bar ----
  var textIn = el('input'); textIn.type = 'text'; textIn.placeholder = S('enqueuePlaceholder'); textIn.style.flex = '1 1 0'; textIn.style.minWidth = '0';
  textIn.style.height = '28px'; textIn.style.boxSizing = 'border-box'; textIn.style.font = '12px var(--mono)'; textIn.style.padding = '0 8px';
  textIn.style.border = '1px solid var(--border)'; textIn.style.borderRadius = '6px'; textIn.style.background = 'var(--bg)'; textIn.style.color = 'var(--fg)';
  var bEnqText = el('button', 'go', S('enqueue')); var bEnqObj = el('button', null, S('enqueueObject'));
  var enq = el('div'); enq.id = 'enq';
  enq.appendChild(el('span', 'hint', S('enqueue'))); enq.appendChild(textIn); enq.appendChild(bEnqText); enq.appendChild(bEnqObj);
  enq.appendChild(el('span', 'hint', S('dropHint')));

  var listEl = el('div'); listEl.id = 'list';
  var statusEl = el('div'); statusEl.id = 'status'; statusEl.textContent = S('statusStart');

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
    if (!queueURL) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty', S('emptyOpen'))); refreshButtons(); return; }
    setStatus('Reading ' + queueURL + ' …');
    var res;
    try { res = await req('GET', queueURL + '?objectID&objectName&queueValues&mimetype&value&valuetransferencoding&metadata', { accept: MT_QUEUE }); }
    catch (e) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty err', S('unreachable', { e: e.message }))); setStatus(S('readFailed'), 'err'); refreshButtons(); return; }
    if (!res.ok) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty err', S('readFailedMsg', { e: await fail(res) }))); setStatus(S('readFailed'), 'err'); refreshButtons(); return; }
    var rep = await readJson(res) || {};
    if (rep.objectType && rep.objectType !== MT_QUEUE) { listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty err', S('notQueue', { t: rep.objectType }))); setStatus(S('notQueueShort'), 'err'); refreshButtons(); return; }
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
      listEl.appendChild(el('div', 'empty', S('emptyQueue')));
    } else {
      values.forEach(function (v, i) {
        var vte = vtes[i] || 'utf-8', mime = mimes[i] || 'application/octet-stream';
        var isHead = i === 0;
        var item = el('div', 'item' + (isHead ? ' head' : ''));
        var lead = el('div', 'lead');
        lead.appendChild(el('div', 'desig', lo != null ? '#' + (lo + i) : '#' + (i + 1)));
        if (isHead) lead.appendChild(el('span', 'badge', S('head')));
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
          var bSave = el('button', null, S('saveAs'));
          bSave.addEventListener('click', function () { saveAsDialog(head); });
          var bDel = el('button', 'danger', S('delete'));
          bDel.addEventListener('click', function () { deleteHead(head); });
          act.appendChild(bSave); act.appendChild(bDel); item.appendChild(act);
        }
        listEl.appendChild(item);
      });
    }
    setStatus(values.length + ' ' + (values.length === 1 ? S('valueSingular') : S('valuePlural')) + (span ? ' · designators ' + lo + '–' + hi : '') + ' · ' + queueURL, values.length ? 'ok' : '');
    refreshButtons();
  }

  function refreshButtons() {
    var has = !!queueURL;
    bRefresh.disabled = !has; bDelete.disabled = !has; bEnqText.disabled = !has; bEnqObj.disabled = !has;
  }

  // ---- enqueue ----
  async function enqueue(value, mimetype, vte, label) {
    if (!queueURL) { setStatus(S('openFirst'), 'err'); return false; }
    setStatus(S('enqueueing'));
    var body = JSON.stringify({ value: [value], mimetype: [mimetype], valuetransferencoding: [vte] });
    var res;
    try { res = await req('POST', queueURL, { type: MT_QUEUE, accept: MT_QUEUE, body: body }); }
    catch (e) { setStatus(S('enqueueFailed', { e: e.message }), 'err'); return false; }
    if (!res.ok) { setStatus(S('enqueueFailed', { e: await fail(res) }), 'err'); return false; }
    setStatus(S('enqueued', { label: label || S('valueSingular') }), 'ok');
    await peek();
    return true;
  }

  // Read a CDMI data object's value and enqueue it (used by the object picker and by a dropped object).
  async function enqueueObject(objURL) {
    setStatus('Reading ' + objURL + ' …');
    var res;
    try { res = await req('GET', objURL + '?mimetype&valuetransferencoding&value', { accept: MT_OBJECT }); }
    catch (e) { setStatus(S('readObjFailed', { e: e.message }), 'err'); return; }
    if (!res.ok) { setStatus(S('readObjFailed', { e: await fail(res) }), 'err'); return; }
    var rep = await readJson(res) || {};
    var vte = rep.valuetransferencoding || 'utf-8', mime = typeof rep.mimetype === 'string' ? rep.mimetype : 'application/octet-stream';
    var value = rep.value;
    if (value === undefined || value === null) { setStatus(S('noValue'), 'err'); return; }
    if (vte === 'json') { value = JSON.stringify(value); vte = 'utf-8'; }     // carry a json value as its text
    var name = decodeURIComponent(String(objURL).replace(/[?#].*$/, '').replace(/\/$/, '').split('/').pop() || 'object');
    await enqueue(value, mime, vte, name);
  }

  // The desktop hands over a data object dragged onto this window (see cvwm.js onObjectDrop).
  CTX.objectDropHint = 'Enqueue';
  CTX.onObjectDrop = function (info) {
    if (!info || !info.url) return;
    if (info.kind && info.kind !== 'object') { setStatus(S('onlyDataObjects'), 'err'); return; }
    enqueueObject(info.url);
  };

  bEnqText.addEventListener('click', function () {
    var t = textIn.value; if (t === '') { setStatus(S('typeValue'), 'err'); return; }
    enqueue(t, 'text/plain', 'utf-8', 'text').then(function (ok) { if (ok) textIn.value = ''; });
  });
  textIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') bEnqText.click(); });
  bEnqObj.addEventListener('click', function () {
    if (!D.pickObject) { setStatus(S('noOpenDialog'), 'err'); return; }
    D.pickObject({ title: S('enqueueObjectTitle') }).then(function (u) { if (u) enqueueObject(u); });
  });

  // ---- dequeue via Save as: pick a destination with the desktop's standard dialog, write the head value there,
  //      then DELETE ?values=1. Same dialog (save mode) the New button uses, for consistency. ----
  function saveAsDialog(hv) {
    if (!D.pickObject) { setStatus(S('noOpenDialog'), 'err'); return; }
    D.pickObject({ mode: 'save', title: S('saveHeadTitle'), saveLabel: S('saveDequeueLabel'),
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
    if (hv.designator == null) { setStatus(S('noDesignator'), 'err'); return; }
    setStatus(S('savingTo', { u: destURL }));
    var objBody = { mimetype: hv.mimetype, valuetransferencoding: hv.vte, value: hv.value, metadata: {} };
    var put;
    try { put = await req('PUT', destURL, { type: MT_OBJECT, accept: MT_OBJECT, body: JSON.stringify(objBody) }); }
    catch (e) { setStatus(S('saveFailed', { e: e.message }), 'err'); return; }
    if (!(put.status === 201 || put.status === 202 || put.status === 204)) { setStatus(S('saveFailed', { e: await fail(put) }), 'err'); return; }
    // Only now remove the head from the queue.
    var del;
    try { del = await dequeueHead(hv.designator); }
    catch (e) { setStatus(S('savedDequeueFailed', { u: destURL, e: e.message }), 'err'); return; }
    if (!(del.status === 200 || del.status === 204)) { setStatus(S('savedDequeueFailed', { u: destURL, e: await fail(del) }), 'err'); return; }
    setStatus(S('savedAndDequeued', { u: destURL }), 'ok'); peek();
  }

  // Delete the oldest value outright (no save), with a confirm.
  function deleteHead(hv) {
    if (hv.designator == null) { setStatus(S('noDesignator'), 'err'); return; }
    var overlay = el('div', 'modal'), dlg = el('div', 'dlg');
    dlg.appendChild(el('h3', null, S('deleteOldest')));
    var cnt = el('div', 'cnt'); cnt.appendChild(el('div', 'note', S('deleteOldestNote', { d: hv.designator }))); dlg.appendChild(cnt);
    var foot = el('div', 'foot'), c = el('button', null, S('cancel')), del = el('button', 'danger', S('delete')); foot.appendChild(c); foot.appendChild(del); dlg.appendChild(foot);
    overlay.appendChild(dlg); document.body.appendChild(overlay);
    c.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    del.addEventListener('click', async function () {
      del.disabled = true;
      var res;
      try { res = await dequeueHead(hv.designator); }
      catch (e) { overlay.remove(); setStatus(S('deleteFailed', { e: e.message }), 'err'); return; }
      if (!(res.status === 200 || res.status === 204)) { overlay.remove(); setStatus(S('deleteFailed', { e: await fail(res) }), 'err'); return; }
      overlay.remove(); setStatus(S('deletedOldest', { d: hv.designator }), 'ok'); peek();
    });
  }

  // ---- open / new / delete ----
  function open(u) { var n = normURL(u); if (!n) { setStatus(S('invalidUrl'), 'err'); return; } queueURL = n.replace(/[?#].*$/, ''); urlIn.value = queueURL; peek(); }
  urlIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') open(urlIn.value); });   // paste-a-URL convenience
  bRefresh.addEventListener('click', peek);

  // Open uses the desktop's standard Open dialog to choose an existing queue object; open() then checks the type.
  bOpen.addEventListener('click', function () {
    if (!D.pickObject) { open(urlIn.value); return; }
    D.pickObject({ title: S('openQueueTitle'), startURI: queueURL || CTX.startURI || homeBase() }).then(function (u) { if (u) open(u); });
  });

  async function createQueue(target) {
    target = String(target || '').replace(/[?#].*$/, '');
    if (!target || /\/$/.test(target)) { setStatus(S('noTrailingSlash'), 'err'); return; }
    setStatus(S('creating', { u: target }));
    var res;
    try { res = await req('PUT', target, { type: MT_QUEUE, accept: MT_QUEUE, body: JSON.stringify({ metadata: {} }) }); }
    catch (e) { setStatus(S('createFailed', { e: e.message }), 'err'); return; }
    if (!(res.status === 201 || res.status === 202 || res.status === 204)) { setStatus(S('createFailed', { e: await fail(res) }), 'err'); return; }
    queueURL = target; urlIn.value = target; setStatus(S('created', { u: target }), 'ok'); peek();
  }

  // New uses the same dialog in "save" mode: choose a container and name the queue object to create.
  bNew.addEventListener('click', function () {
    if (!D.pickObject) { setStatus(S('noOpenDialog'), 'err'); return; }
    D.pickObject({ mode: 'save', title: S('newQueueTitle'), saveLabel: S('create'), name: 'queue', namePlaceholder: S('newQueueName'), startURI: dirOf(queueURL) || homeBase() })
      .then(function (u) { if (u) createQueue(u); });
  });

  bDelete.addEventListener('click', function () {
    if (!queueURL) return;
    var overlay = el('div', 'modal'); var dlg = el('div', 'dlg');
    dlg.appendChild(el('h3', null, S('deleteQueueTitle')));
    var cnt = el('div', 'cnt'); cnt.appendChild(el('div', 'note', S('deleteQueueNote', { u: queueURL }))); dlg.appendChild(cnt);
    var foot = el('div', 'foot'); var c = el('button', null, S('cancel')); var del = el('button', 'danger', S('delete')); foot.appendChild(c); foot.appendChild(del); dlg.appendChild(foot);
    overlay.appendChild(dlg); document.body.appendChild(overlay);
    c.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    del.addEventListener('click', async function () {
      del.disabled = true;
      var res;
      try { res = await req('DELETE', queueURL, { accept: MT_QUEUE }); }
      catch (e) { overlay.remove(); setStatus(S('deleteFailed', { e: e.message }), 'err'); return; }
      if (!(res.status === 200 || res.status === 204)) { overlay.remove(); setStatus(S('deleteFailed', { e: await fail(res) }), 'err'); return; }
      overlay.remove(); var gone = queueURL; queueURL = ''; head = null; urlIn.value = ''; listEl.innerHTML = ''; listEl.appendChild(el('div', 'empty', S('deletedQueueEmpty', { u: gone }))); setStatus(S('deletedQueue', { u: gone }), 'ok'); refreshButtons();
    });
  });

  // ---- start ----
  if (CTX.startURI) { open(CTX.startURI); } else { urlIn.value = ''; refreshButtons(); peek(); }
})();
