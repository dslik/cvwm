/*!
 * relationships for cvwm: a rel-driven graph visualizer for a CDMI server. It reads an object's "rel" field -- the graph
 * relationships of the representation, an RDF/JSON serialization of RDF triples (13.6, annex A) -- and draws the object
 * and the objects its rel links to as a force-directed graph. Clicking a linked object that this server holds expands
 * it: its own rel is read and merged into the graph. A new link can be created from the selected object; it is added to
 * that object's rel field and written back with a field update.
 *
 * The rel field is an object of subjects; each subject maps predicates to arrays of graph objects. A graph object of
 * type "uri" (or a bnode) is a link to another node; a "literal" is a property of the subject, shown in the detail
 * panel. relationships authors links as { "<subject-url>": { "<predicate>": [ { "value": "<target-url>", "type": "uri" } ] } },
 * the subject being the object's own URL, so an added link attaches to the object it was added from.
 *
 * The server stores rel but does not interpret it (it resolves no URI and checks no target exists), so a link may point
 * at anything; relationships only offers to expand a node that is an object of this same server (same origin, over https).
 */
(function () {
  'use strict';
  var CTX = window.CDMI_CONTEXT || {};
  var D = CTX.desktop || {};
  var HDRS = CTX.headers || {};
  var HOME = (function () { try { return new URL(CTX.baseURI || CTX.origin).origin; } catch (e) { return CTX.origin || ''; } })();
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string with optional {token} substitution; the stylesheet and the CDMI media-type
  // set are pulled from the fork where present.
  var R = CTX.rsrc || null;
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var CDMI_TYPES = { 'application/cdmi-object': 1, 'application/cdmi-container': 1, 'application/cdmi-queue': 1, 'application/cdmi-domain': 1, 'application/cdmi-capability': 1 };
  if (R) { var _ct = R.json('data', 'cdmitypes'); if (Array.isArray(_ct) && _ct.length) { CDMI_TYPES = {}; _ct.forEach(function (t) { CDMI_TYPES[t] = 1; }); } }

  var style = document.createElement('style');
  var DEFAULT_CSS =
    ':root{--fg:#1f2328;--muted:#59636e;--bg:#fff;--panel:#f6f8fa;--border:#d1d9e0;--code:#eff1f3;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--edge:#8c95a1;--node:#0969da;--node2:#6e7781;--focus:#bf3989;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;}' +
    '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--panel:#151b23;--border:#3d444d;--code:#151b23;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--edge:#556;--node:#4493f8;--node2:#7d8590;--focus:#db61a2;}}' +
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
    'body{display:flex;flex-direction:column;}' +
    '#top{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);flex:none;}' +
    '#top input{flex:1 1 0;height:30px;box-sizing:border-box;min-width:0;font:12px var(--mono);padding:0 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#top button{height:30px;flex:none;padding:0 14px;border:1px solid var(--border);border-radius:6px;background:var(--code);color:var(--fg);cursor:pointer;font-size:12px;}' +
    '#top button.go{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600;}' +
    '#cols{flex:none;height:140px;display:flex;overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--border);background:var(--panel);}' +
    '#cols .col{flex:0 0 210px;min-width:210px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--bg);}' +
    '#cols .col:nth-child(even){background:var(--panel);}' +
    '#cols .col-h{flex:none;padding:4px 9px;font:600 10px var(--mono);letter-spacing:.03em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#cols .col-b{flex:1;overflow-y:auto;padding:3px 0;}' +
    '#cols .crow{display:flex;align-items:center;gap:6px;padding:3px 8px 3px 9px;cursor:pointer;font:12px var(--mono);color:var(--fg);border:0;background:none;width:100%;text-align:left;box-sizing:border-box;}' +
    '#cols .crow:hover{background:var(--code);}' +
    '#cols .crow.sel{background:var(--accent);color:#fff;}' +
    '#cols .crow.sel .csub,#cols .crow.sel .ctag,#cols .crow.sel .cchev,#cols .crow.sel .ccnt{color:rgba(255,255,255,.85);}' +
    '#cols .cnm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#cols .csub{color:var(--muted);font-size:10px;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#cols .cchev{flex:none;color:var(--muted);}' +
    '#cols .ccnt{flex:none;color:var(--muted);font-size:10px;}' +
    '#cols .cdot{flex:none;width:8px;height:8px;border-radius:50%;}' +
    '#cols .cdot.object{background:var(--node);}#cols .cdot.reference{background:#8250df;}#cols .cdot.literal{background:var(--node2);border-radius:2px;}#cols .cdot.external{background:#953800;}' +
    '@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) #cols .cdot.reference{background:#c297ff;}:root:not([data-theme="light"]) #cols .cdot.external{background:#db8f4a;}}' +
    '#cols .ctag{flex:none;font-size:9px;padding:0 5px;border-radius:8px;background:var(--code);color:var(--muted);}' +
    '#cols .cempty{color:var(--muted);font:11px var(--mono);padding:9px;}' +
    '#cols .cdetail{padding:8px 9px;font:12px var(--mono);}' +
    '#cols .cdetail .k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.03em;margin-bottom:3px;}' +
    '#cols .cdetail .v{word-break:break-word;white-space:pre-wrap;}' +
    '#cols .cdetail .u{color:var(--muted);font-size:11px;word-break:break-all;margin-top:5px;}' +
    '#resizer{flex:none;height:6px;cursor:row-resize;background:var(--panel);border-bottom:1px solid var(--border);}' +
    '#resizer:hover{background:var(--border);}' +
    '#top button:disabled{opacity:.6;cursor:default;}' +
    '#main{flex:1;min-height:0;display:flex;}' +
    '#canvas{flex:1;min-width:0;position:relative;overflow:hidden;background:var(--bg);}' +
    '#canvas svg{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab;}' +
    '#canvas svg.grabbing{cursor:grabbing;}' +
    '.edge{stroke:var(--edge);stroke-width:1.5;}' +
    '.edge-lbl{fill:var(--muted);font:10px var(--mono);pointer-events:none;}' +
    '.node circle{stroke:var(--bg);stroke-width:2;cursor:pointer;}' +
    '.node.cdmi circle{fill:var(--node);}' +
    '.node.external circle{fill:var(--node2);}' +
    '.node.focus circle{fill:var(--focus);}' +
    '.node.sel circle{stroke:var(--fg);stroke-width:3;}' +
    '.node text{fill:var(--fg);font:11px var(--mono);text-anchor:middle;pointer-events:none;paint-order:stroke;stroke:var(--bg);stroke-width:3px;}' +
    '.node .plus{fill:#fff;font:700 12px var(--mono);text-anchor:middle;stroke:none;pointer-events:none;}' +
    '#side{flex:0 0 268px;border-left:1px solid var(--border);overflow:auto;padding:12px;box-sizing:border-box;}' +
    '#side h3{margin:0 0 2px;font:600 13px var(--mono);word-break:break-all;}' +
    '#side .u{color:var(--muted);font:11px var(--mono);word-break:break-all;margin:0 0 10px;}' +
    '#side .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;background:var(--code);color:var(--muted);margin:0 4px 8px 0;}' +
    '#side .tag.cdmi{color:var(--ok);}#side .tag.external{color:var(--muted);}' +
    '#side .lbl{color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;margin:12px 0 4px;}' +
    '#side table{width:100%;border-collapse:collapse;font:11px var(--mono);}' +
    '#side td{border-top:1px solid var(--border);padding:3px 4px;vertical-align:top;word-break:break-all;}' +
    '#side td.p{color:var(--accent);max-width:60%;}' +
    '#side .field{margin:0 0 8px;}' +
    '#side .field label{display:block;font-size:11px;color:var(--muted);margin:0 0 2px;}' +
    '#side .field input{width:100%;box-sizing:border-box;font:12px var(--mono);padding:5px 7px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#side button{width:100%;height:30px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;margin-top:4px;}' +
    '#side button.sec{background:var(--code);color:var(--fg);border-color:var(--border);font-weight:500;margin-top:6px;}' +
    '#side button:disabled{opacity:.55;cursor:default;}' +
    '#side .note{color:var(--muted);font-size:11px;margin-top:6px;}' +
    '#side .err{color:var(--err);font-size:11px;margin-top:6px;word-break:break-word;}' +
    '#side select{width:100%;box-sizing:border-box;font:12px var(--mono);padding:5px 7px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);}' +
    '#side td.act{white-space:nowrap;text-align:right;width:1%;}' +
    '#side .rowbtn{border:1px solid var(--border);background:var(--code);color:var(--muted);border-radius:5px;cursor:pointer;font:10px var(--mono);padding:1px 5px;margin-left:3px;width:auto;height:auto;}' +
    '#side .rowbtn:hover{color:var(--fg);}' +
    '#status{flex:none;padding:5px 10px;font:12px var(--mono);border-top:1px solid var(--border);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#status .ok{color:var(--ok);}#status .err{color:var(--err);}' +
    '.msg{color:var(--muted);padding:20px 4px;text-align:center;font-size:12px;}';
  style.textContent = (R && R.text('styles', 'relationships')) || DEFAULT_CSS;
  document.head.appendChild(style);
  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(t, p, k) { var e = document.createElement(t); attr(e, p); (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
  function sv(t, p, k) { var e = document.createElementNS(SVGNS, t); attr(e, p); (k || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
  function attr(e, p) { for (var x in (p || {})) { if (x === 'text') e.textContent = p[x]; else if (x === 'html') e.innerHTML = p[x]; else if (p[x] != null) e.setAttribute(x, p[x]); } }

  var urlIn = el('input', { type: 'text', spellcheck: 'false', placeholder: S('urlPlaceholder', 'https://host:port/cdmi/3.0.0/path  ·  or /path/ on this server') });
  var loadBtn = el('button', { class: 'go', type: 'button', text: S('load', 'Load') });
  var fitBtn = el('button', { type: 'button', text: S('fit', 'Fit') });
  var top = el('div', { id: 'top' }, [urlIn, loadBtn, fitBtn]);
  var svg = document.createElementNS(SVGNS, 'svg');
  var viewG = sv('g');
  var edgesG = sv('g'); var nodesG = sv('g');
  viewG.appendChild(edgesG); viewG.appendChild(nodesG); svg.appendChild(viewG);
  var canvas = el('div', { id: 'canvas' }); canvas.appendChild(svg);
  var side = el('div', { id: 'side' }, [el('div', { class: 'msg', text: S('sideIntro', 'Load an object to see its rel graph, then click a linked node to expand it.') })]);
  var main = el('div', { id: 'main' }, [canvas, side]);
  var status = el('div', { id: 'status', text: S('ready', 'Ready.') });
  var colsEl = el('div', { id: 'cols' });                     // the Miller-columns browser, between the URL bar and the graph
  var resizer = el('div', { id: 'resizer', title: 'Drag to resize the columns' });
  document.body.appendChild(top); document.body.appendChild(colsEl); document.body.appendChild(resizer); document.body.appendChild(main); document.body.appendChild(status);
  if (CTX.resize) CTX.resize(940, 640);
  if (CTX.setTitle) CTX.setTitle(S('title', 'relationships'));

  urlIn.value = CTX.startURI || CTX.containerURI || CTX.baseURI || (HOME + '/cdmi/3.0.0/');

  function setStatus(t, cls) { status.textContent = ''; status.appendChild(el('span', { class: cls || '', text: t })); }

  // ---- graph state -------------------------------------------------------------------------------------------------
  var nodes = {}, edges = [], edgeKey = {}, focusUri = null, selected = null, editing = null;
  var view = { x: 0, y: 0, s: 1 };
  var colRoot = null, colChain = [], colReps = {};    // column browser: root object URL, the alternating pred/dest selections, and a rel cache

  // A fragment names a distinct RDF resource -- an object's "#/value" is not the object itself -- so norm keeps it,
  // and canonicalizes only the URL. Relative references (a "/path/" on this server, a "#/value" of an object) are
  // resolved against a base before they reach norm; see loadFocus and doAddLink.
  function norm(u) { try { return new URL(u).href; } catch (e) { return u; } }
  function resolve(v, base) { try { return new URL(v, base).href; } catch (e) { return v; } }
  function isCdmiHere(uri) { try { var u = new URL(uri); return u.origin === HOME && u.protocol === 'https:'; } catch (e) { return false; } }
  function labelOf(uri) { try { var u = new URL(uri); var p = u.pathname.replace(/\/+$/, ''); var seg = p.split('/').pop() || u.host; return (decodeURIComponent(seg) || u.host) + (u.hash || ''); } catch (e) { return String(uri).slice(0, 24); } }

  function ensureNode(uri) {
    uri = norm(uri);
    if (nodes[uri]) return nodes[uri];
    var w = canvas.clientWidth || 600, h = canvas.clientHeight || 400;
    var n = {
      uri: uri, label: labelOf(uri), kind: isCdmiHere(uri) ? 'cdmi' : 'external',
      x: (w / 2 + (Math.random() - 0.5) * 120) / view.s - view.x, y: (h / 2 + (Math.random() - 0.5) * 120) / view.s - view.y,
      vx: 0, vy: 0, pinned: false, expanded: false, loading: false, objectType: null, literals: [], el: null
    };
    nodes[uri] = n; buildNodeEl(n); return n;
  }
  function addEdge(from, to, pred, rawValue) {
    from = norm(from); to = norm(to); if (from === to) return;
    var k = from + '\u0000' + pred + '\u0000' + to; if (edgeKey[k]) { if (rawValue != null) edgeKey[k].rawValue = rawValue; return; }
    var e = { from: from, to: to, pred: pred, rawValue: rawValue != null ? rawValue : to, line: null, lbl: null }; edgeKey[k] = e; edges.push(e); buildEdgeEl(e);
  }

  // Merge an object's rel field into the graph. A uri/bnode graph object is a link (an edge to that node); a literal is
  // a property of the subject. Predicates are shown with a short name expanded against any @context.
  function ingestRel(sourceUrl, rel) {
    if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return;
    var context = (rel['@context'] && typeof rel['@context'] === 'object') ? rel['@context'] : {};
    Object.keys(rel).forEach(function (subject) {
      if (subject === '@context' || subject.charAt(0) === '@') return;
      var triple = rel[subject]; if (!triple || typeof triple !== 'object' || Array.isArray(triple)) return;
      var subjUri = norm(resolve(subject, sourceUrl)); ensureNode(subjUri);
      Object.keys(triple).forEach(function (pred) {
        var objs = triple[pred]; if (!Array.isArray(objs)) return;
        var label = shortPred(pred, context);
        objs.forEach(function (o) {
          if (!o || typeof o !== 'object') return;
          if (isLink(o)) { var objUri = norm(resolve(String(o.value), sourceUrl)); ensureNode(objUri); addEdge(subjUri, objUri, label, String(o.value)); }
          else if (typeof o.value === 'string') { nodes[subjUri].literals.push({ pred: label, value: o.value, datatype: o.datatype, lang: o.lang }); }
        });
      });
    });
  }
  // A graph object is a link where it is explicitly a uri or bnode, or where its type is unstated but the value carries
  // a URI scheme (a lenient reading; relationships's own links always set type "uri", so its output round-trips exactly).
  function isLink(o) { if (o.type === 'uri' || o.type === 'bnode') return true; if (o.type === undefined && typeof o.value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(o.value)) return true; return false; }
  function shortPred(pred, context) { var c = pred.indexOf(':'); if (c > 0) { var s = pred.slice(0, c); if (context[s]) return pred; } return pred; }

  // ---- fetch / write -----------------------------------------------------------------------------------------------
  async function fetchObject(url) {
    var u = url + (url.indexOf('?') < 0 ? '?' : '&') + 'objectType&objectName&parentURI&rel';
    var res = await fetch(u, { headers: assign({ Accept: 'application/cdmi-object, application/cdmi-container, application/cdmi-queue, application/cdmi-domain' }, HDRS), credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) { var t = await res.text(); var e = new Error('HTTP ' + res.status + (res.status === 401 ? ' (sign in to the desktop)' : res.status === 404 ? ' (no such object)' : '') + (t ? ' — ' + firstLine(t) : '')); e.status = res.status; throw e; }
    return res.json();
  }
  // Write a node's rel field back with a field update (PATCH of the "rel" field only), using the object's own media type.
  async function patchRel(node, rel) {
    var ct = node.objectType && CDMI_TYPES[node.objectType] ? node.objectType : 'application/cdmi-object';
    var res = await fetch(node.uri, { method: 'PATCH', headers: assign({ 'Content-Type': ct, Accept: ct }, HDRS), credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ rel: rel }) });
    if (!res.ok) { var t = await res.text(); throw new Error('PATCH ' + res.status + (t ? ' — ' + firstLine(t) : '')); }
  }
  function assign(a, b) { var o = {}; for (var k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function firstLine(t) { try { var j = JSON.parse(t); return j.detail || j.title || String(t).split('\n')[0]; } catch (e) { return String(t).split('\n')[0].slice(0, 140); } }

  async function loadFocus(url) {
    url = (url || '').trim();
    if (!url) { setStatus('Enter a CDMI object URL, or a /path/ on this server.', 'err'); return; }
    // Resolve a relative reference -- a "/path/" on this server, or a reference relative to the base URI -- to an
    // absolute URL before loading; a full http(s) URL is returned unchanged.
    url = norm(resolve(url, CTX.baseURI || CTX.containerURI || (HOME + '/')));
    if (!/^https?:\/\//i.test(url)) { setStatus('That does not resolve to an http(s) CDMI object URL.', 'err'); return; }
    // reset the graph
    nodes = {}; edges = []; edgeKey = {}; selected = null; editing = null; focusUri = url;
    colRoot = null; colChain = []; colReps = {}; renderCols();
    edgesG.textContent = ''; nodesG.textContent = '';
    setStatus('Loading ' + url + ' …');
    var n = ensureNode(url); n.kind = 'focus'; applyNodeClass(n);
    try {
      var rep = await fetchObject(url);
      n.objectType = rep.objectType || null; n.loaded = true; n.expanded = true; applyNodeClass(n);
      ingestRel(url, rep.rel);
      colReps[url] = rep; colRoot = url; colChain = []; renderCols();     // seed the column browser at the loaded object
      centerView(); render(); kick();
      setStatus('Loaded ' + labelOf(url) + ' — ' + (edges.length) + ' link(s), ' + (Object.keys(nodes).length - 1) + ' other object(s).', 'ok');
      select(n);
    } catch (e) { n.error = e.message; setStatus('' + (e.message || e), 'err'); render(); select(n); }
  }

  async function expand(node) {
    if (node.loading || node.expanded || node.kind === 'external') return;
    node.loading = true; setStatus('Expanding ' + labelOf(node.uri) + ' …'); applyNodeClass(node);
    try {
      var rep = await fetchObject(node.uri);
      node.objectType = rep.objectType || node.objectType; node.expanded = true; node.loaded = true; node.error = null;
      var before = Object.keys(nodes).length;
      ingestRel(node.uri, rep.rel);
      render(); kick();
      setStatus('Expanded ' + labelOf(node.uri) + ' — ' + (Object.keys(nodes).length - before) + ' new object(s).', 'ok');
    } catch (e) { node.error = e.message; setStatus('' + (e.message || e), 'err'); }
    finally { node.loading = false; applyNodeClass(node); if (selected === node) select(node); }
  }

  // ---- selection + detail panel -----------------------------------------------------------------------------------
  function select(node) {
    selected = node;
    if (editing && (!node || editing.subject !== node.uri)) editing = null;   // an edit belongs to the node it began on
    [].forEach.call(nodesG.children, function (g) { g.classList.toggle('sel', g._node === node); });
    side.textContent = '';
    if (!node) { side.appendChild(el('div', { class: 'msg', text: S('clickNode', 'Click a node to see it.') })); return; }
    side.appendChild(el('h3', { text: node.label }));
    side.appendChild(el('div', { class: 'u', text: node.uri }));
    side.appendChild(el('span', { class: 'tag ' + node.kind, text: node.kind === 'external' ? S('otherOrigin', 'other origin') : (node.objectType ? node.objectType.replace('application/cdmi-', 'cdmi ') : S('thisServer', 'this server')) }));
    if (node.error) side.appendChild(el('div', { class: 'err', text: node.error }));

    // expand affordance
    if (node.kind !== 'external') {
      var exp = el('button', { class: 'sec', type: 'button', text: node.expanded ? S('reloadLinks', 'Reload links') : S('expandLinks', 'Expand links') });
      exp.disabled = !!node.loading;
      exp.addEventListener('click', function () { node.expanded = false; expand(node); });
      side.appendChild(exp);
    } else {
      side.appendChild(el('div', { class: 'note', text: S('externalNote', 'This object is at another origin, so its links cannot be read from here.') }));
    }

    var editable = node.kind !== 'external';

    // outgoing links -- each row is navigable, and (for an object this server holds) has edit and remove controls.
    var out = edges.filter(function (e) { return e.from === node.uri; });
    if (out.length) {
      side.appendChild(el('div', { class: 'lbl', text: 'links (' + out.length + ')' }));
      var t1 = el('table');
      out.forEach(function (e) {
        var td2 = el('td', {});
        var a = el('a', { href: '#', text: labelOf(e.to), title: e.to, style: 'color:var(--accent);text-decoration:none' });
        a.addEventListener('click', function (ev) { ev.preventDefault(); var tn = nodes[e.to]; if (tn) { select(tn); if (!tn.expanded && tn.kind !== 'external') expand(tn); } });
        td2.appendChild(a);
        // Where the stored value is a relative reference, show it beneath the resolved label.
        if (e.rawValue != null && e.rawValue !== e.to) td2.appendChild(el('div', { class: 'u', style: 'margin:1px 0 0', text: e.rawValue }));
        var cells = [el('td', { class: 'p', text: e.pred }), td2];
        if (editable) {
          var orig = { subject: node.uri, type: 'uri', pred: e.pred, rawValue: (e.rawValue != null ? e.rawValue : e.to) };
          var edb = el('button', { class: 'rowbtn', type: 'button', text: 'edit' });
          edb.addEventListener('click', (function (o) { return function () { editing = { subject: node.uri, type: 'uri', pred: o.pred, rawValue: o.rawValue }; select(node); }; })(orig));
          var rmb = el('button', { class: 'rowbtn', type: 'button', text: '×', title: 'Remove this link' });
          rmb.addEventListener('click', (function (o, b) { return function () { doRemove(node, o, b); }; })(orig, rmb));
          cells.push(el('td', { class: 'act' }, [edb, rmb]));
        }
        t1.appendChild(el('tr', {}, cells));
      });
      side.appendChild(t1);
    }
    // literal properties -- likewise editable and removable.
    if (node.literals.length) {
      side.appendChild(el('div', { class: 'lbl', text: 'properties' }));
      var t2 = el('table');
      node.literals.forEach(function (p) {
        var suffix = p.lang ? ' @' + p.lang : (p.datatype ? ' ^^' + p.datatype : '');
        var cells = [el('td', { class: 'p', text: p.pred }), el('td', { text: p.value + suffix })];
        if (editable) {
          var orig = { subject: node.uri, type: 'literal', pred: p.pred, rawValue: p.value };
          var edb = el('button', { class: 'rowbtn', type: 'button', text: 'edit' });
          edb.addEventListener('click', (function (pp) { return function () { editing = { subject: node.uri, type: 'literal', pred: pp.pred, rawValue: pp.value, datatype: pp.datatype, lang: pp.lang }; select(node); }; })(p));
          var rmb = el('button', { class: 'rowbtn', type: 'button', text: '×', title: 'Remove this property' });
          rmb.addEventListener('click', (function (o, b) { return function () { doRemove(node, o, b); }; })(orig, rmb));
          cells.push(el('td', { class: 'act' }, [edb, rmb]));
        }
        t2.appendChild(el('tr', {}, cells));
      });
      side.appendChild(t2);
    }

    // add / edit form (only for a writable object of this server)
    if (!editable) { side.appendChild(el('div', { class: 'lbl', text: S('addLinkLabel', 'add a link') })); side.appendChild(el('div', { class: 'note', text: S('addOnlyHere', 'Links can be added only to an object this server holds.') })); return; }
    side.appendChild(el('div', { class: 'lbl', text: editing ? (editing.type === 'literal' ? S('editProperty', 'edit property') : S('editLink', 'edit link')) : S('addLinkOrProp', 'add a link or property') }));
    var dlId = 'rv-targets';
    var dl = el('datalist', { id: dlId }, Object.keys(nodes).filter(function (u) { return u !== node.uri; }).map(function (u) { return el('option', { value: u }); }));
    var typeSel = el('select', {}, [el('option', { value: 'uri', text: S('typeLink', 'Link (to an object)') }), el('option', { value: 'literal', text: S('typeLiteral', 'Literal (property value)') })]);
    typeSel.value = editing ? editing.type : 'uri';
    var predIn = el('input', { type: 'text', spellcheck: 'false', value: editing ? editing.pred : 'references' });
    var valIn = el('input', { type: 'text', spellcheck: 'false', list: dlId, value: editing ? editing.rawValue : '' });
    var dtIn = el('input', { type: 'text', spellcheck: 'false', placeholder: S('datatypePlaceholder', 'datatype, or @lang'), value: (editing && editing.type === 'literal') ? (editing.lang ? '@' + editing.lang : (editing.datatype || '')) : '' });
    var valLabel = el('label', {});
    var valField = el('div', { class: 'field' }, [valLabel, valIn, dl]);
    var dtField = el('div', { class: 'field' }, [el('label', { text: S('datatypeLabel', 'datatype / @lang (optional)') }), dtIn]);
    var errEl = el('div', { class: 'err' });
    var primary = el('button', { type: 'button', text: editing ? S('saveChanges', 'Save changes') : S('add', 'Add') });
    function syncType() {
      var lit = typeSel.value === 'literal';
      valLabel.textContent = lit ? S('fieldValue', 'value') : S('fieldTarget', 'target');
      valIn.placeholder = lit ? S('valuePlaceholderLiteral', 'a text value') : S('valuePlaceholderUri', 'object URL, /path/, or #/value');
      dtField.style.display = lit ? '' : 'none';
    }
    typeSel.addEventListener('change', syncType);
    primary.addEventListener('click', function () { doSave(node, editing, typeSel.value, predIn.value.trim(), valIn.value.trim(), dtIn.value.trim(), errEl, primary); });
    side.appendChild(el('div', { class: 'field' }, [el('label', { text: S('fieldType', 'type') }), typeSel]));
    side.appendChild(el('div', { class: 'field' }, [el('label', { text: S('fieldPredicate', 'predicate') }), predIn]));
    side.appendChild(valField);
    side.appendChild(dtField);
    side.appendChild(primary);
    if (editing) { var cancelBtn = el('button', { class: 'sec', type: 'button', text: S('cancel', 'Cancel') }); cancelBtn.addEventListener('click', function () { editing = null; select(node); }); side.appendChild(cancelBtn); }
    side.appendChild(errEl);
    syncType();
  }

  // ---- rel mutation (add / edit / remove) --------------------------------------------------------------------------
  // The subject key under which a node's own triples are stored: an existing key that resolves to the node's URL
  // (a server may store the object's own URL, absolute or relative), else the node's URL.
  function subjectKeyFor(rel, objUrl) {
    var keys = Object.keys(rel);
    for (var i = 0; i < keys.length; i++) { var k = keys[i]; if (k.charAt(0) === '@') continue; try { if (norm(resolve(k, objUrl)) === objUrl) return k; } catch (e) {} }
    return objUrl;
  }
  function entryType(o) { if (o.type === 'uri' || o.type === 'bnode') return 'uri'; if (o.type === 'literal') return 'literal'; return isLink(o) ? 'uri' : 'literal'; }
  // Remove the first entry under rel[subjKey][orig.pred] that matches orig by type and stored value.
  function removeMatching(rel, subjKey, orig) {
    var arr = rel[subjKey] && rel[subjKey][orig.pred]; if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) { var o = arr[i]; if (!o || typeof o !== 'object') continue; if (entryType(o) === orig.type && String(o.value) === String(orig.rawValue)) { arr.splice(i, 1); break; } }
    if (Array.isArray(rel[subjKey][orig.pred]) && !rel[subjKey][orig.pred].length) delete rel[subjKey][orig.pred];
  }
  // Drop a node's outgoing edges and literals from the graph, then remove any target left with no edges at all.
  function clearNodeOutgoing(node) {
    var kept = [];
    edges.forEach(function (e) { if (e.from === node.uri) { if (e.line) e.line.remove(); if (e.lbl) e.lbl.remove(); delete edgeKey[e.from + '\u0000' + e.pred + '\u0000' + e.to]; } else kept.push(e); });
    edges = kept; node.literals = []; pruneOrphans();
  }
  function pruneOrphans() {
    var used = {}; if (focusUri) used[focusUri] = 1; edges.forEach(function (e) { used[e.from] = 1; used[e.to] = 1; });
    Object.keys(nodes).forEach(function (u) { var n = nodes[u]; if (used[u] || n === selected || n.expanded) return; if (n.el) n.el.remove(); delete nodes[u]; });
  }
  // Rebuild just this node's portion of the graph from the (patched) rel, so an edit shows without a full reload.
  function reingestNode(node, rel) {
    clearNodeOutgoing(node);
    var subjKey = subjectKeyFor(rel, node.uri), one = {};
    if (rel['@context']) one['@context'] = rel['@context']; if (rel[subjKey]) one[subjKey] = rel[subjKey];
    ingestRel(node.uri, one); render(); kick();
  }

  // Add a new entry, or replace the one named by "orig". A uri target is stored exactly as typed (a relative
  // reference is kept and only resolved to validate and to place the node); a literal carries an optional datatype
  // or "@lang".
  async function doSave(node, orig, type, pred, value, dt, errEl, btn) {
    errEl.textContent = '';
    if (!pred) { errEl.textContent = 'Enter a predicate (the kind of link).'; return; }
    if (!value) { errEl.textContent = type === 'literal' ? 'Enter a value.' : 'Enter a target: an object URL, a /path/, or a #fragment.'; return; }
    var addObj, abs = null;
    if (type === 'uri') {
      abs = norm(resolve(value, node.uri));
      if (!/^https?:\/\//i.test(abs)) { errEl.textContent = 'The target does not resolve to an http(s) object URL.'; return; }
      addObj = { value: value, type: 'uri' };
    } else {
      addObj = { value: value, type: 'literal' };
      if (dt) { if (dt.charAt(0) === '@') addObj.lang = dt.slice(1); else addObj.datatype = dt; }
    }
    btn.disabled = true; setStatus(orig ? 'Saving …' : 'Adding …');
    try {
      var rep = await fetchObject(node.uri); node.objectType = rep.objectType || node.objectType;
      var rel = (rep.rel && typeof rep.rel === 'object' && !Array.isArray(rep.rel)) ? rep.rel : {};
      var subjKey = subjectKeyFor(rel, node.uri);
      if (!orig && type === 'uri') {
        var have = (rel[subjKey] && rel[subjKey][pred]) || [];
        if (have.some(function (o) { return o && entryType(o) === 'uri' && norm(resolve(String(o.value), node.uri)) === abs; })) { errEl.textContent = 'That link already exists.'; setStatus('That link already exists.', 'err'); btn.disabled = false; return; }
      }
      if (orig) removeMatching(rel, subjKey, orig);
      if (!rel[subjKey] || typeof rel[subjKey] !== 'object' || Array.isArray(rel[subjKey])) rel[subjKey] = {};
      if (!Array.isArray(rel[subjKey][pred])) rel[subjKey][pred] = [];
      rel[subjKey][pred].push(addObj);
      await patchRel(node, rel);
      editing = null; reingestNode(node, rel);
      colReps[node.uri] = { objectType: node.objectType, rel: rel }; renderCols();
      setStatus((orig ? 'Updated ' : 'Added ') + pred + (type === 'uri' ? ' → ' + labelOf(abs) : ' = ' + value) + '.', 'ok');
      select(node);
    } catch (e) { errEl.textContent = e.message || String(e); setStatus('' + (e.message || e), 'err'); btn.disabled = false; }
  }

  async function doRemove(node, orig, btn) {
    if (btn) btn.disabled = true; setStatus('Removing …');
    try {
      var rep = await fetchObject(node.uri); node.objectType = rep.objectType || node.objectType;
      var rel = (rep.rel && typeof rep.rel === 'object' && !Array.isArray(rep.rel)) ? rep.rel : {};
      var subjKey = subjectKeyFor(rel, node.uri);
      removeMatching(rel, subjKey, orig);
      if (rel[subjKey] && !Object.keys(rel[subjKey]).length) delete rel[subjKey];
      await patchRel(node, rel);
      if (editing && editing.type === orig.type && editing.pred === orig.pred && String(editing.rawValue) === String(orig.rawValue)) editing = null;
      reingestNode(node, rel);
      colReps[node.uri] = { objectType: node.objectType, rel: rel }; renderCols();
      setStatus('Removed ' + orig.pred + (orig.type === 'uri' ? ' → ' + labelOf(norm(resolve(orig.rawValue, node.uri))) : '') + '.', 'ok');
      select(node);
    } catch (e) { setStatus('' + (e.message || e), 'err'); if (btn) btn.disabled = false; }
  }

  // ---- column browser (Miller columns above the graph) -------------------------------------------------------------
  // A read-only breadcrumb of columns: the root object, its relation types, the destinations of a chosen relation,
  // then that destination object's relation types, and so on. Only objects expand; references, literals and external
  // links are leaves. Picking a destination object also selects and expands it in the graph below. Editing stays in
  // the side panel; when it changes a node's rel, the cache for that node is refreshed and the columns re-render.
  function colFetch(url) {
    if (url in colReps) return Promise.resolve(colReps[url]);
    return fetchObject(url).then(function (rep) { colReps[url] = rep; return rep; }, function (e) { colReps[url] = { error: e.message || String(e) }; return colReps[url]; });
  }
  function colPreds(url) {                            // undefined = not fetched yet; null = error; else [{pred,entries}]
    var rep = colReps[url]; if (!rep) return undefined; if (rep.error) return null;
    var rel = (rep.rel && typeof rep.rel === 'object' && !Array.isArray(rep.rel)) ? rep.rel : {};
    var sk = subjectKeyFor(rel, url), t = (rel[sk] && typeof rel[sk] === 'object' && !Array.isArray(rel[sk])) ? rel[sk] : {};
    return Object.keys(t).map(function (p) { return { pred: p, entries: Array.isArray(t[p]) ? t[p] : [] }; });
  }
  function classifyDest(o, baseUrl) {
    if (!isLink(o)) return { type: 'literal', value: String(o.value), datatype: o.datatype, lang: o.lang, raw: String(o.value), label: String(o.value) };
    var raw = String(o.value), abs = norm(resolve(raw, baseUrl));
    var kind = raw.charAt(0) === '#' ? 'reference' : (isCdmiHere(abs) ? 'object' : 'external');
    return { type: kind, value: abs, target: abs, raw: raw, label: labelOf(abs) };
  }
  function crow(o) {
    var b = el('button', { class: 'crow' + (o.sel ? ' sel' : ''), type: 'button' });
    if (o.dot) b.appendChild(el('i', { class: 'cdot ' + o.dot }));
    b.appendChild(el('span', { class: 'cnm', text: o.name, title: o.title || o.name }));
    if (o.sub) b.appendChild(el('span', { class: 'csub', text: o.sub, title: o.sub }));
    if (o.tag) b.appendChild(el('span', { class: 'ctag', text: o.tag }));
    if (o.cnt != null) b.appendChild(el('span', { class: 'ccnt', text: String(o.cnt) }));
    if (o.chev) b.appendChild(el('span', { class: 'cchev', text: '›' }));
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  }
  function ccol(title, body) { return el('div', { class: 'col' }, [el('div', { class: 'col-h', text: title, title: title }), body]); }
  function cbody(msg) { var b = el('div', { class: 'col-b' }); if (msg) b.appendChild(el('div', { class: 'cempty', text: msg })); return b; }
  function pickGraph(target) { var n = ensureNode(target); select(n); if (!n.expanded && n.kind !== 'external') expand(n); }

  function renderCols() {
    if (!colsEl) return;
    colsEl.textContent = '';
    if (!colRoot) { colsEl.appendChild(ccol('columns', cbody(S('colsEmpty', 'Load an object to browse its relations.')))); return; }
    // column 1: the root object
    var rootBody = cbody();
    rootBody.appendChild(crow({ name: labelOf(colRoot), dot: 'object', tag: 'root', sel: true, chev: true, title: colRoot, onClick: function () { pickGraph(colRoot); } }));
    rootBody.appendChild(el('div', { class: 'cdetail' }, [el('div', { class: 'u', text: colRoot })]));
    colsEl.appendChild(ccol('object', rootBody));

    var obj = colRoot, i = 0;
    while (true) {
      var preds = colPreds(obj);
      if (preds === undefined) { colsEl.appendChild(ccol('relations · ' + labelOf(obj), cbody(S('colsReading', 'Reading …')))); colFetch(obj).then(renderCols); break; }
      if (preds === null) { colsEl.appendChild(ccol('relations · ' + labelOf(obj), cbody((colReps[obj] && colReps[obj].error) || 'Could not read.'))); break; }
      var selPred = colChain[i];
      (function (idx, object, plist) {
        var body = cbody(plist.length ? null : S('colsNoRelations', 'No relations.'));
        plist.forEach(function (p) { body.appendChild(crow({ name: p.pred, cnt: p.entries.length, chev: true, sel: p.pred === colChain[idx], onClick: function () { colChain = colChain.slice(0, idx); colChain[idx] = p.pred; renderCols(); } })); });
        colsEl.appendChild(ccol('relations · ' + labelOf(object), body));
      })(i, obj, preds);
      if (selPred === undefined) break;
      var entries = (preds.filter(function (p) { return p.pred === selPred; })[0] || { entries: [] }).entries;
      var selRaw = colChain[i + 1];
      (function (idx, object, pred, ents) {
        var body = cbody(ents.length ? null : S('colsNoDestinations', 'No destinations.'));
        ents.forEach(function (entry) {
          var d = classifyDest(entry, object);
          var sub = (d.type !== 'literal' && d.raw !== d.value) ? d.raw : '';     // show a stored relative reference
          body.appendChild(crow({ name: d.type === 'literal' ? d.value : d.label, dot: d.type, tag: d.type === 'object' ? null : d.type, sub: sub, chev: d.type === 'object', sel: d.raw === colChain[idx + 1], title: d.value,
            onClick: function () { colChain = colChain.slice(0, idx + 1); colChain[idx + 1] = d.raw; renderCols(); if (d.type === 'object') pickGraph(d.target); } }));
        });
        colsEl.appendChild(ccol('links · ' + pred, body));
      })(i, obj, selPred, entries);
      if (selRaw === undefined) break;
      var chosen = null; for (var k = 0; k < entries.length; k++) { var dd = classifyDest(entries[k], obj); if (dd.raw === selRaw) { chosen = dd; break; } }
      if (!chosen) break;
      if (chosen.type === 'object') {
        if (!(chosen.target in colReps)) { colsEl.appendChild(ccol('relations · ' + labelOf(chosen.target), cbody(S('colsReading', 'Reading …')))); colFetch(chosen.target).then(renderCols); break; }
        obj = chosen.target; i += 2; continue;
      }
      // literal / reference / external: a leaf detail column
      var box = el('div', { class: 'cdetail' });
      if (chosen.type === 'literal') { box.appendChild(el('div', { class: 'k', text: 'literal value' })); box.appendChild(el('div', { class: 'v', text: chosen.value })); if (chosen.lang) box.appendChild(el('div', { class: 'u', text: '@' + chosen.lang })); else if (chosen.datatype) box.appendChild(el('div', { class: 'u', text: 'datatype ' + chosen.datatype })); }
      else if (chosen.type === 'reference') { box.appendChild(el('div', { class: 'k', text: 'internal reference' })); box.appendChild(el('div', { class: 'v', text: chosen.label })); box.appendChild(el('div', { class: 'u', text: 'stored as ' + chosen.raw })); box.appendChild(el('div', { class: 'u', text: 'not followed here' })); }
      else { box.appendChild(el('div', { class: 'k', text: 'external' })); box.appendChild(el('div', { class: 'v', text: chosen.label })); box.appendChild(el('div', { class: 'u', text: chosen.value })); }
      colsEl.appendChild(ccol(chosen.type, el('div', { class: 'col-b' }, [box]))); break;
    }
    colsEl.scrollLeft = colsEl.scrollWidth;    // reveal the newest column
  }

  // Resizable columns band (default height 140).
  (function () {
    var dragging = false, startY = 0, startH = 140;
    resizer.addEventListener('pointerdown', function (ev) { dragging = true; startY = ev.clientY; startH = colsEl.getBoundingClientRect().height; try { resizer.setPointerCapture(ev.pointerId); } catch (e) {} ev.preventDefault(); });
    resizer.addEventListener('pointermove', function (ev) { if (!dragging) return; var hgt = Math.max(60, Math.min(window.innerHeight - 160, startH + (ev.clientY - startY))); colsEl.style.height = hgt + 'px'; });
    function end() { dragging = false; }
    resizer.addEventListener('pointerup', end); resizer.addEventListener('pointercancel', end);
  })();

  // ---- rendering ---------------------------------------------------------------------------------------------------
  function buildEdgeEl(e) {
    e.line = sv('line', { class: 'edge' });
    e.lbl = sv('text', { class: 'edge-lbl', text: e.pred });
    edgesG.appendChild(e.line); edgesG.appendChild(e.lbl);
  }
  function buildNodeEl(n) {
    var g = sv('g', { class: 'node' }); g._node = n;
    var r = n.kind === 'focus' ? 11 : 8;
    g.appendChild(sv('circle', { r: r }));
    g.appendChild(sv('text', { y: (r + 12), text: n.label }));
    g.appendChild(sv('text', { class: 'plus', y: 3.5, text: '' }));
    g.addEventListener('pointerdown', function (ev) { startNodeDrag(ev, n); });
    n.el = g; nodesG.appendChild(g); applyNodeClass(n);
  }
  function applyNodeClass(n) {
    if (!n.el) return;
    n.el.setAttribute('class', 'node ' + n.kind + (selected === n ? ' sel' : ''));
    var plus = n.el.querySelector('.plus');
    if (plus) plus.textContent = (n.kind !== 'external' && !n.expanded && !n.loading) ? '+' : (n.loading ? '…' : '');
  }
  function render() {
    edges.forEach(function (e) {
      var a = nodes[e.from], b = nodes[e.to]; if (!a || !b) return;
      e.line.setAttribute('x1', a.x); e.line.setAttribute('y1', a.y); e.line.setAttribute('x2', b.x); e.line.setAttribute('y2', b.y);
      e.lbl.setAttribute('x', (a.x + b.x) / 2); e.lbl.setAttribute('y', (a.y + b.y) / 2 - 2);
    });
    for (var u in nodes) { var n = nodes[u]; if (n.el) n.el.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')'); }
    viewG.setAttribute('transform', 'translate(' + view.x * view.s + ',' + view.y * view.s + ') scale(' + view.s + ')');
  }

  // ---- force simulation --------------------------------------------------------------------------------------------
  var running = false, raf = 0;
  function kick() { if (!running) { running = true; raf = requestAnimationFrame(step); } }
  function step() {
    var list = []; for (var u in nodes) list.push(nodes[u]);
    var n = list.length, maxV = 0, i, j;
    var cx = 0, cy = 0; for (i = 0; i < n; i++) { cx += list[i].x; cy += list[i].y; } cx /= n || 1; cy /= n || 1;
    for (i = 0; i < n; i++) {
      var a = list[i]; if (a.pinned) { a.vx = a.vy = 0; continue; }
      var fx = 0, fy = 0;
      for (j = 0; j < n; j++) { if (i === j) continue; var b = list[j]; var dx = a.x - b.x, dy = a.y - b.y; var d2 = dx * dx + dy * dy + 0.01; var d = Math.sqrt(d2); var rep = 5200 / d2; fx += (dx / d) * rep; fy += (dy / d) * rep; }
      fx += (cx - a.x) * 0.015; fy += (cy - a.y) * 0.015;               // gentle centering
      a.fx = fx; a.fy = fy;
    }
    edges.forEach(function (e) {
      var a = nodes[e.from], b = nodes[e.to]; if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y; var d = Math.sqrt(dx * dx + dy * dy) + 0.01; var f = (d - 96) * 0.02;
      var ux = dx / d, uy = dy / d;
      if (!a.pinned) { a.fx += ux * f; a.fy += uy * f; }
      if (!b.pinned) { b.fx -= ux * f; b.fy -= uy * f; }
    });
    for (i = 0; i < n; i++) {
      var p = list[i]; if (p.pinned) continue;
      p.vx = (p.vx + p.fx) * 0.82; p.vy = (p.vy + p.fy) * 0.82;
      var v = Math.abs(p.vx) + Math.abs(p.vy); if (v > maxV) maxV = v;
      p.x += p.vx; p.y += p.vy;
    }
    render();
    if (maxV > 0.4 && n > 1) raf = requestAnimationFrame(step); else running = false;
  }

  // ---- pan / zoom / drag -------------------------------------------------------------------------------------------
  var dragNode = null, panning = false, last = null;
  function toWorld(clientX, clientY) { var r = svg.getBoundingClientRect(); return { x: (clientX - r.left) / view.s - view.x, y: (clientY - r.top) / view.s - view.y }; }
  function startNodeDrag(ev, n) {
    ev.stopPropagation(); ev.preventDefault(); dragNode = n; n.pinned = true; select(n);
    if (n.kind !== 'external' && !n.expanded && !n.loading) expand(n);           // clicking an unexpanded object expands it
    svg.setPointerCapture(ev.pointerId); svg.classList.add('grabbing');
  }
  svg.addEventListener('pointerdown', function (ev) { if (dragNode) return; panning = true; last = { x: ev.clientX, y: ev.clientY }; svg.setPointerCapture(ev.pointerId); svg.classList.add('grabbing'); });
  svg.addEventListener('pointermove', function (ev) {
    if (dragNode) { var w = toWorld(ev.clientX, ev.clientY); dragNode.x = w.x; dragNode.y = w.y; render(); }
    else if (panning && last) { view.x += (ev.clientX - last.x) / view.s; view.y += (ev.clientY - last.y) / view.s; last = { x: ev.clientX, y: ev.clientY }; render(); }
  });
  function endPointer(ev) { if (dragNode) { dragNode.pinned = false; dragNode = null; kick(); } panning = false; last = null; svg.classList.remove('grabbing'); }
  svg.addEventListener('pointerup', endPointer); svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('wheel', function (ev) { ev.preventDefault(); var r = svg.getBoundingClientRect(); var mx = ev.clientX - r.left, my = ev.clientY - r.top; var ns = Math.min(3, Math.max(0.2, view.s * (ev.deltaY < 0 ? 1.1 : 0.9))); view.x += mx / ns - mx / view.s; view.y += my / ns - my / view.s; view.s = ns; render(); }, { passive: false });

  function centerView() { view = { x: 0, y: 0, s: 1 }; }
  function fit() {
    var list = []; for (var u in nodes) list.push(nodes[u]); if (!list.length) return;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    list.forEach(function (n) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
    var w = canvas.clientWidth || 600, h = canvas.clientHeight || 400, pad = 60;
    var gw = Math.max(1, maxX - minX), gh = Math.max(1, maxY - minY);
    var s = Math.min(3, Math.max(0.2, Math.min((w - pad) / gw, (h - pad) / gh)));
    view.s = s; view.x = (w / 2) / s - (minX + maxX) / 2; view.y = (h / 2) / s - (minY + maxY) / 2; render();
  }

  loadBtn.addEventListener('click', function () { loadFocus(urlIn.value); });
  fitBtn.addEventListener('click', fit);
  urlIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadFocus(urlIn.value); });

  // Load the starting object if one was handed in; otherwise show the empty columns and wait for the user.
  renderCols();
  if (CTX.startURI || CTX.containerURI) loadFocus(urlIn.value);
})();
