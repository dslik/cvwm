/*!
 * pdfviewer for cvwm: opens a PDF file and shows it with the browser's built-in PDF renderer.
 *
 * A file arrives one of two ways, like mdviewer: as a CDMI data object (CTX.startURI, when opened from a container),
 * or dropped onto the window. Either way the bytes are fetched, turned into a blob: URL, and shown in an inner frame
 * that the browser renders with its native PDF viewer. No external libraries.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var HEADERS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string; the stylesheet is pulled where present.
  var R = CTX.rsrc || null;
  function S(id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; }
  var T_OBJECT = 'application/cdmi-object';

  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code-bg:#eff1f3;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code-bg:#151b23;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    'body{display:flex;flex-direction:column;}' +
    '#bar{display:flex;align-items:center;gap:10px;padding:6px 10px;border-bottom:1px solid var(--border);flex:none;}' +
    '#bar .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}' +
    '#bar button{height:28px;padding:0 12px;font-size:13px;background:var(--code-bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;cursor:pointer;}' +
    '#bar button:hover{border-color:var(--muted);}' +
    '#view{flex:1;min-height:0;position:relative;background:var(--panel);}' +
    '#pdf{width:100%;height:100%;border:0;display:block;background:var(--panel);}' +
    '.empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;box-sizing:border-box;text-align:center;color:var(--muted);}' +
    '.empty code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code-bg);padding:1px 5px;border-radius:3px;word-break:break-all;}';
  style.textContent = (R && R.text('styles', 'pdfviewer')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    for (var k in props) { if (k === 'text') e.textContent = props[k]; else if (k === 'html') e.innerHTML = props[k]; else e.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  var nameEl = el('span', { class: 'name', text: S('title', 'pdfviewer') });
  var openBtn = el('button', { type: 'button', title: S('openTitle', 'Open a PDF object from a disk') }, [document.createTextNode(S('open', 'Open\u2026'))]);
  var bar = el('div', { id: 'bar' }, [nameEl, openBtn]);
  var view = el('div', { id: 'view' });
  document.body.appendChild(bar); document.body.appendChild(view);
  if (CTX.resize) CTX.resize(900, 760);

  var blobUrl = null;
  function revoke() { if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ } blobUrl = null; } }
  window.addEventListener('unload', revoke);

  var NAME = S('title', 'pdfviewer');
  function setTitle(t) { nameEl.textContent = t; if (CTX.setTitle) CTX.setTitle(t === NAME ? NAME : NAME + ' \u2014 ' + t); }

  function showEmpty() {
    revoke();
    view.textContent = '';
    setTitle(NAME);
    // The desktop shows a native drop pane over this app's (hidden) frame, so a dropped host file or a dragged cvwm
    // object lands on it directly. Once a document loads we call desktop.showApp and the frame shows.
    if (CTX.desktop && CTX.desktop.dropPane && CTX.id !== undefined) {
      CTX.desktop.dropPane(CTX.id, {
        label: S('openFile', 'Open a PDF file'),
        openLabel: S('open', 'Open\u2026'),
        onOpen: openPicker,
        onFile: function (f) { renderBlob(f, f.name); },
        onObject: function (url) { if (/^https:/i.test(url)) loadCdmi(url); }
      });
    }
  }

  function showError(where, msg) {
    revoke();
    view.textContent = '';
    view.appendChild(el('div', { class: 'empty', html: escapeHtml(S('couldNotOpen', 'Could not open')) + ' <code>' + escapeHtml(where) + '</code><br><br>' + escapeHtml(msg) }));
    setTitle(NAME);
  }

  // Render a Blob (from a host-file drop) or bytes (from CDMI) with the browser's PDF viewer, in an inner frame.
  function renderBlob(blob, title) {
    if (CTX.desktop && CTX.desktop.showApp && CTX.id !== undefined) CTX.desktop.showApp(CTX.id);  // reveal the frame; the pane stops being a drop target
    revoke();
    // Force the PDF media type so the browser picks its PDF viewer even if the source lacked a type.
    var pdf = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
    blobUrl = URL.createObjectURL(pdf);
    view.textContent = '';
    var frame = el('iframe', { id: 'pdf', title: title || 'PDF', src: blobUrl });
    view.appendChild(frame);
    setTitle(title || S('document', 'document'));
  }

  function openPicker() {
    if (CTX.desktop && CTX.desktop.pickObject) {
      CTX.desktop.pickObject({
        title: S('openFile', 'Open a PDF file'),
        startURI: CTX.baseURI || CTX.homeURI || null,
        filter: function (name) { return /\.pdf$/i.test(name); }
      }).then(function (url) { if (url) loadCdmi(url); });
    }
  }
  openBtn.addEventListener('click', openPicker);

  /* ------------------------------------------------------ open a CDMI object as bytes */
  async function loadCdmi(url) {
    var clean = url.replace(/[?#].*$/, '');
    try {
      // Ask for the object's value. A PDF is binary, so it comes back base64-encoded in a CDMI JSON representation;
      // decode it to bytes. (A server that serves the raw octets for a non-CDMI Accept would also work, but we ask
      // for the CDMI representation to stay within the same-origin CDMI contract.)
      var h = { Accept: T_OBJECT }; for (var k in HEADERS) h[k] = HEADERS[k];
      var res = await fetch(clean + '?objectName&mimetype&valuetransferencoding&value', { headers: h, redirect: 'follow', credentials: 'same-origin', cache: 'no-store' });
      if (res.url && !/^https:/i.test(res.url)) throw new Error(S('redirectNonHttps', 'redirected to a non-https URI'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var rep = await res.json();
      var enc = rep.valuetransferencoding || 'utf-8', v = rep.value || '', bytes;
      if (enc === 'base64') bytes = b64(v);
      else if (enc === 'json') throw new Error(S('objectIsJson', 'this object is JSON, not a PDF'));
      else bytes = new TextEncoder().encode(v);   // a PDF stored as text is unusual, but pass the bytes through
      var name = rep.objectName || clean.split('/').pop() || S('document', 'document');
      renderBlob(new Blob([bytes], { type: 'application/pdf' }), name);
    } catch (e) {
      showError(clean, String(e.message || e));
    }
  }
  function b64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  /* ------------------------------------------------------------------------- boot */
  if (CTX.startURI && /^https:/i.test(CTX.startURI) && !/\/$/.test(CTX.startURI.replace(/[?#].*$/, ''))) {
    loadCdmi(CTX.startURI);
  } else {
    showEmpty();
  }
})();
