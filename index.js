/*!
 * /desktop/index.js — a stub so the desktop container is not mistaken for a runnable application.
 *
 * /desktop/ holds the desktop itself: cvwm.js and index.html, served to the browser through the server's HTTP export.
 * A browser opens index.html, which loads cvwm.js and becomes the desktop. But /desktop/ also looks like a cvwm
 * application to the desktop (a container with an index.js), so opening it from a file browser or the shell would try
 * to run the window manager inside one of its own windows. This index.js is that entry point: instead of doing
 * anything, it says plainly that this application provides the desktop and cannot be run from within it.
 *
 * Its look is cvwm's own: the platinum palette, Helvetica, and the bevelled .fv-btn the ACL editor and the other
 * dialogs use, so it sits in the desktop as a native dialog rather than a web page.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};

  var style = document.createElement('style');
  style.textContent =
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);' +
    '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace}' +
    'html,body{margin:0;height:100%}' +
    'body{display:flex;flex-direction:column;background:var(--grey);color:#000;font:13px/1.3 var(--sans);' +
    'user-select:none;-webkit-user-select:none}' +
    '.fv-form{flex:1;padding:14px 16px;display:flex;flex-direction:column;gap:12px;overflow:auto;box-sizing:border-box}' +
    '.fv-form p{margin:0;line-height:18px}' +
    '.row{display:flex;align-items:flex-start;gap:12px}' +
    '.mark{flex:none;width:52px;height:52px;border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk);' +
    'background:#7d93a8;display:flex;align-items:center;justify-content:center;color:#f5f8fa;font:italic 700 18px var(--sans)}' +
    '.fv-row.end{display:flex;justify-content:flex-end;gap:6px;margin-top:auto}' +
    '.fv-btn{min-width:84px;height:28px;padding:0 12px;background:var(--grey);font:700 13px var(--sans);color:#000;' +
    'border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}' +
    '.fv-btn:active{border-color:var(--dk) var(--lt) var(--lt) var(--dk)}' +
    '.fv-btn:focus-visible{outline:1px solid #000;outline-offset:2px}';
  document.head.appendChild(style);

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    for (var k in (props || {})) { if (k === 'text') e.textContent = props[k]; else e.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  var ok = el('button', { class: 'fv-btn', type: 'button', 'data-autofocus': '' }, ['OK']);
  ok.addEventListener('click', function () { if (CTX.close) CTX.close(); });

  document.body.appendChild(el('div', { class: 'fv-form' }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'mark', 'aria-hidden': 'true' }, ['cvwm']),
      el('p', { text: 'This application provides the desktop, and cannot be run from within the desktop.' })
    ]),
    el('div', { class: 'fv-row end' }, [ok])
  ]));

  if (CTX.setTitle) CTX.setTitle('cvwm');
  if (CTX.resize) CTX.resize(420, 180);
  ok.focus();
})();
