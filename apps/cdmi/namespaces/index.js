/*!
 * namespaces for cvwm: shows the namespaces a CDMI server advertises at /.well-known/cdmi/cdmi_namespaces/, and
 * mounts one as a disk on the desktop.
 *
 * Enter a server origin (https://host:port). The desktop reads the well-known namespaces tree there and lists each
 * base URI it references, with whether it is TLS, same-origin (cvwm mounts same-origin bases), and whether it needs
 * a sign-in. "Mount" adds it to the desktop's disks. The read runs in the desktop, so it uses the desktop's
 * credentials and the same rules cvwm's own discovery follows.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var R = CTX.rsrc || null;
  function S(id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; }

  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--border:#d1d9e0;--code:#eff1f3;--link:#0969da;--ok:#1a7f37;--warn:#9a6700;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--border:#3d444d;--code:#151b23;--link:#4493f8;--ok:#3fb950;--warn:#d29922;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    '#bar{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);}' +
    '#bar input{flex:1;min-width:0;font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#bar button{height:30px;padding:0 12px;font-size:13px;background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;cursor:pointer;}' +
    '#bar button:hover{border-color:var(--muted);}' +
    '#body{padding:12px 14px;overflow:auto;}' +
    '.msg{color:var(--muted);padding:24px 8px;text-align:center;}' +
    '.ns{border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 10px;}' +
    '.ns .name{font-weight:600;}' +
    '.ns .base{font:12px ui-monospace,monospace;color:var(--muted);word-break:break-all;margin:2px 0 6px;}' +
    '.ns .tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;}' +
    '.tag{font-size:11px;padding:1px 7px;border-radius:10px;background:var(--code);color:var(--muted);}' +
    '.tag.ok{color:var(--ok);}.tag.warn{color:var(--warn);}' +
    '.ns .act{display:flex;gap:8px;align-items:center;}' +
    '.ns button{height:28px;padding:0 12px;font-size:13px;background:var(--code);color:var(--fg);border:1px solid var(--border);border-radius:6px;cursor:pointer;}' +
    '.ns button:hover:not(:disabled){border-color:var(--muted);}.ns button:disabled{opacity:.5;cursor:default;}' +
    '.ns .note{font-size:12px;color:var(--muted);}';
  style.textContent = (R && R.text('styles', 'namespaces')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    for (var k in props) { if (k === 'text') e.textContent = props[k]; else if (k === 'html') e.innerHTML = props[k]; else e.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  var input = el('input', { type: 'text', placeholder: S('origin-placeholder','https://host:port'), spellcheck: 'false' });
  var goBtn = el('button', { type: 'button', text: S('discover','Discover') });
  var bar = el('div', { id: 'bar' }, [input, goBtn]);
  var body = el('div', { id: 'body' });
  document.body.appendChild(bar); document.body.appendChild(body);
  if (CTX.resize) CTX.resize(680, 520);
  if (CTX.setTitle) CTX.setTitle(S('title','namespaces'));

  // Default the origin to the desktop's own server, derived from any mounted disk's base URI.
  (function () {
    try {
      var m = (D.mounted && D.mounted()) || [];
      var base = (m[0] && m[0].base) || CTX.baseURI || CTX.origin || '';
      var u = base && new URL(base); if (u) input.value = u.protocol + '//' + u.host;
    } catch (e) { if (CTX.origin) input.value = CTX.origin; }
  })();

  function mountedBases() {
    try { return ((D.mounted && D.mounted()) || []).map(function (d) { return d.base; }); } catch (e) { return []; }
  }

  function show(list) {
    body.textContent = '';
    if (!list) return;
    if (!list.namespaces.length) { body.appendChild(el('div', { class: 'msg', text: S('no-namespaces-prefix','No namespaces are advertised at ') + list.origin + S('no-namespaces-suffix','/.well-known/cdmi/cdmi_namespaces/.') })); return; }
    var mounted = mountedBases();
    list.namespaces.forEach(function (ns) {
      var tags = el('div', { class: 'tags' });
      if (ns.base) {
        tags.appendChild(el('span', { class: 'tag' + (ns.tls ? ' ok' : ' warn'), text: ns.tls ? S('tag-tls','TLS') : S('tag-not-https','not https') }));
        tags.appendChild(el('span', { class: 'tag' + (ns.sameOrigin ? ' ok' : ' warn'), text: ns.sameOrigin ? S('tag-same-origin','same origin') : S('tag-other-origin','other origin') }));
        if (ns.locked) tags.appendChild(el('span', { class: 'tag warn', text: S('tag-locked','sign in to read') }));
      }
      var card = el('div', { class: 'ns' }, [
        el('div', { class: 'name', text: ns.name }),
        el('div', { class: 'base', text: ns.base || S('no-base','(no base URI)') }),
        tags
      ]);
      var act = el('div', { class: 'act' });
      if (!ns.base) {
        act.appendChild(el('span', { class: 'note', text: ns.reason || S('reason-default','this reference does not lead to a base URI') }));
      } else if (!ns.tls) {
        act.appendChild(el('span', { class: 'note', text: S('mounts-https-only','cvwm mounts only https: base URIs') }));
      } else if (!ns.sameOrigin) {
        act.appendChild(el('span', { class: 'note', text: S('mounts-same-origin','cvwm mounts only same-origin base URIs (spec 302)') }));
      } else if (mounted.indexOf(ns.base) >= 0) {
        var b0 = el('button', { type: 'button', disabled: 'disabled', text: S('mounted','Mounted') }); act.appendChild(b0);
      } else {
        var b = el('button', { type: 'button', text: S('mount','Mount') });
        b.addEventListener('click', function () {
          if (D.mount && D.mount(ns.base, ns.name)) { b.textContent = S('mounted','Mounted'); b.disabled = true; }
        });
        act.appendChild(b);
      }
      card.appendChild(act);
      body.appendChild(card);
    });
  }

  async function discover() {
    var origin = input.value.trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(origin)) { body.textContent = ''; body.appendChild(el('div', { class: 'msg', text: S('origin-help','A server origin is an https: URL, for example https://cdmi.example.local:9443') })); return; }
    body.textContent = ''; body.appendChild(el('div', { class: 'msg', text: S('reading','Reading \u2026') }));
    try {
      if (!D.wellKnown) throw new Error(S('not-supported','this desktop does not support namespace discovery'));
      var list = await D.wellKnown(origin);
      show(list);
    } catch (e) {
      body.textContent = '';
      body.appendChild(el('div', { class: 'msg', html: S('could-not-read-prefix','Could not read the namespaces at ') + '<code>' + origin + '</code><br><br>' + (e && e.message ? String(e.message) : S('no-answer','The server did not answer.')) }));
    }
  }

  goBtn.addEventListener('click', discover);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') discover(); });
  if (input.value) discover();
})();
