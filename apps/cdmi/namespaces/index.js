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
  function S(id, vars) { var v = R && R.text('strings', id); if (v == null) return id; if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]); return v; }

  var style = document.createElement('style');
  style.textContent = R.text('styles', 'namespaces');
  document.head.appendChild(style);

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    for (var k in props) { if (k === 'text') e.textContent = props[k]; else if (k === 'html') e.innerHTML = props[k]; else e.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  var input = el('input', { type: 'text', placeholder: S('origin-placeholder'), spellcheck: 'false' });
  var goBtn = el('button', { type: 'button', text: S('discover') });
  var bar = el('div', { id: 'bar' }, [input, goBtn]);
  var body = el('div', { id: 'body' });
  document.body.appendChild(bar); document.body.appendChild(body);
  // One light/dark setting serves the whole desktop: the shared cvwm.dark key in localStorage, which the desktop
  // toggles (View > Dark mode) and every app follows by mirroring it onto body.dark.
  function setDark(on) { document.body.classList.toggle('dark', !!on); }
  try { setDark(localStorage.getItem('cvwm.dark') === 'on'); } catch (e) { /* no storage */ }
  window.addEventListener('storage', function (ev) { if (ev.key === 'cvwm.dark') setDark(ev.newValue === 'on'); });
  if (CTX.resize) CTX.resize(680, 520);
  if (CTX.setTitle) CTX.setTitle(S('title'));

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
    if (!list.namespaces.length) { body.appendChild(el('div', { class: 'msg', text: S('no-namespaces-prefix') + list.origin + S('no-namespaces-suffix') })); return; }
    var mounted = mountedBases();
    list.namespaces.forEach(function (ns) {
      var tags = el('div', { class: 'tags' });
      if (ns.base) {
        tags.appendChild(el('span', { class: 'tag' + (ns.tls ? ' ok' : ' warn'), text: ns.tls ? S('tag-tls') : S('tag-not-https') }));
        tags.appendChild(el('span', { class: 'tag' + (ns.sameOrigin ? ' ok' : ' warn'), text: ns.sameOrigin ? S('tag-same-origin') : S('tag-other-origin') }));
        if (ns.locked) tags.appendChild(el('span', { class: 'tag warn', text: S('tag-locked') }));
      }
      var card = el('div', { class: 'ns' }, [
        el('div', { class: 'name', text: ns.name }),
        el('div', { class: 'base', text: ns.base || S('no-base') }),
        tags
      ]);
      var act = el('div', { class: 'act' });
      if (!ns.base) {
        act.appendChild(el('span', { class: 'note', text: ns.reason || S('reason-default') }));
      } else if (!ns.tls) {
        act.appendChild(el('span', { class: 'note', text: S('mounts-https-only') }));
      } else if (!ns.sameOrigin) {
        act.appendChild(el('span', { class: 'note', text: S('mounts-same-origin') }));
      } else if (mounted.indexOf(ns.base) >= 0) {
        var b0 = el('button', { type: 'button', disabled: 'disabled', text: S('mounted') }); act.appendChild(b0);
      } else {
        var b = el('button', { type: 'button', text: S('mount') });
        b.addEventListener('click', function () {
          if (D.mount && D.mount(ns.base, ns.name)) { b.textContent = S('mounted'); b.disabled = true; }
        });
        act.appendChild(b);
      }
      card.appendChild(act);
      body.appendChild(card);
    });
  }

  async function discover() {
    var origin = input.value.trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(origin)) { body.textContent = ''; body.appendChild(el('div', { class: 'msg', text: S('origin-help') })); return; }
    body.textContent = ''; body.appendChild(el('div', { class: 'msg', text: S('reading') }));
    try {
      if (!D.wellKnown) throw new Error(S('not-supported'));
      var list = await D.wellKnown(origin);
      show(list);
    } catch (e) {
      body.textContent = '';
      body.appendChild(el('div', { class: 'msg', html: S('could-not-read-prefix') + '<code>' + origin + '</code><br><br>' + (e && e.message ? String(e.message) : S('no-answer')) }));
    }
  }

  goBtn.addEventListener('click', discover);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') discover(); });
  if (input.value) discover();
})();
