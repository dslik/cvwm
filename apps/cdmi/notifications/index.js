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
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var MT_QUEUE = 'application/cdmi-queue', MT_CONTAINER = 'application/cdmi-container';
  var CONTAINER = (function () { var u = CTX.containerURI || CTX.baseURI || ''; return u && !/\/$/.test(u) ? u + '/' : u; })();

  if (CTX.setTitle) CTX.setTitle(S('title', 'notifications'));
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
  var DEFAULT_CSS =
    'html,body{margin:0;height:100%}' +
    'body{display:flex;flex-direction:column;background:#bfbfbf;color:#000;font:12px Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif}' +
    '#bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:4px 6px;flex:none}' +
    'button,select{height:24px;background:#bfbfbf;color:#000;font:700 12px Helvetica,Arial,sans-serif;border:2px solid;border-color:#fff #555 #555 #fff;padding:0 6px}' +
    'button:active,button[aria-pressed="true"]{border-color:#555 #fff #fff #555;background:#e8e8e8}button[aria-pressed="false"]{color:#555}' +
    'button:disabled{color:#888}button:focus-visible,select:focus-visible,input:focus-visible{outline:1px solid #000;outline-offset:1px}' +
    'select{max-width:220px}.gap{flex:1}' +
    '#status{padding:0 6px;font:11px "DejaVu Sans Mono",Menlo,Consolas,monospace;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#log{--sb-face:#4a505a;--sb-trough:#14171c;flex:1;min-height:0;overflow:auto;background:#0b0d10;color:#d0d0d0;font:12px/17px "DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;border:2px solid;border-color:#555 #fff #fff #555;outline:none}' +
    '.e{display:flex;gap:8px;padding:1px 8px;border-bottom:1px solid #1a1e24;white-space:pre-wrap;overflow-wrap:anywhere;cursor:pointer}' +
    '.e .t{color:#6f7782;flex:none}.e .s{color:#8fb8ff;flex:none;min-width:20ch}.e .m{flex:1;min-width:0}' +
    '.e.error .s{color:#ff9a90}.e.warn .s{color:#f0d67a}.e.info .s{color:#9fd8ff}.e.ok .s{color:#8ee6a0}' +
    '.e.sel{background:#182030}.e:hover{background:#12161b}' +
    '.j{background:#0b0d10;color:#cfe3ff;border-bottom:1px solid #1a1e24;padding:6px 10px;margin:0;white-space:pre;overflow:auto;font:12px/16px "DejaVu Sans Mono",Menlo,Consolas,monospace}' +
    '#none{padding:14px;color:#8a929c}' +
    '.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9}' +
    '.dlg{background:#bfbfbf;border:2px solid;border-color:#fff #555 #555 #fff;width:min(460px,92vw);max-height:88vh;display:flex;flex-direction:column}' +
    '.dlg h3{margin:0;padding:8px 10px;font-size:12px;font-weight:700}' +
    '.dlg .cnt{padding:8px 10px;overflow:auto}' +
    '.dlg input[type=text]{width:100%;box-sizing:border-box;height:24px;padding:0 6px;background:#fff;color:#000;font:12px "DejaVu Sans Mono",Menlo,Consolas,monospace;border:2px solid;border-color:#555 #fff #fff #555}' +
    '.dlg label.row{display:block;margin:3px 0}.dlg .events{columns:2;margin:6px 0}.dlg .events label{display:block;font-weight:400}' +
    '.dlg .note{font:11px "DejaVu Sans Mono",Menlo,Consolas,monospace;color:#333;min-height:1em;margin-top:4px}.dlg .note.err{color:#a00}' +
    '.dlg .foot{display:flex;justify-content:flex-end;gap:6px;padding:8px 10px}';
  style.textContent = (R && R.text('styles', 'notifications')) || DEFAULT_CSS;
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
  var sel = el('select'); sel.title = S('queuesTitle', 'Notification queues in this app’s container');
  var bNew = el('button', null, S('new', 'New…')); bNew.type = 'button';
  var bWatch = el('button', null, S('watch', 'Watch')); bWatch.type = 'button'; bWatch.setAttribute('aria-pressed', 'false');
  var bClear = el('button', null, S('clear', 'Clear')); bClear.type = 'button'; bClear.title = S('clearTitle', 'Dequeue every event this queue holds');
  var bReload = el('button', null, S('refresh', 'Refresh')); bReload.type = 'button';
  var statusEl = el('span'); statusEl.id = 'status'; statusEl.textContent = S('statusNone', 'No notification queue selected.');
  var bar = el('div'); bar.id = 'bar'; bar.setAttribute('role', 'toolbar');
  bar.appendChild(el('span', null, S('queueLabel', 'Queue'))); bar.appendChild(sel); bar.appendChild(bNew); bar.appendChild(bWatch);
  bar.appendChild(bReload); bar.appendChild(bClear); bar.appendChild(el('span', 'gap')); bar.appendChild(statusEl);

  var logEl = el('div'); logEl.id = 'log';
  var none = el('div'); none.id = 'none'; none.textContent = S('noneHint', 'Create or select a notification queue, then Watch.');
  logEl.appendChild(none);

  document.body.appendChild(bar); document.body.appendChild(logEl);

  // ---- state ----
  var queueURL = '', seenHi = null, timer = null, watching = false;

  function setStatus(t) { statusEl.textContent = t; }
  function atBottom() { return logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24; }

  function stamp(t) { if (!t) return '--:--:--'; var d = new Date(t); return isNaN(d) ? String(t) : d.toTimeString().slice(0, 8); }

  function addEvent(ev) {
    if (none.parentNode) none.remove();
    var type = ev.cdmi_event || ev.type || S('event', '(event)');
    var line = el('div', 'e ' + levelOf(type));
    line.appendChild(el('span', 't', stamp(ev.cdmi_event_time)));
    line.appendChild(el('span', 's', type.replace(/^cdmi_/, '')));
    var who = ev.cdmi_event_user ? ' · ' + ev.cdmi_event_user : '';
    var res = ev.cdmi_event_result && ev.cdmi_event_result !== 'Success' ? '  → ' + ev.cdmi_event_result : '';
    line.appendChild(el('span', 'm', (ev.objectName || ev.parentURI || S('object', '(object)')) + who + res));
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
    catch (e) { setStatus(S('readFailed', 'Read failed: {e}', { e: e.message })); return; }
    if (!res.ok) { setStatus(S('readFailed', 'Read failed: {e}', { e: await fail(res) })); return; }
    var rep = await readJson(res) || {};
    if (rep.objectType && rep.objectType !== MT_QUEUE) { setStatus(S('notQueue', 'That object is not a queue.')); stop(); return; }
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
    setStatus((watching ? S('watching', 'Watching') : S('paused', 'Paused')) + ' · ' + n + ' ' + (n === 1 ? S('eventSingular', 'event') : S('eventPlural', 'events')) + ' held' + (span ? ' (designators ' + lo + '–' + hi + ')' : '') + (added ? ' · +' + added : ''));
  }

  function start() {
    if (!queueURL) return;
    watching = true; bWatch.textContent = S('stop', 'Stop'); bWatch.setAttribute('aria-pressed', 'true');
    poll(true);
    if (timer) clearInterval(timer);
    timer = setInterval(poll, 2000);
  }
  function stop() {
    watching = false; bWatch.textContent = S('watch', 'Watch'); bWatch.setAttribute('aria-pressed', 'false');
    if (timer) { clearInterval(timer); timer = null; }
  }

  function selectQueue(url) {
    stop(); queueURL = url; seenHi = null; clearLog();
    setStatus(url ? S('selected', 'Selected {u}', { u: url }) : S('statusNone', 'No notification queue selected.'));
    bWatch.disabled = bClear.disabled = bReload.disabled = !url;
  }

  bWatch.addEventListener('click', function () { if (!queueURL) return; if (watching) stop(); else start(); });
  bReload.addEventListener('click', function () { seenHi = null; clearLog(); poll(true); });
  sel.addEventListener('change', function () { selectQueue(sel.value); });

  bClear.addEventListener('click', async function () {
    if (!queueURL) return;
    var res;
    try { res = await req('GET', queueURL + '?queueValues', { accept: MT_QUEUE }); } catch (e) { setStatus(S('clearFailed', 'Clear failed: {e}', { e: e.message })); return; }
    var span = ((await readJson(res)) || {}).queueValues || '';
    if (!span) { setStatus(S('nothingToClear', 'Nothing to clear.')); return; }
    var lo = span.split('-')[0], hi = span.split('-')[1] || lo;
    var del;
    try { del = await req('DELETE', queueURL + '?values=' + lo + '-' + hi, { accept: MT_QUEUE }); } catch (e) { setStatus(S('clearFailed', 'Clear failed: {e}', { e: e.message })); return; }
    if (!(del.status === 200 || del.status === 204)) { setStatus(S('clearFailed', 'Clear failed: {e}', { e: await fail(del) })); return; }
    seenHi = null; clearLog(); setStatus(S('cleared', 'Cleared {u}', { u: queueURL })); poll(true);
  });

  // ---- list existing notification queues in this app's container ----
  async function listQueues(selectName) {
    var res;
    try { res = await req('GET', CONTAINER + '?childfields=objectName;objectType&children', { accept: MT_CONTAINER }); }
    catch (e) { setStatus(S('couldNotList', 'Could not list this container: {e}', { e: e.message })); return; }
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
    if (!names.length) { var o = el('option', null, S('noQueuesYet', '(no notification queues yet)')); o.value = ''; sel.appendChild(o); }
    names.forEach(function (nm) { var o = el('option', null, nm); o.value = CONTAINER + encodeURIComponent(nm); sel.appendChild(o); });
    if (selectName) { for (var i = 0; i < sel.options.length; i++) if (sel.options[i].textContent === selectName) sel.selectedIndex = i; }
    selectQueue(sel.value || '');
  }

  // ---- New notification queue dialog ----
  bNew.addEventListener('click', function () {
    var overlay = el('div', 'modal'), dlg = el('div', 'dlg');
    dlg.appendChild(el('h3', null, S('newTitle', 'New notification queue')));
    var cnt = el('div', 'cnt');
    cnt.appendChild(el('label', 'row', S('name', 'Name'))); var nameIn = el('input'); nameIn.type = 'text'; nameIn.value = 'events'; cnt.appendChild(nameIn);
    cnt.appendChild(el('label', 'row', S('reportEvents', 'Report these events (none ticked = all)')));
    var evWrap = el('div', 'events'), boxes = {};
    EVENT_TYPES.forEach(function (t) {
      var lab = el('label'), cb = el('input'); cb.type = 'checkbox'; boxes[t] = cb;
      lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + t.replace(/^cdmi_/, ''))); evWrap.appendChild(lab);
    });
    cnt.appendChild(evWrap);
    cnt.appendChild(el('label', 'row', S('scopeLabel', 'Scope (JSON array of match clauses; [] = every object)')));
    var scopeIn = el('input'); scopeIn.type = 'text'; scopeIn.value = '[]'; cnt.appendChild(scopeIn);
    var note = el('div', 'note', S('createdInside', 'The queue is created inside this app’s container.'));
    cnt.appendChild(note); dlg.appendChild(cnt);
    var foot = el('div', 'foot'), cancel = el('button', null, S('cancel', 'Cancel')), create = el('button', null, S('create', 'Create'));
    cancel.type = create.type = 'button'; foot.appendChild(cancel); foot.appendChild(create); dlg.appendChild(foot);
    overlay.appendChild(dlg); document.body.appendChild(overlay);
    cancel.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });

    create.addEventListener('click', async function () {
      var name = nameIn.value.trim();
      if (!name) { note.textContent = S('giveName', 'Give the queue a name.'); note.className = 'note err'; return; }
      if (/[\/?]/.test(name)) { note.textContent = S('noSlash', 'A name holds no "/" or "?".'); note.className = 'note err'; return; }
      var scope; try { scope = JSON.parse(scopeIn.value || '[]'); } catch (e) { note.textContent = S('scopeNotJson', 'Scope is not valid JSON.'); note.className = 'note err'; return; }
      if (!Array.isArray(scope)) { note.textContent = S('scopeNotArray', 'Scope is a JSON array (use [] for every object).'); note.className = 'note err'; return; }
      var events = EVENT_TYPES.filter(function (t) { return boxes[t].checked; });   // none = all
      var body = { metadata: {
        cdmi_queue_type: 'cdmi_notification_queue',
        cdmi_notification_events: events,
        cdmi_scope_specification: scope,
        cdmi_results_specification: RESULTS
      } };
      create.disabled = true; note.className = 'note'; note.textContent = S('creating', 'Creating …');
      var url = CONTAINER + encodeURIComponent(name), res;
      try { res = await req('PUT', url, { type: MT_QUEUE, accept: MT_QUEUE, body: JSON.stringify(body) }); }
      catch (e) { note.textContent = S('createFailed', 'Create failed: {e}', { e: e.message }); note.className = 'note err'; create.disabled = false; return; }
      if (!(res.status === 201 || res.status === 202 || res.status === 204)) { note.textContent = S('createFailed', 'Create failed: {e}', { e: await fail(res) }); note.className = 'note err'; create.disabled = false; return; }
      overlay.remove();
      await listQueues(name);
      start();
    });
  });

  // ---- start ----
  if (!CONTAINER) { setStatus(S('noContainer', 'This app has no container to store queues in.')); bNew.disabled = true; }
  else listQueues();
})();
