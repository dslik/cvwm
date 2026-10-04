/*!
 * Smart-folder bootstrap — a container that carries THIS file as its index.js is a "smart folder". It reads a saved
 * CDMI query scope from its own container metadata (cvwm_query) and runs it with the shared engine (code/engine) in
 * its own fork, showing the live matches as a container would show its children. Because the engine travels in the
 * fork, a smart folder is self-contained and can simply be copied; nothing points outside it.
 *
 * The query app stamps this file (and a copy of the engine) into a new container when you choose "Save as Smart
 * Folder…", so this bootstrap and that engine come from the query app's own resources and never drift from it.
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var R = CTX.rsrc || null;
  var HDRS = CTX.headers || {};
  function S(id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; }
  function slash(u) { return u && !/\/$/.test(u) ? u + '/' : u; }
  var CONTAINER = slash(CTX.containerURI || CTX.baseURI || '');
  var BASE = slash(CTX.baseURI || CONTAINER);
  var HOME = CTX.homeURI ? slash(CTX.homeURI) : null;
  var MT_CONTAINER = 'application/cdmi-container';

  var style = document.createElement('style');
  style.textContent =
    'html,body{margin:0;height:100%}' +
    'body{display:flex;flex-direction:column;background:#bfbfbf;color:#000;font:13px Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif}' +
    '.sfbar{flex:none;display:flex;align-items:center;gap:8px;padding:6px 8px}' +
    '.sfbar .t{font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.sfbar button{height:24px;padding:0 10px;font:700 12px Helvetica,Arial,sans-serif;color:#000;background:#bfbfbf;' +
    'border:2px solid;border-color:rgba(255,255,255,.6) rgba(0,0,0,.55) rgba(0,0,0,.55) rgba(255,255,255,.6)}' +
    '.sfbar button:active{border-color:rgba(0,0,0,.55) rgba(255,255,255,.6) rgba(255,255,255,.6) rgba(0,0,0,.55)}' +
    '.sfmsg{margin:12px;color:#a00;font:12px "DejaVu Sans Mono",monospace}';
  document.head.appendChild(style);

  var title = '';
  var bar = document.createElement('div'); bar.className = 'sfbar';
  var tEl = document.createElement('span'); tEl.className = 't';
  var refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = S('refresh', '↻ Refresh');
  bar.appendChild(tEl); bar.appendChild(refresh);
  document.body.appendChild(bar);

  // Collect the literal values a scope matches on, so the engine can rank results by name relevance (the same terms
  // the query app would have collected when it built the scope).
  function termsFromScope(scope) {
    var terms = [];
    (Array.isArray(scope) ? scope : []).forEach(function (clause) {
      if (!clause || typeof clause !== 'object') return;
      function collect(v) { (Array.isArray(v) ? v : [v]).forEach(function (expr) { var m = /^(contains|starts|ends|==|tag)\s+([\s\S]*)$/.exec(String(expr)); if (m) terms.push(m[2].toLowerCase()); }); }
      Object.keys(clause).forEach(function (k) { if (k !== 'metadata' && k !== 'parentURI') collect(clause[k]); });
      var md = clause.metadata || {};
      Object.keys(md).forEach(function (k) { collect(md[k]); });
    });
    return terms;
  }

  var engine = null, scope = [];
  function run() { if (engine) engine.run(scope, termsFromScope(scope)); }
  refresh.onclick = run;

  async function load() {
    try {
      var res = await fetch(CONTAINER + '?objectName&metadata=cvwm_query', { headers: Object.assign({ Accept: MT_CONTAINER }, HDRS), credentials: 'same-origin' });
      var rep = await res.json();
      title = (rep.objectName || '').replace(/\/$/, '');
      var q = rep.metadata && rep.metadata.cvwm_query;
      if (typeof q === 'string') { try { q = JSON.parse(q); } catch (e) {} }
      scope = Array.isArray(q) ? q : [];
    } catch (e) {}
    if (CTX.setTitle) CTX.setTitle(title || S('sf-title', 'smart folder'));
    tEl.textContent = title || S('sf-title', 'smart folder');
    if (!(R && R.module)) { var m = document.createElement('div'); m.className = 'sfmsg'; m.textContent = S('no-engine', 'The query engine resource (code/engine) is missing.'); document.body.appendChild(m); return; }
    try {
      var mod = await R.module('code', 'engine');
      engine = (mod.createEngine || mod.default)({ headers: HDRS, desktop: D, rsrc: R, container: CONTAINER, base: BASE, home: HOME, S: S });
      document.body.appendChild(engine.el);
      run();
    } catch (e) {
      var m2 = document.createElement('div'); m2.className = 'sfmsg'; m2.textContent = (S('no-engine', 'The query engine resource (code/engine) is missing.')) + ' ' + (e && e.message || e); document.body.appendChild(m2);
    }
  }

  if (CTX.resize) CTX.resize(680, 460);
  load();
})();
