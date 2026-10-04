/*!
 * capture for cvwm: a screen-grabber. It takes a picture of the whole screen, of a chosen window, or of a rectangle
 * dragged on the desktop, and saves it to the home directory as a PNG.
 *
 * The pixels can only be read by the desktop itself -- an application runs in an iframe and cannot see outside it, and
 * the one browser API that rasterizes a tab (including the other apps' iframes) is getDisplayMedia, which the top-level
 * desktop page holds. So the desktop does the grab (cvwm.js: capturePng) and this app is the control panel: it picks
 * the mode and the target, asks the desktop for the PNG, and writes it into the user's home with a timestamped name.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var HDRS = CTX.headers || {};
  var T_OBJECT = 'application/cdmi-object';

  var style = document.createElement('style');
  style.textContent =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code:#eff1f3;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code:#151b23;--accent:#4493f8;--ok:#3fb950;--err:#f85149;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 var(--sans);}' +
    'body{display:flex;flex-direction:column;}' +
    '#bar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;border-bottom:1px solid var(--border);}' +
    'button{height:30px;padding:0 14px;font:600 13px var(--sans);color:var(--fg);background:var(--code);border:1px solid var(--border);border-radius:6px;cursor:pointer;}' +
    'button:hover{border-color:var(--muted);}button.go{background:var(--accent);color:#fff;border-color:var(--accent);}button:disabled{opacity:.55;cursor:default;}' +
    '#winrow{flex:none;display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);background:var(--panel);}' +
    '#winrow label{color:var(--muted);flex:none;}' +
    'select{flex:1;min-width:0;height:28px;font:12px var(--sans);padding:0 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#status{flex:none;padding:6px 10px;font:12px var(--mono);color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}#status .ok{color:var(--ok);}#status .err{color:var(--err);}' +
    '#view{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:12px;background:var(--panel);}' +
    '#view img{max-width:100%;max-height:100%;border:1px solid var(--border);background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.15);}' +
    '#view .hint{color:var(--muted);text-align:center;}';
  document.head.appendChild(style);

  function el(t, p, k) { var e = document.createElement(t); for (var x in (p || {})) { if (x === 'text') e.textContent = p[x]; else e.setAttribute(x, p[x]); } (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }

  var bScreen = el('button', { class: 'go', type: 'button', text: 'Whole screen' });
  var bRect = el('button', { type: 'button', text: 'Rectangle' });
  var bar = el('div', { id: 'bar' }, [bScreen, bRect]);

  var sel = el('select', { 'aria-label': 'Window to capture' });
  var bWin = el('button', { type: 'button', text: 'Capture window' });
  var bRefresh = el('button', { type: 'button', title: 'Refresh the window list', text: '↻' });
  var winrow = el('div', { id: 'winrow' }, [el('label', { text: 'Window' }), sel, bRefresh, bWin]);

  var statusEl = el('div', { id: 'status' });
  var view = el('div', { id: 'view' }, [el('div', { class: 'hint', text: 'Pick what to capture. The image is saved to your home directory.' })]);
  document.body.appendChild(bar); document.body.appendChild(winrow); document.body.appendChild(statusEl); document.body.appendChild(view);

  if (CTX.setTitle) CTX.setTitle('capture');
  if (CTX.resize) CTX.resize(520, 460);

  function setStatus(t, cls) { statusEl.textContent = ''; statusEl.appendChild(el('span', { class: cls || '', text: t })); }

  // The windows that can be a capture target: every open window (dialogs and viewers too) except this one. The desktop
  // as a whole is "Whole screen".
  function fillWindows() {
    sel.textContent = '';
    var list = typeof D.captureTargets === 'function' ? D.captureTargets(CTX.id)
      : (typeof D.windows === 'function' ? D.windows() : []).filter(function (w) { return w.id !== 'desktop' && w.id !== CTX.id; });
    if (!list.length) { var o = el('option', { value: '' }, ['(no other windows open)']); sel.appendChild(o); sel.disabled = bWin.disabled = true; return; }
    sel.disabled = bWin.disabled = false;
    list.forEach(function (w) { sel.appendChild(el('option', { value: w.id }, [w.title || w.id])); });
  }
  bRefresh.addEventListener('click', fillWindows);

  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  async function save(dataURL) {
    if (!CTX.homeURI) throw new Error('No home directory is mounted to save into.');
    var base = CTX.homeURI; if (!/\/$/.test(base)) base += '/';
    var name = 'capture-' + stamp() + '.png';
    var b64 = String(dataURL).replace(/^data:[^,]*,/, '');
    var hh = { 'Content-Type': T_OBJECT, Accept: T_OBJECT }; for (var k in HDRS) hh[k] = HDRS[k];
    var res = await fetch(base + encodeURIComponent(name), { method: 'PUT', headers: hh, credentials: 'same-origin',
      body: JSON.stringify({ mimetype: 'image/png', valuetransferencoding: 'base64', value: b64, metadata: {} }) });
    if (!(res.status === 201 || res.status === 202 || res.status === 204)) {
      var detail = ''; try { var j = await res.json(); detail = (j && (j.title || j.detail)) || ''; } catch (e) {}
      throw new Error('could not save (HTTP ' + res.status + (detail ? ': ' + detail : '') + ')');
    }
    return name;
  }

  function showPreview(dataURL) { view.textContent = ''; view.appendChild(el('img', { src: dataURL, alt: 'capture' })); }

  var busy = false;
  async function doCapture(opts, label) {
    if (busy) return;
    if (typeof D.capturePng !== 'function') { setStatus('This desktop does not support screen capture.', 'err'); return; }
    busy = true; setButtons(true); setStatus('Capturing ' + label + ' … (allow sharing this tab if asked)');
    try {
      var dataURL = await D.capturePng(Object.assign({ hideId: CTX.id }, opts));
      if (!dataURL) { setStatus('Cancelled.', ''); return; }           // the region select was dismissed
      showPreview(dataURL);
      setStatus('Saving …');
      var name = await save(dataURL);
      setStatus('Saved to ~/' + name, 'ok');
    } catch (e) {
      setStatus((e && e.message) || 'Capture failed.', 'err');
    } finally { busy = false; setButtons(false); }
  }
  function setButtons(on) { bScreen.disabled = bRect.disabled = bRefresh.disabled = on; bWin.disabled = on || sel.disabled; }

  bScreen.addEventListener('click', function () { doCapture({ mode: 'screen' }, 'the whole screen'); });
  bRect.addEventListener('click', function () { doCapture({ mode: 'rect' }, 'a region'); });
  bWin.addEventListener('click', function () { if (sel.value) doCapture({ mode: 'window', winId: sel.value }, 'a window'); });

  fillWindows();
  setStatus('Ready.');
})();
