/*!
 * control_panels/locale/index.js — the Locale control panel.
 *
 * Sets the user's preferred language and the number, date and time formats, and saves them as JSON to
 * ~/proc/control_panels/locale (the control-panel configuration convention). There is no menu bar, status bar or
 * buttons: a change takes effect at once. Settings are on the left, a live preview on the right.
 *
 * Taking effect means two things, and the desktop does the rest (see cvwm.js, "locale"):
 *   - the live signal: the shared same-origin localStorage key "cvwm.locale" is written on every change, so the
 *     desktop and every open app re-render in the new formats at once (the same mechanism as the dark-mode toggle);
 *   - persistence: the JSON is also written to ~/proc/control_panels/locale, restored on next sign-in.
 *
 * EVERY visible string comes from this app's resource fork (CTX.rsrc): the UI strings per language under
 * rsrc/strings/<lang>.json, and the shared language list under rsrc/data/langs.json. Nothing is hard-coded here --
 * the panel is a fork app and does not run without its resources. Changing the language relabels the panel itself
 * immediately, in the chosen language where a translation exists (otherwise English).
 *
 * It follows the desktop's light/dark setting (the shared "cvwm.dark" signal) like the other cvwm applications.
 */
(function () {
  var c = window.CDMI_CONTEXT, D = document, R = c.rsrc;
  if (!R || !R.json('data', 'langs')) { D.body.textContent = 'Locale resources are not installed.'; return; }   // a fork app: no resources, no app

  var LANGS = R.json('data', 'langs');                                   // [[code, autonym], ...], shared across UI languages
  function baseOf(tag) { return String(tag || 'en').toLowerCase().split('-')[0]; }
  function strings(tag) { return R.json('strings', baseOf(tag)) || R.json('strings', 'en') || {}; }

  function defaults() { return { language: (navigator.language || 'en-US'), numbers: 'match', dates: 'iso', time: '24h' }; }
  function norm(o) { var d = defaults(); o = o || {}; return { language: o.language || d.language, numbers: o.numbers || d.numbers, dates: o.dates || d.dates, time: o.time || d.time }; }
  var cfg = norm(c.locale);

  /* ---- formatting (logic, not strings): identical to the desktop's so the preview is faithful ---- */
  function groupSep() { var n = cfg.numbers; return n === 'comma' ? '.' : n === 'space' ? ' ' : n === 'apos' ? '’' : n === 'point' ? ',' : ''; }
  function decSep() { var n = cfg.numbers; return (n === 'comma' || n === 'space') ? ',' : '.'; }
  function fmtNumber(n) {
    if (cfg.numbers === 'match') { try { return new Intl.NumberFormat(cfg.language).format(n); } catch (e) {} }
    var neg = n < 0, s = String(Math.abs(n)), parts = s.split('.'), intp = parts[0], g = groupSep();
    if (g) intp = intp.replace(/\B(?=(\d{3})+(?!\d))/g, g);
    return (neg ? '-' : '') + intp + (parts[1] !== undefined ? decSep() + parts[1] : '');
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d, style) {
    style = style || cfg.dates; var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    switch (style) {
      case 'us': return p2(m) + '/' + p2(day) + '/' + y;
      case 'eu': return p2(day) + '/' + p2(m) + '/' + y;
      case 'dot': return p2(day) + '.' + p2(m) + '.' + y;
      case 'long': try { return new Intl.DateTimeFormat(cfg.language, { day: 'numeric', month: 'long', year: 'numeric' }).format(d); } catch (e) { return y + '-' + p2(m) + '-' + p2(day); }
      case 'match': try { return new Intl.DateTimeFormat(cfg.language).format(d); } catch (e) { return y + '-' + p2(m) + '-' + p2(day); }
      default: return y + '-' + p2(m) + '-' + p2(day);
    }
  }
  function fmtTime(d) {
    if (cfg.time === '12h') { var hr = d.getHours(), ap = hr < 12 ? 'AM' : 'PM'; hr = hr % 12 || 12; return hr + ':' + p2(d.getMinutes()) + ' ' + ap; }
    if (cfg.time === 'match') { try { return new Intl.DateTimeFormat(cfg.language, { hour: '2-digit', minute: '2-digit' }).format(d); } catch (e) {} }
    return p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  /* ---- CSS (platinum light / dark, following cvwm.dark) ---- */
  var CSS =
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);' +
      '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;' +
      '--fg:#000;--dim:#555;--field:#fff;--band:#eef3f7}' +
    'body.dark{--grey:#333b41;--lt:rgba(255,255,255,.16);--dk:rgba(0,0,0,.6);--fg:#e8edf1;--dim:#8a929a;--field:#15191c;--band:#222c35}' +
    'html,body{margin:0;height:100%}' +
    'body{background:var(--grey);color:var(--fg);font:13px/1.3 var(--sans);-webkit-user-select:none;user-select:none}' +
    '*{box-sizing:border-box}' +
    '#pane{height:100%;padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px;align-content:start}' +
    'h3{margin:0 0 9px;font:700 11px var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}' +
    '.row{display:grid;grid-template-columns:72px 1fr;align-items:center;gap:8px;margin-bottom:9px}' +
    '.row>label{text-align:left;color:var(--fg)}' +
    'select{height:26px;width:100%;padding:0 24px 0 6px;background:var(--field);color:var(--fg);font:13px var(--sans);' +
      'border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);appearance:none;-webkit-appearance:none;' +
      'background-image:linear-gradient(45deg,transparent 50%,var(--fg) 50%),linear-gradient(135deg,var(--fg) 50%,transparent 50%);' +
      'background-position:calc(100% - 15px) 11px,calc(100% - 10px) 11px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}' +
    'select:focus{outline:1px solid var(--fg)}' +
    '.pv{background:var(--band);border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);padding:9px 11px;' +
      'display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font:12px var(--mono);color:var(--fg)}' +
    '.pv .k{color:var(--dim);white-space:nowrap}' +
    '.note{grid-column:1/-1;margin-top:3px;font:11px var(--sans);color:var(--dim)}';
  D.head.appendChild(mk('style', { text: CSS }));

  /* ---- build ---- */
  function mk(tag, attrs, kids) {
    var e = D.createElement(tag); attrs = attrs || {};
    for (var k in attrs) { if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (n) { if (n) e.appendChild(n); }); return e;
  }
  function select(opts, value, onChange) {
    var s = mk('select');
    opts.forEach(function (o) { var op = mk('option', { value: o[0], text: o[1] }); if (o[0] === value) op.selected = true; s.appendChild(op); });
    s.addEventListener('change', function () { onChange(s.value); }); return s;
  }
  function row(label, control) { return mk('div', { class: 'row' }, [mk('label', { text: label }), control]); }

  var noteCell = mk('div', { class: 'note' }), pv = mk('div', { class: 'pv' });
  var root = mk('div', { id: 'pane' });
  D.body.appendChild(root);

  function render() {
    var S = strings(cfg.language);
    if (c.setTitle) c.setTitle(S.title);
    root.textContent = '';
    root.appendChild(mk('div', {}, [
      mk('h3', { text: S.settings }),
      row(S.language, select(LANGS, cfg.language, function (v) { cfg.language = v; changed(true); })),
      row(S.numbers, select(S.opt_numbers, cfg.numbers, function (v) { cfg.numbers = v; changed(false); })),
      row(S.dates, select(S.opt_dates, cfg.dates, function (v) { cfg.dates = v; changed(false); })),
      row(S.time, select(S.opt_time, cfg.time, function (v) { cfg.time = v; changed(false); }))
    ]));
    root.appendChild(mk('div', {}, [mk('h3', { text: S.preview }), pv]));
    renderPreview(S);
  }
  function renderPreview(S) {
    S = S || strings(cfg.language);
    var now = new Date(), rows = [
      [S.pv_number, fmtNumber(1234567.89)],
      [S.pv_shortDate, fmtDate(now)],
      [S.pv_longDate, fmtDate(now, 'long')],
      [S.pv_time, fmtTime(now)]
    ];
    pv.textContent = '';
    rows.forEach(function (r) { pv.appendChild(mk('span', { class: 'k', text: r[0] })); pv.appendChild(mk('span', { text: r[1] })); });
    pv.appendChild(noteCell);
  }

  /* ---- apply + persist ---- */
  var saveTimer = null;
  function changed(languageChanged) {
    noteCell.textContent = '';
    if (languageChanged) render(); else renderPreview();   // a new UI language relabels the whole panel at once
    try { localStorage.setItem('cvwm.locale', JSON.stringify(cfg)); } catch (e) {}
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }
  function headers(extra) { var h = {}; for (var k in (c.headers || {})) h[k] = c.headers[k]; if (extra) for (var j in extra) h[j] = extra[j]; return h; }
  async function ensureDir(url) {
    try { var pr = await fetch(url + '?objectType', { headers: headers({ Accept: 'application/cdmi-container' }) });
      if (pr.status === 404) await fetch(url, { method: 'PUT', headers: headers({ 'Content-Type': 'application/cdmi-container', Accept: 'application/cdmi-container' }), body: JSON.stringify({ metadata: {} }) });
    } catch (e) {}
  }
  async function persist() {
    var S = strings(cfg.language);
    if (!c.homeURI) { noteCell.textContent = S.note_session; return; }
    var baseU = c.homeURI + 'proc/', dir = baseU + 'control_panels/', url = dir + 'locale';
    try {
      await ensureDir(baseU); await ensureDir(dir);
      var res = await fetch(url, { method: 'PUT', headers: headers({ 'Content-Type': 'application/cdmi-object', Accept: 'application/cdmi-object' }),
        body: JSON.stringify({ mimetype: 'application/json', metadata: {}, valuetransferencoding: 'utf-8', value: JSON.stringify(Object.assign({}, cfg, { updated: new Date().toISOString() }), null, 2) }) });
      noteCell.textContent = res.ok ? '' : S.note_fail.replace('{s}', res.status);
    } catch (e) { noteCell.textContent = S.note_fail.replace('{s}', (e && e.message) || e); }
  }

  /* ---- load the saved object (authoritative), then first render; follow external locale + dark changes ---- */
  (async function () {
    if (c.homeURI) {
      try {
        var got = await fetch(c.homeURI + 'proc/control_panels/locale?value', { headers: headers({ Accept: 'application/cdmi-object' }) });
        if (got.ok) { var rep = await got.json(); var raw = rep.value; if (rep.valuetransferencoding === 'base64') { try { raw = decodeURIComponent(escape(atob(raw))); } catch (e) { raw = atob(raw); } }
          cfg = norm(JSON.parse(raw)); }
      } catch (e) {}
    }
    render();
  })();

  window.addEventListener('storage', function (ev) {
    if (ev.key === 'cvwm.dark') { D.body.classList.toggle('dark', ev.newValue === 'on'); return; }
    if (ev.key === 'cvwm.locale' && ev.newValue) {                        // another window changed the locale: follow it
      try { var o = norm(JSON.parse(ev.newValue)); var relang = o.language !== cfg.language; cfg = o; relang ? render() : renderPreview(); } catch (e) {}
    }
  });
  try { D.body.classList.toggle('dark', localStorage.getItem('cvwm.dark') === 'on'); } catch (e) {}

  if (c.fixed) c.fixed(560, 220); else if (c.resize) c.resize(560, 220);   // a settings panel: fixed size, not resizable
})();
