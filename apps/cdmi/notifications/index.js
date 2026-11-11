/*!
 * notifications for cvwm: a live view of a CDMI notification queue (13.x). A notification queue is a queue object
 * carrying three metadata items -- cdmi_queue_type = "cdmi_notification_queue", cdmi_notification_events (the event
 * types to report, empty = all), and cdmi_scope_specification (the objects to watch, empty = all) -- plus a
 * cdmi_results_specification naming the fields each event carries. The server appends one value per matching event.
 *
 * This app creates such a queue INSIDE its own container (/apps/cdmi/notifications/), then polls it and shows the
 * events as a live log in the same style as the console. Clicking an event expands its full JSON.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var HDRS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string with optional {token} substitution; the stylesheet, the event-type list and
  // the results specification are pulled from the fork where present further down.
  var R = CTX.rsrc || null;
  function S(id, vars) {
    var v = R && R.text('strings', id); if (v == null) return id;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var MT_QUEUE = 'application/cdmi-queue', MT_CONTAINER = 'application/cdmi-container';
  var CONTAINER = (function () { var u = CTX.containerURI || CTX.baseURI || ''; return u && !/\/$/.test(u) ? u + '/' : u; })();

  if (CTX.setTitle) CTX.setTitle(S('title'));
  if (CTX.resize) CTX.resize(860, 540);

  var EVENT_TYPES = ['cdmi_create_processing', 'cdmi_create_complete', 'cdmi_read', 'cdmi_modify_processing',
    'cdmi_modify_complete', 'cdmi_rename', 'cdmi_copy', 'cdmi_reference', 'cdmi_delete', 'cdmi_export', 'cdmi_snapshot'];
  // The fields each event value carries (empty string = "include this field").
  var RESULTS = { objectName: '', parentURI: '', objectType: '', cdmi_event: '', cdmi_event_user: '', cdmi_event_time: '', cdmi_event_result: '' };
  if (R) {
    var _ev = R.json('data', 'events'); if (Array.isArray(_ev) && _ev.length) EVENT_TYPES = _ev;
    var _rs = R.json('data', 'results'); if (_rs && typeof _rs === 'object') RESULTS = _rs;
  }
  // How an event type colours its line, reusing the console's level classes.
  function levelOf(t) {
    if (t === 'cdmi_delete') return 'error';
    if (t === 'cdmi_modify_processing' || t === 'cdmi_modify_complete' || t === 'cdmi_rename') return 'warn';
    if (t === 'cdmi_create_complete' || t === 'cdmi_copy' || t === 'cdmi_reference' || t === 'cdmi_snapshot' || t === 'cdmi_export') return 'ok';
    return 'info';
  }

  // ---- console-style look (platinum toolbar, dark log pane) ----
  var style = document.createElement('style');
  style.textContent = R.text('styles', 'notifications');
  document.head.appendChild(style);

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function assign(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

  function req(method, url, opts) {
    opts = opts || {};
    var h = assign(HDRS, {});
    if (opts.accept) h.Accept = opts.accept;
    if (opts.type) h['Content-Type'] = opts.type;
    return fetch(url, { method: method, headers: h, credentials: 'same-origin', body: opts.body });
  }
  async function readJson(res) { var t = await res.text(); try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  async function fail(res) { var j = await readJson(res.clone ? res.clone() : res); return (j && (j.title || j.detail)) || ('HTTP ' + res.status); }

  // ---- toolbar ----
  var sel = el('select'); sel.title = S('queuesTitle');
  var bNew = el('button', null, S('new')); bNew.type = 'button';
  var bWatch = el('button', null, S('watch')); bWatch.type = 'button'; bWatch.setAttribute('aria-pressed', 'false');
  var bClear = el('button', null, S('clear')); bClear.type = 'button'; bClear.title = S('clearTitle');
  var bReload = el('button', null, S('refresh')); bReload.type = 'button';
  var statusEl = el('span'); statusEl.id = 'status'; statusEl.textContent = S('statusNone');
  var bar = el('div'); bar.id = 'bar'; bar.setAttribute('role', 'toolbar');
  bar.appendChild(el('span', null, S('queueLabel'))); bar.appendChild(sel); bar.appendChild(bNew); bar.appendChild(bWatch);
  bar.appendChild(bReload); bar.appendChild(bClear); bar.appendChild(el('span', 'gap')); bar.appendChild(statusEl);

  var logEl = el('div'); logEl.id = 'log';
  var none = el('div'); none.id = 'none'; none.textContent = S('noneHint');
  logEl.appendChild(none);

  document.body.appendChild(bar); document.body.appendChild(logEl);

  // ---- state ----
  var queueURL = '', seenHi = null, timer = null, watching = false;

  function setStatus(t) { statusEl.textContent = t; }
  function atBottom() { return logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24; }

  function stamp(t) { if (!t) return '--:--:--'; var d = new Date(t); return isNaN(d) ? String(t) : d.toTimeString().slice(0, 8); }

  function addEvent(ev) {
    if (none.parentNode) none.remove();
    var type = ev.cdmi_event || ev.type || S('event');
    var line = el('div', 'e ' + levelOf(type));
    line.appendChild(el('span', 't', stamp(ev.cdmi_event_time)));
    line.appendChild(el('span', 's', type.replace(/^cdmi_/, '')));
    var who = ev.cdmi_event_user ? ' · ' + ev.cdmi_event_user : '';
    var res = ev.cdmi_event_result && ev.cdmi_event_result !== 'Success' ? '  → ' + ev.cdmi_event_result : '';
    line.appendChild(el('span', 'm', (ev.objectName || ev.parentURI || S('object')) + who + res));
    var pre = null;
    line.addEventListener('click', function () {
      logEl.querySelectorAll('.e.sel').forEach(function (n) { if (n !== line) n.classList.remove('sel'); });
      if (pre) { pre.remove(); pre = null; line.classList.remove('sel'); return; }
      pre = el('pre', 'j', JSON.stringify(ev, null, 2)); line.classList.add('sel');
      if (line.nextSibling) logEl.insertBefore(pre, line.nextSibling); else logEl.appendChild(pre);
    });
    var stick = atBottom();
    logEl.appendChild(line);
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  function clearLog() { logEl.textContent = ''; logEl.appendChild(none); }

  // ---- poll the selected queue for new events ----
  async function poll(initial) {
    if (!queueURL) return;
    var res;
    try { res = await req('GET', queueURL + '?objectType&queueValues&value&valuetransferencoding&metadata', { accept: MT_QUEUE }); }
    catch (e) { setStatus(S('readFailed', { e: e.message })); return; }
    if (!res.ok) { setStatus(S('readFailed', { e: await fail(res) })); return; }
    var rep = await readJson(res) || {};
    if (rep.objectType && rep.objectType !== MT_QUEUE) { setStatus(S('notQueue')); stop(); return; }
    var span = typeof rep.queueValues === 'string' ? rep.queueValues : '';
    var lo = span ? parseInt(span.split('-')[0], 10) : null, hi = span ? parseInt(span.split('-')[1] || span.split('-')[0], 10) : null;
    var values = Array.isArray(rep.value) ? rep.value : [];
    if (initial && seenHi == null) { seenHi = lo != null ? lo - 1 : -1; }   // on first look, show only events from now on... but include the backlog once:
    var added = 0;
    values.forEach(function (v, i) {
      var designator = (lo == null ? i : lo + i);
      if (seenHi != null && designator <= seenHi) return;
      var ev; try { ev = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { ev = { raw: v }; }
      addEvent(ev); added++;
    });
    if (hi != null) seenHi = hi;
    var n = values.length;
    setStatus((watching ? S('watching') : S('paused')) + ' · ' + n + ' ' + (n === 1 ? S('eventSingular') : S('eventPlural')) + ' held' + (span ? ' (designators ' + lo + '–' + hi + ')' : '') + (added ? ' · +' + added : ''));
  }

  function start() {
    if (!queueURL) return;
    watching = true; bWatch.textContent = S('stop'); bWatch.setAttribute('aria-pressed', 'true');
    poll(true);
    if (timer) clearInterval(timer);
    timer = setInterval(poll, 2000);
  }
  function stop() {
    watching = false; bWatch.textContent = S('watch'); bWatch.setAttribute('aria-pressed', 'false');
    if (timer) { clearInterval(timer); timer = null; }
  }

  function selectQueue(url) {
    stop(); queueURL = url; seenHi = null; clearLog();
    setStatus(url ? S('selected', { u: url }) : S('statusNone'));
    bWatch.disabled = bClear.disabled = bReload.disabled = !url;
  }

  bWatch.addEventListener('click', function () { if (!queueURL) return; if (watching) stop(); else start(); });
  bReload.addEventListener('click', function () { seenHi = null; clearLog(); poll(true); });
  sel.addEventListener('change', function () { selectQueue(sel.value); });

  bClear.addEventListener('click', async function () {
    if (!queueURL) return;
    var res;
    try { res = await req('GET', queueURL + '?queueValues', { accept: MT_QUEUE }); } catch (e) { setStatus(S('clearFailed', { e: e.message })); return; }
    var span = ((await readJson(res)) || {}).queueValues || '';
    if (!span) { setStatus(S('nothingToClear')); return; }
    var lo = span.split('-')[0], hi = span.split('-')[1] || lo;
    var del;
    try { del = await req('DELETE', queueURL + '?values=' + lo + '-' + hi, { accept: MT_QUEUE }); } catch (e) { setStatus(S('clearFailed', { e: e.message })); return; }
    if (!(del.status === 200 || del.status === 204)) { setStatus(S('clearFailed', { e: await fail(del) })); return; }
    seenHi = null; clearLog(); setStatus(S('cleared', { u: queueURL })); poll(true);
  });

  // ---- list existing notification queues in this app's container ----
  async function listQueues(selectName) {
    var res;
    try { res = await req('GET', CONTAINER + '?childfields=objectName;objectType&children', { accept: MT_CONTAINER }); }
    catch (e) { setStatus(S('couldNotList', { e: e.message })); return; }
    var names = [];
    if (res.ok) {
      var rep = await readJson(res) || {}, kids = rep.children || [];
      kids.forEach(function (c) {
        // extended form [objectName, objectType] where the server answers it; else a bare name
        var name = Array.isArray(c) ? c[0] : c, type = Array.isArray(c) ? c[1] : null;
        name = String(name).replace(/\/$/, '');
        if (name === 'index.js' || name === 'index.png' || /^cdmi_/.test(name) || /\/$/.test(Array.isArray(c) ? c[0] : c)) return;
        if (type && type !== MT_QUEUE) return;          // when the type is known, keep only queues
        names.push(name);
      });
    }
    sel.textContent = '';
    if (!names.length) { var o = el('option', null, S('noQueuesYet')); o.value = ''; sel.appendChild(o); }
    names.forEach(function (nm) { var o = el('option', null, nm); o.value = CONTAINER + encodeURIComponent(nm); sel.appendChild(o); });
    if (selectName) { for (var i = 0; i < sel.options.length; i++) if (sel.options[i].textContent === selectName) sel.selectedIndex = i; }
    selectQueue(sel.value || '');
  }

  // ---- New notification queue dialog ----
  bNew.addEventListener('click', function () {
    var overlay = el('div', 'modal'), dlg = el('div', 'dlg');
    dlg.appendChild(el('h3', null, S('newTitle')));
    var cnt = el('div', 'cnt');
    cnt.appendChild(el('label', 'row', S('name'))); var nameIn = el('input'); nameIn.type = 'text'; nameIn.value = 'events'; cnt.appendChild(nameIn);
    cnt.appendChild(el('label', 'row', S('reportEvents')));
    var evWrap = el('div', 'events'), boxes = {};
    EVENT_TYPES.forEach(function (t) {
      var lab = el('label'), cb = el('input'); cb.type = 'checkbox'; boxes[t] = cb;
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + t.replace(/^cdmi_/, ''))); evWrap.appendChild(lab);
    });
    cnt.appendChild(evWrap);
    cnt.appendChild(el('label', 'row', S('scopeLabel')));
    var scopeIn = el('input'); scopeIn.type = 'text'; scopeIn.value = '[]'; cnt.appendChild(scopeIn);
    var note = el('div', 'note', S('createdInside'));
    cnt.appendChild(note); dlg.appendChild(cnt);
    var foot = el('div', 'foot'), cancel = el('button', null, S('cancel')), create = el('button', null, S('create'));
    cancel.type = create.type = 'button'; foot.appendChild(cancel); foot.appendChild(create); dlg.appendChild(foot);
    overlay.appendChild(dlg); document.body.appendChild(overlay);
    cancel.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });

    create.addEventListener('click', async function () {
      var name = nameIn.value.trim();
      if (!name) { note.textContent = S('giveName'); note.className = 'note err'; return; }
      if (/[\/?]/.test(name)) { note.textContent = S('noSlash'); note.className = 'note err'; return; }
      var scope; try { scope = JSON.parse(scopeIn.value || '[]'); } catch (e) { note.textContent = S('scopeNotJson'); note.className = 'note err'; return; }
      if (!Array.isArray(scope)) { note.textContent = S('scopeNotArray'); note.className = 'note err'; return; }
      var events = EVENT_TYPES.filter(function (t) { return boxes[t].checked; });   // none = all
      var body = { metadata: {
        cdmi_queue_type: 'cdmi_notification_queue',
        cdmi_notification_events: events,
        cdmi_scope_specification: scope,
        cdmi_results_specification: RESULTS
      } };
      create.disabled = true; note.className = 'note'; note.textContent = S('creating');
      var url = CONTAINER + encodeURIComponent(name), res;
      try { res = await req('PUT', url, { type: MT_QUEUE, accept: MT_QUEUE, body: JSON.stringify(body) }); }
      catch (e) { note.textContent = S('createFailed', { e: e.message }); note.className = 'note err'; create.disabled = false; return; }
      if (!(res.status === 201 || res.status === 202 || res.status === 204)) { note.textContent = S('createFailed', { e: await fail(res) }); note.className = 'note err'; create.disabled = false; return; }
      overlay.remove();
      await listQueues(name);
      start();
    });
  });

  // ---- start ----
  if (!CONTAINER) { setStatus(S('noContainer')); bNew.disabled = true; }
  else listQueues();
})();
