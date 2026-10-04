/*!
 * Earthworm - a web browser for cvwm, in the loosest sense: a location bar around an iframe.
 * Store this file as "index.js" in a container (for example /earthworm/) and open it from the desktop.
 *
 * The iframe does all the work, so the usual iframe rules apply: a site that forbids framing
 * (X-Frame-Options, or Content-Security-Policy frame-ancestors) stays blank, and the address of a
 * cross-origin page cannot be read back, so links followed inside the page do not update the bar.
 *
 * Back and Forward walk the list of addresses opened from the bar (and, for pages of our own origin, the
 * links followed inside them). Where a link was followed inside a page of another origin, Earthworm knows
 * that the page changed but not to what, so Back first returns to the address the bar shows.
 */
(function () {
  'use strict';

  var CTX = window.CDMI_CONTEXT || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string with optional {token} substitution; the stylesheet, the toolbar arrow icons
  // and the home page are pulled from the fork where present.
  var R = CTX.rsrc || null;
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var HOME = 'about:home';
  var stack = [], at = -1;          // addresses, and where we are among them
  var expecting = false;            // a load we started ourselves is under way
  var drifted = false;              // the frame has left stack[at] for an address we cannot read

  var style = document.createElement('style');
  var DEFAULT_CSS =
    'html,body{margin:0;height:100%}' +
    'body{display:flex;flex-direction:column;background:#bfbfbf;color:#000;font:13px Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif}' +
    '#bar{display:flex;align-items:center;gap:4px;padding:4px 6px;flex:none}' +
    'button{min-width:30px;height:24px;padding:0 8px;display:inline-flex;align-items:center;justify-content:center;background:#bfbfbf;color:#000;font:700 12px inherit;font-family:inherit;border:2px solid;border-color:#fff #555 #555 #fff}' +
    'button:active{border-color:#555 #fff #fff #555}button:disabled{color:#777}button:focus-visible{outline:1px solid #000;outline-offset:1px}' +
    '#url{flex:1;min-width:0;height:24px;box-sizing:border-box;padding:0 6px;background:#fff;color:#000;font:13px "DejaVu Sans Mono",Menlo,Consolas,monospace;border:2px solid;border-color:#555 #fff #fff #555}' +
    '#url:focus{outline:1px solid #000}' +
    '#page{flex:1;min-height:0;width:100%;box-sizing:border-box;background:#fff;border:2px solid;border-color:#555 #fff #fff #555}' +
    '#status{flex:none;padding:2px 8px;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#wrap{flex:1;min-height:0;position:relative;display:flex}' +
    '#page{flex:1}' +
    '#notice{position:absolute;inset:2px;display:none;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;box-sizing:border-box;background:#e8e8e8;color:#222;text-align:center;font:14px/1.5 Helvetica,"Nimbus Sans",Arial,sans-serif}' +
    '#notice.on{display:flex}' +
    '#notice h2{margin:0;font-size:16px}' +
    '#notice p{margin:0;max-width:34em}' +
    '#notice code{font-family:"DejaVu Sans Mono",Menlo,Consolas,monospace;background:#d3d3d3;padding:1px 4px;border-radius:2px;word-break:break-all}';
  style.textContent = (R && R.text('styles', 'earthworm')) || DEFAULT_CSS;
  document.head.appendChild(style);

  /* Drawn, not typed: the triangle characters come out as emoji, at emoji size, on some systems. */
  function arrow(left, bar) {
    return '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style="display:block;fill:currentColor">' +
      (bar ? '<rect x="1" y="1.5" width="2" height="9"/>' : '') +
      '<path d="' + (left ? (bar ? 'M11 1.5V10.5L4 6Z' : 'M9.5 1.5V10.5L2.5 6Z') : 'M2.5 1.5V10.5L9.5 6Z') + '"/></svg>';
  }
  function icon(name, fallback) { var v = R && R.text('icons', name); return v == null ? fallback : v; }

  function el(tag, props, text) { var e = document.createElement(tag); for (var k in props) e.setAttribute(k, props[k]); if (text) e.textContent = text; return e; }
  var back = el('button', { type: 'button', title: S('back', 'Back'), 'aria-label': S('back', 'Back') }); back.innerHTML = icon('back', arrow(true));
  var fwd = el('button', { type: 'button', title: S('forward', 'Forward'), 'aria-label': S('forward', 'Forward') }); fwd.innerHTML = icon('forward', arrow(false));
  var reload = el('button', { type: 'button', title: S('reload', 'Reload') }, S('reload', 'Reload'));
  var home = el('button', { type: 'button', title: S('home', 'Home') }, S('home', 'Home'));
  var url = el('input', { id: 'url', type: 'text', 'aria-label': S('location', 'Location'), spellcheck: 'false', autocomplete: 'off', placeholder: S('urlPlaceholder', 'Type a web address') });
  var go = el('button', { type: 'button' }, S('go', 'Go'));
  var bar = el('div', { id: 'bar' }), page = el('iframe', { id: 'page', title: 'Page' }), status = el('div', { id: 'status', role: 'status' });
  var wrap = el('div', { id: 'wrap' }), notice = el('div', { id: 'notice' });
  [back, fwd, reload, home, url, go].forEach(function (n) { bar.appendChild(n); });
  wrap.appendChild(page); wrap.appendChild(notice);
  document.body.appendChild(bar); document.body.appendChild(wrap); document.body.appendChild(status);

  // A message shown over the page area when a load cannot be displayed. body is a small array of DOM nodes or strings.
  var noticeShown = false;
  function showNotice(heading, body) {
    noticeShown = true;
    notice.textContent = '';
    notice.appendChild(el('h2', null, heading));
    (body || []).forEach(function (n) { notice.appendChild(typeof n === 'string' ? el('p', null, n) : n); });
    notice.classList.add('on');
  }
  function hideNotice() { noticeShown = false; notice.classList.remove('on'); }
  function paragraphWithCode(before, code, after) {
    var p = el('p'); if (before) p.appendChild(document.createTextNode(before));
    p.appendChild(el('code', null, code)); if (after) p.appendChild(document.createTextNode(after)); return p;
  }

  var HOME_PAGE = (R && R.text('text', 'home')) ||
    ('<!doctype html><meta charset="utf-8"><title>Earthworm</title>' +
    '<body style="font:15px/1.5 Georgia,serif;max-width:32em;margin:3em auto;padding:0 1em;color:#222">' +
    '<h1 style="font-size:1.6em;margin:0 0 .4em">Earthworm</h1>' +
    '<p>Type a web address above and press Enter.</p>' +
    '<p style="color:#555">This is an iframe with a location bar. A site that forbids being framed stays blank, and links followed inside a page from another origin do not update the bar, because the browser keeps that address private.</p></body>');

  function normalize(text) {
    text = text.trim();
    if (!text || text === HOME) return HOME;
    var hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|blob|javascript|mailto|file):/i.test(text);   // "host:8080/x" has none
    if (!hasScheme) text = text.charAt(0) === '/' ? new URL(text, CTX.origin || location.href).href : 'https://' + text;
    try { return new URL(text).href; } catch (e) { return text; }   // in the form the browser will report it, so the two compare equal
  }

  function buttons() { back.disabled = at <= 0 && !drifted; fwd.disabled = at >= stack.length - 1; }

  var frameTimer = null;
  function clearFrameTimer() { if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; } }
  function show(address) {
    expecting = true; drifted = false; hideNotice(); clearFrameTimer();
    url.value = address === HOME ? '' : address;
    // The desktop is served over https, so the browser blocks an http: page loaded in the frame as mixed content,
    // silently. Say so rather than showing a blank frame.
    if (/^http:\/\//i.test(address)) {
      expecting = false;
      page.removeAttribute('src'); page.srcdoc = '';   // blank the frame without a cross-origin load that could clear the notice
      status.textContent = '';
      var httpsForm = address.replace(/^http:/i, 'https:');
      showNotice(S('httpTitle', 'This page can\u2019t be shown'), [
        S('httpBody', 'Earthworm runs inside a secure (https) desktop, and a browser will not load an insecure (http) page inside it. This is a browser security rule, not a limit of Earthworm.'),
        paragraphWithCode(S('httpTry', 'Try the secure address instead: '), httpsForm)
      ]);
      buttons(); title(address);
      return;
    }
    status.textContent = S('loading', 'Loading {a} \u2026', { a: address });
    if (address === HOME) { page.removeAttribute('src'); page.srcdoc = HOME_PAGE; }
    else {
      page.removeAttribute('srcdoc'); page.src = address;
      // A site that forbids being framed (X-Frame-Options / frame-ancestors) cannot be shown here. A browser gives the
      // embedding page no readable signal for this: on some browsers the load event is suppressed, on others it fires
      // just as it would for a page that is shown, and the frame is opaque either way. So the most that can be detected
      // without wrongly flagging a working site is the case where no load event arrives at all: the load handler cancels
      // this timer, so a page that did load -- framed successfully or not -- is never flagged.
      var target = address;
      frameTimer = setTimeout(function () {
        frameTimer = null;
        if (!expecting) return;                 // a load arrived; nothing to report
        expecting = false; status.textContent = ''; framingRefused(target);
      }, 8000);
    }
    buttons();
    title(address === HOME ? '' : address);
  }
  function framingRefused(address) {
    var host = ''; try { host = new URL(address).host; } catch (e) { host = address; }
    showNotice(S('refusedTitle', 'This site can\u2019t be shown here'), [
      paragraphWithCode('', host, S('refusedBody1', ' did not load in the frame. The usual cause is that the site forbids being displayed inside another page.')),
      S('refusedBody2', 'Many sites refuse to be embedded, as a security measure. This is the site\u2019s choice, not a limit of Earthworm.')
    ]);
  }
  var NAME = S('title', 'Earthworm');
  function title(address) { var host = ''; try { host = new URL(address).host; } catch (e) { /* about:home */ } if (CTX.setTitle) CTX.setTitle(NAME + (host ? ' \u2014 ' + host : '')); }
  function navigate(text) {
    var address = normalize(text);
    if (/^javascript:/i.test(address)) { status.textContent = S('noJavascript', 'javascript: addresses are not opened.'); return; }
    stack = stack.slice(0, at + 1); stack.push(address); at = stack.length - 1; show(address);
  }

  page.addEventListener('load', function () {
    var ours = expecting, href = null; expecting = false; clearFrameTimer();
    if (ours) hideNotice();                       // a real page arrived; clear any prior notice. A stray about:blank load leaves an intentional notice in place
    if (ours || noticeShown) status.textContent = '';   // clear stale status on a real load, or when a notice now speaks for the frame
    try { href = page.contentWindow.location.href; if (href === 'about:srcdoc' || href === 'about:blank') href = null; }
    catch (e) { /* a page of another origin: its address is not ours to read */ }
    if (ours) {                                   // the load we asked for; a redirect may have landed elsewhere
      if (href && at >= 0 && stack[at] !== HOME) { stack[at] = href; url.value = href; }
    } else if (href) {                            // a link followed inside a page of our own origin: a new entry
      if (href !== stack[at]) { stack = stack.slice(0, at + 1); stack.push(href); at = stack.length - 1; }
      url.value = href; drifted = false;
    } else if (stack[at] !== HOME && !noticeShown) {   // a link followed inside a page of another origin (not our own blanking behind a notice)
      drifted = true; status.textContent = S('drifted', 'A link was followed inside the page; its address is not visible. Back returns to the address shown.');
    }
    if (href && page.contentDocument && page.contentDocument.title && CTX.setTitle) CTX.setTitle(NAME + ' \u2014 ' + page.contentDocument.title);
    buttons();
  });

  back.addEventListener('click', function () { if (drifted) show(stack[at]); else if (at > 0) show(stack[--at]); });
  fwd.addEventListener('click', function () { if (at < stack.length - 1) show(stack[++at]); });
  reload.addEventListener('click', function () { if (at >= 0) show(stack[at]); });
  home.addEventListener('click', function () { navigate(HOME); });
  go.addEventListener('click', function () { navigate(url.value); });
  url.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') navigate(url.value); });
  url.addEventListener('focus', function () { url.select(); });

  navigate(CTX.startURI || HOME);
  url.focus();
})();
