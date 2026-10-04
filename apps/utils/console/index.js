/*!
 * Console for cvwm. Store this file as "index.js" in a container (for example /console/), with
 * index.png beside it, and open it; or choose Console from the desktop's root menu.
 *
 * The desktop keeps a log from the moment it loads: calls to console.*, uncaught errors, unhandled promise
 * rejections, resources that failed to load, policy violations, and every request with its status and timing,
 * from the desktop itself and from every application window. This program shows that log, filters it, and
 * runs JavaScript in the window you choose, as the browser's own console would.
 *
 * What it cannot show is what the browser writes on its own account and keeps from scripts: why a CORS or
 * mixed-content request was blocked, why a site refused to be framed, and anything that happens inside a
 * frame of another origin (the pages Earthworm shows, the PDF viewer). For those, the browser's console is
 * still the place; a failed request is shown here with its likely cause.
 */
(function () {
  'use strict';

  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || (window.parent !== window && window.parent.cvwm) || null;

  // Resources: the app's own fork (CTX.rsrc) and the shared system fork (CTX.sys.rsrc), each optional. A classic
  // install has neither, so every lookup falls back to the built-in default and the app runs exactly as it did before
  // the resource fork existed. S() reads a string from the app fork; SYSS() from the system fork (shared across apps).
  var R = CTX.rsrc || null, SYS = (CTX.sys && CTX.sys.rsrc) || null;
  function S(id, fallback) { var v = R && R.text('strings', id); return v == null ? fallback : v; }
  function SYSS(id, fallback) { var v = SYS && SYS.text('strings', id); return v == null ? fallback : v; }

  var LEVELS = [['error', 'Errors', 'errors'], ['warn', 'Warnings', 'warnings'], ['info', 'Info', 'info'], ['log', 'Log', 'log'], ['debug', 'Debug', 'debug']];
  var on = { error: true, warn: true, info: true, log: true, debug: false }, showNet = true;
  var source = '', needle = '', sources = {}, history = [], hpos = 0, stash = '', counts = { error: 0, warn: 0 };

  var style = document.createElement('style');
  var DEFAULT_CSS =
    'html,body{margin:0;height:100%}' +
    'body{display:flex;flex-direction:column;background:#bfbfbf;color:#000;font:12px Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif}' +
    '#bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:4px 6px;flex:none}' +
    'button,select{height:24px;background:#bfbfbf;color:#000;font:700 12px Helvetica,Arial,sans-serif;border:2px solid;border-color:#fff #555 #555 #fff;padding:0 6px}' +
    'button:active,button[aria-pressed="true"]{border-color:#555 #fff #fff #555;background:#e8e8e8}button[aria-pressed="false"]{color:#555}' +
    'button:focus-visible,select:focus-visible,input:focus-visible{outline:1px solid #000;outline-offset:1px}' +
    'button .n{font-weight:400;margin-left:4px}' +
    'input{height:24px;box-sizing:border-box;padding:0 6px;background:#fff;color:#000;font:12px "DejaVu Sans Mono",Menlo,Consolas,monospace;border:2px solid;border-color:#555 #fff #fff #555}' +
    '#find{width:110px}select{max-width:170px}.gap{flex:1}' +
    '#log{--sb-face:#4a505a;--sb-trough:#14171c}' +           /* the desktop's scroll bars, darker beside the log */
    '#log{flex:1;min-height:0;overflow:auto;background:#0b0d10;color:#d0d0d0;font:12px/17px "DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;border:2px solid;border-color:#555 #fff #fff #555;outline:none}' +
    '.e{display:flex;gap:8px;padding:1px 8px;border-bottom:1px solid #1a1e24;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}' +
    '.e .t{color:#6f7782;flex:none}.e .s{color:#8fb8ff;flex:none;max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.e .m{flex:1;min-width:0}' +
    '.e.error{background:#2a1214;color:#ff9a90}.e.warn{background:#2a2410;color:#f0d67a}.e.info{color:#9fd8ff}.e.debug{color:#8a929c}' +
    '.e.net .m{color:#9aa4b0}.e.net.warn .m{color:#f0d67a}.e.net.error .m{color:#ff9a90}.e.eval .m{color:#fff}.e.eval.error .m{color:#ff9a90}' +
    '.e details{margin-top:2px;color:#9aa4b0}.e summary{cursor:pointer;color:#6f7782}' +
    '#none{padding:14px;color:#8a929c}' +
    '#cmd{display:flex;align-items:center;gap:4px;padding:4px 6px;flex:none}#cmd label{font-weight:700}#code{flex:1;min-width:0}';
  // The stylesheet from the app fork (styles/console) where present, else the built-in default above.
  style.textContent = (R && R.text('styles', 'console')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(tag, props, text) { var e = document.createElement(tag); for (var k in (props || {})) e.setAttribute(k, props[k]); if (text !== undefined) e.textContent = text; return e; }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }

  var bar = el('div', { id: 'bar', role: 'toolbar', 'aria-label': 'Filters' }), toggles = {};
  LEVELS.forEach(function (l) {
    var b = el('button', { type: 'button', 'aria-pressed': String(on[l[0]]) }, S(l[2], l[1])), n = el('span', { class: 'n' }, '');
    b.appendChild(n); toggles[l[0]] = { button: b, count: n };
    b.addEventListener('click', function () { on[l[0]] = !on[l[0]]; b.setAttribute('aria-pressed', String(on[l[0]])); redraw(); });
    bar.appendChild(b);
  });
  var bNet = el('button', { type: 'button', 'aria-pressed': 'true', title: S('network-title', 'Requests made with fetch(), with status and time. Successful ones are at Debug level.') }, S('network', 'Network'));
  bNet.addEventListener('click', function () { showNet = !showNet; bNet.setAttribute('aria-pressed', String(showNet)); redraw(); });
  var from = el('select', { 'aria-label': S('from-label', 'Show entries from'), title: S('from-label', 'Show entries from') }), find = el('input', { id: 'find', type: 'text', placeholder: S('filter-placeholder', 'filter text'), 'aria-label': S('filter-label', 'Filter text'), spellcheck: 'false' });
  var bCopy = el('button', { type: 'button', title: S('copy-title', 'Copy what is shown to the clipboard') }, S('copy', 'Copy')), bClear = el('button', { type: 'button' }, S('clear', 'Clear'));
  add(bar, bNet, el('span', { class: 'gap' }), from, find, bCopy, bClear);

  var log = el('div', { id: 'log', tabindex: '0', role: 'log', 'aria-label': 'Console entries' });
  var cmd = el('div', { id: 'cmd' }), target = el('select', { id: 'target', 'aria-label': 'Run in window' }), code = el('input', { id: 'code', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: S('code-placeholder', 'JavaScript to run in that window; Enter runs it, Up and Down recall') });
  add(cmd, el('label', { for: 'code' }, S('run-in', 'Run in')), target, code);
  add(document.body, bar, log, cmd);

  /* ---------------------------------------------------------------- entries */

  function stamp(t) { var d = new Date(t), p = function (n, w) { return ('00' + n).slice(-w); }; return p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2) + '.' + p(d.getMilliseconds(), 3); }
  function wanted(e) {
    if (e.kind === 'net' && !showNet) return false;
    if (!on[e.level]) return false;
    if (source && e.source !== source) return false;
    if (needle && (e.text + ' ' + e.source).toLowerCase().indexOf(needle) < 0) return false;
    return true;
  }
  function row(e) {
    var r = el('div', { class: 'e ' + e.level + ' ' + e.kind }), m = el('div', { class: 'm' }, e.text);
    if (e.stack && e.stack !== e.text) { var d = el('details'); add(d, el('summary', {}, 'stack'), el('div', {}, e.stack)); m.appendChild(d); }
    return add(r, el('span', { class: 't' }, stamp(e.time)), el('span', { class: 's', title: e.source }, e.source), m);
  }
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 24; }
  function note(e) {
    if (!sources[e.source]) { sources[e.source] = true; from.appendChild(el('option', { value: e.source }, e.source)); }
    if (e.level in counts) { counts[e.level]++; badge(); }
  }
  function badge() {
    toggles.error.count.textContent = counts.error ? '(' + counts.error + ')' : ''; toggles.warn.count.textContent = counts.warn ? '(' + counts.warn + ')' : '';
    if (CTX.setTitle) CTX.setTitle('Console' + (counts.error ? ' \u2014 ' + counts.error + (counts.error === 1 ? ' error' : ' errors') : ''));
  }
  function append(e) {
    note(e); if (!wanted(e)) return;
    var stick = atBottom(), none = document.getElementById('none'); if (none) none.remove();
    log.appendChild(row(e));
    while (log.childNodes.length > 1500) log.removeChild(log.firstChild);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function redraw() {
    log.textContent = '';
    var shown = D ? D.log.entries().filter(wanted).slice(-1500) : [];
    shown.forEach(function (e) { log.appendChild(row(e)); });
    if (!shown.length) log.appendChild(el('div', { id: 'none' }, D ? S('empty-filtered', 'Nothing to show with these filters.') : S('need-cvwm', 'This program needs cvwm: open it from a desktop window.')));
    log.scrollTop = log.scrollHeight;
  }

  /* ---------------------------------------------------------------- the command line */

  function targets() {
    if (!D) return;
    var keep = target.value, list = D.windows().filter(function (w) { return w.id !== CTX.id; });
    target.textContent = '';
    list.forEach(function (w) { target.appendChild(el('option', { value: w.id }, w.title)); });
    if (list.some(function (w) { return w.id === keep; })) target.value = keep;
  }
  target.addEventListener('pointerdown', targets); target.addEventListener('focus', targets);

  code.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      var text = code.value.trim(); if (!text || !D) return;
      if (history[history.length - 1] !== text) history.push(text); hpos = history.length; code.value = '';
      on.log = true; toggles.log.button.setAttribute('aria-pressed', 'true');           // the answer is a log entry; do not hide it
      if (source) { source = ''; from.value = ''; redraw(); }
      D.evalIn(target.value || 'desktop', text).catch(function () { /* already in the log */ }).then(function () { log.scrollTop = log.scrollHeight; });
    } else if (ev.key === 'ArrowUp') { if (hpos === history.length) stash = code.value; if (hpos > 0) { code.value = history[--hpos]; ev.preventDefault(); } }
    else if (ev.key === 'ArrowDown') { if (hpos < history.length) { hpos++; code.value = hpos === history.length ? stash : history[hpos]; ev.preventDefault(); } }
    else if (ev.key === 'l' && ev.ctrlKey) { ev.preventDefault(); log.textContent = ''; }
  });

  /* ---------------------------------------------------------------- controls */

  from.addEventListener('change', function () { source = from.value; redraw(); });
  find.addEventListener('input', function () { needle = find.value.trim().toLowerCase(); redraw(); });
  bClear.addEventListener('click', function () { if (D) D.log.clear(); counts = { error: 0, warn: 0 }; badge(); redraw(); });
  bCopy.addEventListener('click', function () {
    var text = (D ? D.log.entries().filter(wanted) : []).map(function (e) { return stamp(e.time) + '  ' + e.level.toUpperCase() + '  [' + e.source + ']  ' + e.text + (e.stack && e.stack !== e.text ? '\n' + e.stack : ''); }).join('\n');
    function done(ok) { bCopy.textContent = ok ? SYSS('copied', 'Copied') : S('copy-failed', 'Copy failed'); setTimeout(function () { bCopy.textContent = S('copy', 'Copy'); }, 1200); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); }); else fallback();
    function fallback() { var ta = el('textarea', { style: 'position:fixed;left:-999px' }); ta.value = text; document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* denied */ } ta.remove(); done(ok); }
  });

  /* ---------------------------------------------------------------- start */

  from.appendChild(el('option', { value: '' }, S('all-windows', 'All windows')));
  if (D) {
    D.log.entries().forEach(note);
    var stop = D.log.subscribe(append);
    window.addEventListener('pagehide', stop);
  }
  targets(); redraw();
  if (CTX.resize) CTX.resize(860, 440);
  code.focus();
})();
