/*!
 * Textile - a small text editor for cvwm, after Sublime Text in looks and in very little else.
 * Store this file as "index.js" in a container (for example /textile/), with index.png beside it. Where it
 * is installed the desktop opens .txt, .md, .json, .log and other text objects with it.
 *
 * One file to a window: a File/Edit/View menu bar, line numbers, a status bar carrying the file name (with a dot
 * while there are unsaved changes), Find, Go to line, Tab and Shift+Tab to indent, and the indentation carried to
 * a new line. JSON and JavaScript are coloured; JSON is also checked as you type, and the status bar says where it
 * stops being JSON. Long lines run off to the right, or wrap (View > Wrap lines, Alt+Z); line numbers follow either
 * way. It follows the desktop's light/dark setting (the shared cvwm.dark signal; View > Dark mode toggles it).
 *
 * The colouring is a <pre> drawn underneath a <textarea> whose own text is transparent, the two set in the
 * same type and scrolled together, so that the caret, selection, undo and the clipboard are the browser's.
 *
 * Reading selects the value (?value), because a CDMI read returns a value only where it is selected.
 * Saving an existing object replaces the value alone (PUT ...?value), so that its metadata and media type
 * stay as they were; a new object is created with If-None-Match: *, so a name in use is not overwritten.
 */
(function () {
  'use strict';

  var CTX = window.CDMI_CONTEXT || {};
  var HEADERS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string with optional {token} substitution; the stylesheet is pulled where present.
  var R = CTX.rsrc || null;
  function S(id, fb, vars) {
    var v = R && R.text('strings', id); if (v == null) v = fb;
    if (vars) for (var k in vars) v = v.split('{' + k + '}').join(vars[k]);
    return v;
  }
  var NS = (CTX.namespaces || []).map(function (n) { return { name: n.name, base: n.baseURI }; });
  var T_OBJECT = 'application/cdmi-object', T_CONTAINER = 'application/cdmi-container';
  var LIMIT = 1024 * 1024;                          // no colouring past this many characters

  var file = { url: null, name: S('untitled', 'untitled'), dir: null, encoding: 'utf-8', mime: 'text/plain' };
  var saved = '', syntax = 'Plain Text', checkTimer = 0;
  var NAME = S('title', 'Textile');

  /* ---------------------------------------------------------------- interface */

  var FONT = '13px/19px "DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace';
  var style = document.createElement('style');
  var DEFAULT_CSS =
    /* HIG tokens: light (platinum) by default, dark under body.dark; the shared cvwm.dark signal drives both. */
    ':root{--std:#60a0c0;--hi:#c06077;--grey:#bfbfbf;--lt:rgba(255,255,255,.6);--dk:rgba(0,0,0,.55);' +
      '--sans:Helvetica,"Nimbus Sans","Liberation Sans",Arial,sans-serif;--mono:"DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;' +
      '--fg:#000;--fg2:#333;--dim:#555;--field:#fff;--on:#e8e8e8;--band:#eef3f7;--selband:rgba(96,160,192,.38);--sb-face:#bfbfbf;--sb-trough:#9a9a9a;' +
      '--syn-key:#0a3069;--syn-str:#0a7d33;--syn-num:#8250df;--syn-const:#8250df;--syn-kw:#cf222e;--syn-storage:#0550ae;--syn-comment:#6e7781;--syn-fn:#116329;--syn-call:#0550ae;--syn-op:#cf222e;--syn-re:#0a7d33;--syn-bad:#cf222e}' +
    'body.dark{--std:#2c3d47;--hi:#3a4e59;--grey:#333b41;--lt:rgba(255,255,255,.16);--dk:rgba(0,0,0,.6);' +
      '--fg:#e8edf1;--fg2:#c9d1d8;--dim:#8a929a;--field:#15191c;--on:#1f262b;--band:#222c35;--selband:rgba(120,118,100,.5);--sb-face:#333b41;--sb-trough:#23292e;' +
      '--syn-key:#66d9ef;--syn-str:#e6db74;--syn-num:#ae81ff;--syn-const:#ae81ff;--syn-kw:#f92672;--syn-storage:#66d9ef;--syn-comment:#75715e;--syn-fn:#a6e22e;--syn-call:#66d9ef;--syn-op:#f92672;--syn-re:#e6db74;--syn-bad:#f92672;color-scheme:dark}' +
    'html,body{margin:0;height:100%}' +
    'body{display:flex;flex-direction:column;background:var(--grey);color:var(--fg);font:13px var(--sans);overflow:hidden;cursor:default}' +
    /* menu bar */
    '#menubar{display:flex;align-items:center;height:26px;flex:none;padding:0 2px;background:var(--grey);border-bottom:1px solid var(--dk);position:relative;z-index:10;user-select:none;-webkit-user-select:none}' +
    '#menubar>span{height:22px;line-height:20px;padding:0 10px;border:1px solid transparent;font:13px var(--sans);color:var(--fg);white-space:nowrap}' +
    '#menubar>span.open{background:var(--hi);border-color:var(--lt) var(--dk) var(--dk) var(--lt)}' +
    '.menu{position:fixed;z-index:30;min-width:200px;padding:2px;background:var(--grey);border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt);display:flex;flex-direction:column;font:13px var(--sans);color:var(--fg);user-select:none;-webkit-user-select:none}' +
    '.menu div{position:relative;display:flex;justify-content:space-between;align-items:center;gap:20px;height:24px;padding:0 10px 0 24px;border:1px solid transparent;white-space:nowrap}' +
    '.menu div:hover{background:var(--hi);border-color:var(--lt) var(--dk) var(--dk) var(--lt)}' +
    '.menu div.off{color:var(--dim)}.menu div.off:hover{background:none;border-color:transparent}' +
    '.menu div .ck{position:absolute;left:8px;top:0;line-height:22px}.menu div .key{color:var(--fg2);font-size:12px}.menu div.off .key{color:var(--dim)}' +
    '.menu hr{border:0;border-top:1px solid var(--dk);border-bottom:1px solid var(--lt);margin:3px 2px}' +
    /* editor */
    '#ed{position:relative;flex:1;min-height:0;display:flex;background:var(--field)}' +
    '#gutter{flex:none;min-width:40px;padding:4px 10px 60px 12px;box-sizing:border-box;text-align:right;color:var(--dim);font:' + FONT + ';white-space:pre;overflow:hidden;user-select:none;-webkit-user-select:none;background:var(--grey);border-right:1px solid var(--dk)}' +
    '#area{position:relative;flex:1;min-width:0;overflow:hidden}' +
    '#line{position:absolute;left:0;right:0;height:19px;background:var(--band);pointer-events:none}' +
    '#paint,#text{position:absolute;inset:0;margin:0;border:0;padding:4px 8px;box-sizing:border-box;font:' + FONT + ';tab-size:4;-moz-tab-size:4;white-space:pre;letter-spacing:0}' +
    '#paint{color:var(--fg);pointer-events:none;right:auto;bottom:auto;min-width:100%;overflow:visible;will-change:transform}' +
    '#measure{position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;margin:0;padding:4px 8px;box-sizing:border-box;font:' + FONT + ';tab-size:4;-moz-tab-size:4;white-space:pre-wrap;overflow-wrap:break-word}' +
    'body.wrap #paint,body.wrap #text{white-space:pre-wrap;overflow-wrap:break-word;word-break:normal}body.wrap #paint{min-width:0}body.wrap #text{overflow-x:hidden}' +
    '#gutter div{height:19px}' +
    '#text{width:100%;height:100%;resize:none;outline:none;background:transparent;color:var(--fg);caret-color:var(--fg);overflow:auto}' +
    '#text.painted{color:transparent}#text::selection{background:var(--selband)}#text.painted::selection{color:transparent;background:var(--selband)}' +
    '#paint .k{color:var(--syn-key)}#paint .s{color:var(--syn-str)}#paint .n{color:var(--syn-num)}#paint .c{color:var(--syn-const)}#paint .p{color:var(--fg)}#paint .x{color:var(--syn-bad);text-decoration:underline wavy}' +
    '#paint .kw{color:var(--syn-kw)}#paint .st{color:var(--syn-storage);font-style:italic}#paint .cm{color:var(--syn-comment)}#paint .fn{color:var(--syn-fn)}#paint .cl{color:var(--syn-call)}#paint .op{color:var(--syn-op)}#paint .re{color:var(--syn-re)}' +
    /* find */
    '#find{display:none;align-items:center;gap:6px;flex:none;background:var(--grey);padding:5px 8px;border-top:1px solid var(--dk)}#find.on{display:flex}' +
    '#find input{flex:1;min-width:0;height:24px;padding:0 6px;background:var(--field);color:var(--fg);font:' + FONT + ';border:2px solid;border-color:var(--dk) var(--lt) var(--lt) var(--dk)}#find input:focus{outline:1px solid var(--fg)}' +
    '#find .m{color:var(--dim);min-width:80px;text-align:right;font:12px var(--sans)}' +
    '#find button{min-width:0;height:24px;padding:0 10px;background:var(--grey);font:700 12px var(--sans);color:var(--fg);border:2px solid;border-color:var(--lt) var(--dk) var(--dk) var(--lt)}#find button:active{border-color:var(--dk) var(--lt) var(--lt) var(--dk)}' +
    /* status bar */
    '#status{height:24px;flex:none;display:flex;align-items:center;gap:16px;padding:0 10px;background:var(--grey);color:var(--fg);font:11px var(--mono);white-space:nowrap;overflow:hidden;border-top:1px solid var(--lt)}' +
    '#status .nm{font-weight:700}#status .msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}#status .bad{color:#c0202c}#status .good{color:#1a7f37}body.dark #status .bad{color:#ff8a8a}body.dark #status .good{color:#7ec98f}';
  style.textContent = (R && R.text('styles', 'textile')) || DEFAULT_CSS;
  document.head.appendChild(style);

  function el(tag, props, text) { var e = document.createElement(tag); for (var k in (props || {})) e.setAttribute(k, props[k]); if (text !== undefined) e.textContent = text; return e; }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function btn(label, title) { return el('button', { type: 'button', title: title || label }, label); }

  var menubar = el('div', { id: 'menubar' });
  var tabName = el('span', { class: 'nm' }, file.name);            // the file name, shown at the left of the status bar
  var gutter = el('div', { id: 'gutter', 'aria-hidden': 'true' }), area = el('div', { id: 'area' }), band = el('div', { id: 'line' }), paint = el('pre', { id: 'paint', 'aria-hidden': 'true' });
  var text = el('textarea', { id: 'text', wrap: 'off', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': S('text', 'Text') });
  var find = el('div', { id: 'find' }), fIn = el('input', { type: 'text', 'aria-label': S('findLabel', 'Find'), placeholder: S('findLabel', 'Find'), spellcheck: 'false' }), fCount = el('span', { class: 'm' }), fPrev = btn(S('prev', 'Prev')), fNext = btn(S('next', 'Next')), fClose = btn('\u00D7', S('close', 'Close (Esc)'));
  var sPos = el('span', {}, S('lineCol', 'Line 1, Column 1', { ln: '1', col: '1' })), sMsg = el('span', { class: 'msg', role: 'status' }), sWrap = el('span', {}, S('wrapOff', 'Wrap: Off')), sTab = el('span', {}, S('tabSize', 'Tab Size: 4')), sEnc = el('span', {}, S('enc', 'UTF-8')), sSyn = el('span', {}, S('synPlain', 'Plain Text'));
  add(find, fIn, fCount, fPrev, fNext, fClose);
  var measure = el('div', { id: 'measure', 'aria-hidden': 'true' });
  add(area, band, paint, measure, text);
  add(document.body, menubar,
    add(el('div', { id: 'ed' }), gutter, area), find,
    add(el('div', { id: 'status' }), tabName, sPos, sMsg, sWrap, sTab, sEnc, sSyn));

  /* ---------------------------------------------------------------- menu bar and theme

     One light/dark setting serves the whole desktop: the shared cvwm.dark key in localStorage, which the desktop
     menu and the other apps also set. A change here is written to it; a change made elsewhere arrives as a storage
     event (which does not fire in the window that made it, so the desktop and each app apply their own directly). */
  function isDark() { return document.body.classList.contains('dark'); }
  function setDark(on, keep) {
    document.body.classList.toggle('dark', !!on);
    if (!keep) { try { localStorage.setItem('cvwm.dark', on ? 'on' : 'off'); } catch (e) { /* no storage */ } }
  }
  try { setDark(localStorage.getItem('cvwm.dark') === 'on', true); } catch (e) { /* no storage */ }
  window.addEventListener('storage', function (ev) { if (ev.key === 'cvwm.dark') setDark(ev.newValue === 'on', true); });

  var openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.el.remove(); if (openMenu.head) openMenu.head.classList.remove('open'); openMenu = null; } }
  function showMenu(head, items, x, y) {
    closeMenu();
    var m = el('div', { class: 'menu' });
    items.forEach(function (it) {
      if (it === '-') { m.appendChild(el('hr')); return; }
      var off = it.enabled && !it.enabled(), row = el('div', off ? { class: 'off' } : {});
      add(row, el('span', {}, typeof it.label === 'function' ? it.label() : it.label), el('span', { class: 'key' }, it.key || ''));
      if (it.checked && it.checked()) row.appendChild(el('span', { class: 'ck' }, '\u2713'));
      if (!off) row.addEventListener('click', function () { closeMenu(); it.action(); });
      m.appendChild(row);
    });
    document.body.appendChild(m);
    m.style.left = Math.min(x, innerWidth - m.offsetWidth - 2) + 'px';
    m.style.top = Math.min(y, innerHeight - m.offsetHeight - 2) + 'px';
    if (head) head.classList.add('open');
    openMenu = { el: m, head: head || null };
  }
  document.addEventListener('mousedown', function (ev) { if (openMenu && !openMenu.el.contains(ev.target) && ev.target !== openMenu.head) closeMenu(); }, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && openMenu) { ev.stopPropagation(); closeMenu(); } }, true);

  function menuDef() {
    return [
      [S('mFile', 'File'), [
        { label: S('mNew', 'New'), key: 'Ctrl+N', action: function () { careful('new', function () { fresh(); }); } },
        { label: S('mOpen', 'Open\u2026'), key: 'Ctrl+O', action: openViaPicker }, '-',
        { label: S('mSave', 'Save'), key: 'Ctrl+S', action: function () { save(); } },
        { label: S('mSaveAs', 'Save As\u2026'), key: 'Ctrl+Shift+S', action: saveAs }]],
      [S('mEdit', 'Edit'), [
        { label: S('mUndo', 'Undo'), key: 'Ctrl+Z', action: function () { text.focus(); try { document.execCommand('undo'); } catch (e) { /* no undo */ } repaint(); } },
        { label: S('mRedo', 'Redo'), key: 'Ctrl+Y', action: function () { text.focus(); try { document.execCommand('redo'); } catch (e) { /* no redo */ } repaint(); } }, '-',
        { label: S('mFind', 'Find\u2026'), key: 'Ctrl+F', action: function () { showFind('find'); } },
        { label: S('mGoto', 'Go to Line\u2026'), key: 'Ctrl+G', action: function () { showFind('goto'); } }]],
      [S('mView', 'View'), [
        { label: S('mWrap', 'Wrap lines'), key: 'Alt+Z', checked: function () { return wrapped; }, action: function () { setWrap(!wrapped); text.focus(); } }, '-',
        { label: S('mDark', 'Dark mode'), key: 'Ctrl+Shift+D', checked: isDark, action: function () { setDark(!isDark()); } }]]];
  }
  menuDef().forEach(function (m, i) {
    var head = el('span', {}, m[0]);
    head.addEventListener('mousedown', function (ev) { ev.preventDefault(); if (openMenu && openMenu.head === head) { closeMenu(); return; } var r = head.getBoundingClientRect(); showMenu(head, menuDef()[i][1], r.left, r.bottom); });
    head.addEventListener('mouseenter', function () { if (openMenu && openMenu.head !== head) { var r = head.getBoundingClientRect(); showMenu(head, menuDef()[i][1], r.left, r.bottom); } });
    menubar.appendChild(head);
  });

  /* ---------------------------------------------------------------- colouring */

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  var JSON_TOKEN = /("(?:\\.|[^"\\\n])*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],:])|(\S+?)/g;
  function paintJSON(src) {
    return src.replace(JSON_TOKEN, function (m, str, colon, num, word, punct, other) {
      if (str !== undefined) return '<span class="' + (colon ? 'k' : /"$/.test(str) && str.length > 1 ? 's' : 'x') + '">' + esc(str) + '</span>' + (colon ? '<span class="p">' + colon + '</span>' : '');
      if (num !== undefined) return '<span class="n">' + num + '</span>';
      if (word !== undefined) return '<span class="c">' + word + '</span>';
      if (punct !== undefined) return '<span class="p">' + punct + '</span>';
      return '<span class="x">' + esc(other) + '</span>';
    });
  }

  /* JavaScript, by a small scanner rather than one expression, because whether "/" starts a regular expression
     depends on what came before it. Template literals are strings, with the code inside ${ } coloured as code. */
  var JS_KEYWORDS = /^(?:break|case|catch|continue|debugger|default|delete|do|else|export|extends|finally|for|from|if|import|in|instanceof|new|of|return|switch|throw|try|typeof|void|while|with|yield|await|async|static|get|set)$/;
  var JS_STORAGE = /^(?:var|let|const|function|class)$/, JS_CONST = /^(?:true|false|null|undefined|NaN|Infinity|this|super|arguments)$/;
  var JS_BEFORE_REGEX = /^(?:return|typeof|case|in|of|delete|void|throw|new|else|do|instanceof|yield|await)$/;
  function paintJS(src) {
    var out = '', i = 0, n = src.length, prev = '', prevKind = '';            // the last token that was not space or a comment
    function put(cls, str) { out += cls ? '<span class="' + cls + '">' + esc(str) + '</span>' : esc(str); }
    while (i < n) {
      var ch = src[i], rest, m, j;
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { j = i + 1; while (j < n && /\s/.test(src[j])) j++; out += src.slice(i, j); i = j; continue; }
      if (ch === '/' && src[i + 1] === '/') { j = src.indexOf('\n', i); if (j < 0) j = n; put('cm', src.slice(i, j)); i = j; continue; }
      if (ch === '/' && src[i + 1] === '*') { j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; put('cm', src.slice(i, j)); i = j; continue; }
      if (ch === '"' || ch === "'") {
        j = i + 1; while (j < n && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        j = Math.min(n, j + (src[j] === ch ? 1 : 0)); put('s', src.slice(i, j)); i = j; prev = 'str'; prevKind = 'value'; continue;
      }
      if (ch === '`') {
        j = i + 1; var from = i;
        while (j < n && src[j] !== '`') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '$' && src[j + 1] === '{') {
            var depth = 1, k = j + 2; while (k < n && depth) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; if (depth) k++; }
            put('s', src.slice(from, j)); put('op', '${'); out += paintJS(src.slice(j + 2, k)); if (k < n) put('op', '}');
            j = from = Math.min(n, k + 1); continue;
          }
          j++;
        }
        j = Math.min(n, j + 1); put('s', src.slice(from, j)); i = j; prev = 'str'; prevKind = 'value'; continue;
      }
      rest = src.slice(i, i + 80);
      if ((m = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/.exec(rest)) && m[0] && /[\d.]/.test(ch) && (ch !== '.' || /\d/.test(src[i + 1] || ''))) { put('n', m[0]); i += m[0].length; prev = 'num'; prevKind = 'value'; continue; }
      if (/[A-Za-z_$]/.test(ch)) {
        j = i + 1; while (j < n && /[\w$]/.test(src[j])) j++;
        var word = src.slice(i, j), after = /^\s*(.)/.exec(src.slice(j, j + 20)), isProp = prev === '.';
        if (!isProp && JS_STORAGE.test(word)) put('st', word);
        else if (!isProp && JS_KEYWORDS.test(word)) put('kw', word);
        else if (!isProp && JS_CONST.test(word)) put('c', word);
        else if (prev === 'function' || prev === 'class') put('fn', word);
        else if (after && after[1] === '(') put('cl', word);
        else put('', word);
        i = j; prev = word; prevKind = !isProp && (JS_KEYWORDS.test(word) || JS_STORAGE.test(word)) ? 'keyword' : 'value'; continue;
      }
      if (ch === '/' && (prevKind === '' || prevKind === 'op' || (prevKind === 'keyword' && JS_BEFORE_REGEX.test(prev)))) {       // a regular expression?
        j = i + 1; var cls = false, ok = false;
        while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) { ok = true; break; } j++; }
        if (ok) { j++; while (j < n && /[a-z]/.test(src[j])) j++; put('re', src.slice(i, j)); i = j; prev = 'regex'; prevKind = 'value'; continue; }
      }
      if ((m = /^(?:=>|\.\.\.|[+\-*%=!<>&|^~?:\/]+)/.exec(rest))) { put('op', m[0]); i += m[0].length; prev = m[0]; prevKind = 'op'; continue; }
      put('', ch); i++; prev = ch; prevKind = ch === ')' || ch === ']' || ch === '}' ? 'value' : 'op';
    }
    return out;
  }
  var PAINTERS = { JSON: paintJSON, JavaScript: paintJS };

  /* ---------------------------------------------------------------- lines, wrapped or not

     Unwrapped, every line is 19 pixels and the arithmetic is trivial. Wrapped, a line is as tall as it turns out
     to be, so each is laid out once more in a hidden block of the same width and type, and measured. */
  var paintTimer = 0;
  var ROW = 19, wrapped = false, heights = null, tops = null, measureTimer = 0;
  function topOf(line) { return tops ? tops[Math.min(line, tops.length - 1)] : line * ROW; }          // line counts from 0
  function heightOf(line) { return heights ? heights[Math.min(line, heights.length - 1)] : ROW; }
  function numberLines() {
    var lines = text.value.split('\n'), i;
    if (!wrapped) {
      heights = tops = null;
      if (gutter.dataset.lines !== 'n' + lines.length) { var nums = ''; for (i = 1; i <= lines.length; i++) nums += i + '\n'; gutter.textContent = nums; gutter.dataset.lines = 'n' + lines.length; }
      return;
    }
    measure.style.width = text.clientWidth + 'px';
    var frag = document.createDocumentFragment();
    for (i = 0; i < lines.length; i++) { var d = document.createElement('div'); d.textContent = lines[i] || '\u200b'; frag.appendChild(d); }
    measure.textContent = ''; measure.appendChild(frag);
    heights = new Array(lines.length); tops = new Array(lines.length); var y = 0, kids = measure.children;
    for (i = 0; i < lines.length; i++) { heights[i] = kids[i].offsetHeight || ROW; tops[i] = y; y += heights[i]; }
    measure.textContent = '';
    var g = document.createDocumentFragment();
    for (i = 0; i < lines.length; i++) { var r = document.createElement('div'); r.textContent = String(i + 1); if (heights[i] !== ROW) r.style.height = heights[i] + 'px'; g.appendChild(r); }
    gutter.textContent = ''; gutter.appendChild(g); gutter.dataset.lines = 'w';
  }
  function setWrap(on) {
    wrapped = !!on; document.body.classList.toggle('wrap', wrapped); text.setAttribute('wrap', wrapped ? 'soft' : 'off');
    sWrap.textContent = wrapped ? S('wrapOn', 'Wrap: On') : S('wrapOff', 'Wrap: Off');
    try { localStorage.setItem('textile.wrap', wrapped ? '1' : '0'); } catch (e) { /* no storage; the choice lasts for this window */ }
    gutter.dataset.lines = ''; repaint(); reveal();
  }

  function repaint() {
    var v = text.value, painter = PAINTERS[syntax], on = !!painter && v.length <= (syntax === 'JSON' ? LIMIT : LIMIT / 2);
    clearTimeout(paintTimer);
    function colour() { paint.innerHTML = painter(text.value) + '\n'; text.classList.add('painted'); }      // only ever our own spans around escaped text
    if (!on) { text.classList.remove('painted'); paint.textContent = ''; }
    else if (v.length <= 60000) colour();
    else { text.classList.remove('painted'); paint.textContent = ''; paintTimer = setTimeout(colour, 180); }   // a long file is coloured once the typing pauses, and shown plain meanwhile
    if (wrapped && v.length > 200000) { clearTimeout(measureTimer); measureTimer = setTimeout(function () { numberLines(); sync(); }, 200); } else numberLines();
    sync();
    if (CTX.setDirty) CTX.setDirty(v !== saved);
    if (CTX.setTitle) CTX.setTitle(NAME + ' \u2014 ' + file.name + (v !== saved ? ' \u2022' : ''));
    clearTimeout(checkTimer); checkTimer = setTimeout(check, 250);
  }
  function sync() {
    paint.style.width = wrapped ? text.clientWidth + 'px' : '';             // the textarea's scrollbar takes room the painted layer must not use
    gutter.style.marginBottom = (text.offsetHeight - text.clientHeight) + 'px';        // stop the numbers short of a horizontal scroll bar
    paint.style.transform = 'translate(' + (-text.scrollLeft) + 'px,' + (-text.scrollTop) + 'px)'; gutter.scrollTop = text.scrollTop; place();
  }
  function place() {
    var upto = text.value.slice(0, text.selectionStart), ln = upto.split('\n').length, col = upto.length - upto.lastIndexOf('\n');
    band.style.top = (4 + topOf(ln - 1) - text.scrollTop) + 'px'; band.style.height = heightOf(ln - 1) + 'px';
    band.style.display = text.selectionStart === text.selectionEnd ? '' : 'none';
    var sel = text.selectionEnd - text.selectionStart;
    sPos.textContent = S('lineCol', 'Line {ln}, Column {col}', { ln: ln, col: col }) + (sel ? '  ' + S('selected', '({n} selected)', { n: sel }) : '');
  }

  /* Is it JSON? Says where it stops being, in the editor's own terms. */
  var hold = 0;                                   // a message about saving or opening stays up for a moment
  function check() {
    if (Date.now() < hold) { clearTimeout(checkTimer); checkTimer = setTimeout(check, hold - Date.now() + 20); return; }
    if (syntax !== 'JSON') { if (sMsg.dataset.kind === 'json') note('', 'json'); return; }
    var v = text.value; if (!v.trim()) return note('', 'json');
    try { JSON.parse(v); note(S('validJson', 'Valid JSON'), 'json', 'good'); }
    catch (e) {
      var m = /position (\d+)/.exec(e.message), at = '';
      if (m) { var upto = v.slice(0, +m[1]); at = ' (line ' + upto.split('\n').length + ', column ' + (upto.length - upto.lastIndexOf('\n')) + ')'; }
      note(S('notValidJson', 'Not valid JSON: ') + e.message.replace(/^JSON\.parse: /, '').replace(/ in JSON at position \d+.*$/, '').replace(/ at position \d+.*$/, '') + at, 'json', 'bad');
    }
  }
  function note(msg, kind, cls) { if (kind !== 'json') hold = msg ? Date.now() + 2500 : 0; sMsg.textContent = msg; sMsg.dataset.kind = kind || ''; sMsg.className = 'msg' + (cls ? ' ' + cls : ''); }

  function setSyntax(name, mime) {
    syntax = /\.json$/i.test(name) || /json/i.test(mime || '') ? 'JSON' : /\.(m?js|cjs)$/i.test(name) || /(java|ecma)script/i.test(mime || '') ? 'JavaScript' : /\.(md|markdown)$/i.test(name) ? 'Markdown' : /\.log$/i.test(name) ? 'Log' : 'Plain Text';
    var SYN = { JSON: S('synJson','JSON'), JavaScript: S('synJs','JavaScript'), Markdown: S('synMd','Markdown'), Log: S('synLog','Log'), 'Plain Text': S('synPlain','Plain Text') };
    sSyn.textContent = SYN[syntax] || syntax;
  }

  /* ---------------------------------------------------------------- CDMI */

  function b64(s) { var bin = atob(String(s).replace(/\s+/g, '')), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  async function cdmi(method, url, type, body, extra) {
    if (!/^https:/i.test(url)) throw new Error('refused: only https: URIs are opened (TLS only)');
    var h = { Accept: type }; if (body !== undefined) h['Content-Type'] = type;
    for (var k in HEADERS) h[k] = HEADERS[k]; for (k in (extra || {})) h[k] = extra[k];
    var res = await fetch(url, { method: method, headers: h, body: body, redirect: 'follow', credentials: 'same-origin', cache: 'no-store' });
    if (res.url && !/^https:/i.test(res.url)) throw new Error('refused: redirected to a URI that is not https:');
    return res;
  }
  async function problem(res) { var p = null; try { p = await res.json(); } catch (e) { /* no problem details */ } return new Error(res.status + ' ' + ((p && [p.title, p.detail].filter(Boolean).join(': ')) || res.statusText || '')); }

  async function load(url) {
    note(S('reading', 'Reading {n} \u2026', { n: decodeURIComponent(url.split('/').pop()) }));
    try {
      var res = await cdmi('GET', url.replace(/[?#].*$/, '') + '?objectType&objectName&mimetype&valuetransferencoding&value', T_OBJECT);
      if (!res.ok) throw await problem(res);
      var at = (res.url || url).replace(/[?#].*$/, ''), type = (res.headers.get('content-type') || '').toLowerCase(), value, enc = 'utf-8', mime = 'text/plain';
      if (/^application\/(cdmi-|json)/.test(type)) {
        var rep = await res.json();
        if (rep.value === undefined && at !== url.replace(/[?#].*$/, '')) { res = await cdmi('GET', at + '?objectType&objectName&mimetype&valuetransferencoding&value', T_OBJECT); if (!res.ok) throw await problem(res); rep = await res.json(); }   // a reference: the redirect dropped the selection
        enc = rep.valuetransferencoding || 'utf-8'; mime = rep.mimetype || mime;
        if (enc === 'json') value = JSON.stringify(rep.value, null, 2) + '\n';
        else if (enc === 'base64') { try { value = new TextDecoder('utf-8', { fatal: true }).decode(b64(rep.value || '')); } catch (e) { throw new Error(S('notText', 'this object is not text')); } }
        else value = rep.value === undefined ? '' : String(rep.value);
      } else value = await res.text();
      file = { url: at, name: decodeURIComponent(at.split('/').pop()), dir: at.replace(/[^\/]*$/, ''), encoding: enc, mime: mime };
      adopt(value); note('');
    } catch (e) { note(S('couldNotOpen', 'Could not open: {e}', { e: e.message }), '', 'bad'); }
  }
  function adopt(value) {
    text.value = value; saved = value; text.setSelectionRange(0, 0); text.scrollTop = 0; text.scrollLeft = 0;
    tabName.textContent = file.name; setSyntax(file.name, file.mime);
    sEnc.textContent = file.encoding === 'json' ? S('encJson', 'UTF-8 (stored as JSON)') : S('enc', 'UTF-8');
    gutter.dataset.lines = ''; repaint(); text.focus();          // numbers are rebuilt for the new text
  }

  async function save() {
    if (!file.url) return saveAs();
    var v = text.value, body, query;
    try {
      if (file.encoding === 'json') {             // stored as a JSON value, so it has to be one
        try { body = { value: JSON.parse(v) }; } catch (e) { throw new Error('this object is stored as JSON and the text is not valid JSON; use Save As to keep it as text'); }
        query = '?value';
      } else { body = { valuetransferencoding: 'utf-8', value: v }; query = file.encoding === 'utf-8' ? '?value' : '?valuetransferencoding&value'; if (query === '?value') delete body.valuetransferencoding; }
      note(S('saving', 'Saving \u2026'));
      var res = await cdmi('PUT', file.url + query, T_OBJECT, JSON.stringify(body));
      if (!res.ok) throw await problem(res);
      if (file.encoding !== 'json') file.encoding = 'utf-8';
      saved = v; repaint(); note(S('saved', 'Saved {n}', { n: file.name }), '', 'good');
    } catch (e) { note(S('notSaved', 'Not saved: {e}', { e: e.message }), '', 'bad'); }
  }

  async function create(dir, name, replace) {
    var v = text.value, url = dir + encodeURIComponent(name);
    var mime = /\.json$/i.test(name) ? 'application/json' : /\.(md|markdown)$/i.test(name) ? 'text/markdown' : /\.html?$/i.test(name) ? 'text/html' : /\.css$/i.test(name) ? 'text/css' : /\.m?js$/i.test(name) ? 'text/javascript' : /\.csv$/i.test(name) ? 'text/csv' : /\.xml$/i.test(name) ? 'application/xml' : 'text/plain';
    var res = await cdmi('PUT', url, T_OBJECT, JSON.stringify({ mimetype: mime, metadata: {}, valuetransferencoding: 'utf-8', value: v }), replace ? {} : { 'If-None-Match': '*' });
    if (!replace && res.status === 412) return 'exists';
    if (!res.ok) throw await problem(res);
    file = { url: url, name: name, dir: dir, encoding: 'utf-8', mime: mime };
    saved = v; tabName.textContent = name; setSyntax(name, mime); sEnc.textContent = S('enc', 'UTF-8'); repaint(); note(S('saved', 'Saved {n}', { n: name }), '', 'good');
    return 'saved';
  }

  /* ---------------------------------------------------------------- Save As: the shared desktop Open/Save dialog */

  function saveAs() {
    var D = CTX.desktop;
    if (!(D && D.pickObject)) { note(S('noPicker', 'No Open/Save dialog is available.'), '', 'bad'); return; }
    var prefill = file.url ? file.name : (file.name === 'untitled' ? 'untitled.txt' : file.name);
    // The dialog follows the current theme. It confirms before overwriting an existing object, so the create here
    // replaces unconditionally.
    D.pickObject({ mode: 'save', theme: isDark() ? 'dark' : 'light', title: S('saveAsTitle', 'Save As'), saveLabel: S('save', 'Save'),
        name: prefill, startURI: (file.dir || CTX.baseURI || CTX.homeURI || null) })
      .then(function (url) {
        if (!url) return;
        var dir = url.replace(/[^\/]*$/, ''), name = decodeURIComponent(url.slice(dir.length));
        create(dir, name, true).catch(function (e) { note(S('notSaved', 'Not saved: {e}', { e: e.message }), '', 'bad'); });
      });
  }

  /* Unsaved work is asked about before it is replaced by another file. */
  var pendingDiscard = null;
  function careful(what, go) {
    if (text.value === saved || pendingDiscard === what) { pendingDiscard = null; return go(); }
    pendingDiscard = what; note(S('unsavedDiscard', 'There are unsaved changes. Do the same again to discard them.'), '', 'bad');
  }
  function openWithCare(url) { careful('open:' + url, function () { load(url); }); }
  function fresh(dir) { file = { url: null, name: 'untitled', dir: dir || file.dir, encoding: 'utf-8', mime: 'text/plain' }; adopt(''); note(''); }

  /* ---------------------------------------------------------------- editing */

  /* Through execCommand where the browser has it, so that these edits land on the undo stack like typing. */
  function replaceRange(from, to, str, selFrom, selTo) {
    text.focus(); text.setSelectionRange(from, to);
    var ok = false; try { ok = document.execCommand('insertText', false, str); } catch (e) { ok = false; }
    if (!ok) text.setRangeText(str, from, to, 'end');
    if (selFrom !== undefined) text.setSelectionRange(selFrom, selTo === undefined ? selFrom : selTo);
    repaint();
  }
  var INDENT = '    ';
  function indent(out) {
    var v = text.value, a = text.selectionStart, b = text.selectionEnd;
    if (a === b && !out) return replaceRange(a, b, INDENT);
    var start = v.lastIndexOf('\n', a - 1) + 1, end = b > a && v[b - 1] === '\n' ? b - 1 : b, block = v.slice(start, end), first = 0;
    var lines = block.split('\n').map(function (l, i) {
      if (!out) { if (i === 0) first = INDENT.length; return INDENT + l; }
      var cut = /^(\t| {1,4})/.exec(l), n = cut ? cut[0].length : 0; if (i === 0) first = -Math.min(n, a - start); return l.slice(n);
    }), next = lines.join('\n');
    replaceRange(start, end, next, Math.max(start, a + first), a === b ? Math.max(start, a + first) : start + next.length + (end < b ? 1 : 0));
  }
  function newline() {
    var v = text.value, a = text.selectionStart, start = v.lastIndexOf('\n', a - 1) + 1, lead = /^[ \t]*/.exec(v.slice(start, a))[0];
    var opens = /[{\[]\s*$/.test(v.slice(start, a)), closes = opens && /^\s*[}\]]/.test(v.slice(text.selectionEnd));
    var ins = '\n' + lead + (opens ? INDENT : '');
    replaceRange(a, text.selectionEnd, ins + (closes ? '\n' + lead : ''), a + ins.length);
    reveal();
  }
  function reveal() {
    var ln = text.value.slice(0, text.selectionStart).split('\n').length, top = topOf(ln - 1), h = text.clientHeight;
    if (top < text.scrollTop + ROW) text.scrollTop = Math.max(0, top - 2 * ROW); else if (top + heightOf(ln - 1) > text.scrollTop + h - 2 * ROW) text.scrollTop = top + heightOf(ln - 1) - h + 3 * ROW;
    sync();
  }

  /* ---------------------------------------------------------------- find, and go to line */

  var findMode = 'find';
  function showFind(m) {
    findMode = m; find.classList.add('on'); fIn.placeholder = m === 'goto' ? S('gotoPlaceholder', 'Line number, then Enter') : S('findLabel', 'Find');
    fPrev.style.display = fNext.style.display = m === 'goto' ? 'none' : '';
    var sel = text.value.slice(text.selectionStart, text.selectionEnd);
    fIn.value = m === 'find' && sel && sel.indexOf('\n') < 0 ? sel : m === 'find' ? fIn.value : ''; fCount.textContent = '';
    fIn.focus(); fIn.select(); if (m === 'find') count();
  }
  function hideFind() { find.classList.remove('on'); text.focus(); }
  function count() { var q = fIn.value, n = 0, i = -1, v = text.value.toLowerCase(); if (q) { q = q.toLowerCase(); while ((i = v.indexOf(q, i + 1)) >= 0 && n < 9999) n++; } fCount.textContent = q ? n + (n === 1 ? S('matchOne', ' match') : S('matchMany', ' matches')) : ''; return n; }
  function step(back) {
    var q = fIn.value.toLowerCase(); if (!q) return;
    var v = text.value.toLowerCase(), i = back ? v.lastIndexOf(q, text.selectionStart - 1) : v.indexOf(q, text.selectionEnd);
    if (i < 0) i = back ? v.lastIndexOf(q) : v.indexOf(q);          // wrap around
    if (i < 0) return;
    text.setSelectionRange(i, i + q.length); reveal(); place();
  }
  fIn.addEventListener('input', function () { if (findMode === 'find') count(); });
  fIn.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); hideFind(); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (findMode === 'goto') { var n = parseInt(fIn.value, 10), lines = text.value.split('\n'); if (n >= 1) { n = Math.min(n, lines.length); var pos = lines.slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0); hideFind(); text.setSelectionRange(pos, pos); reveal(); place(); } }
      else { step(ev.shiftKey); fIn.focus(); }
    }
  });
  fNext.addEventListener('click', function () { step(false); }); fPrev.addEventListener('click', function () { step(true); }); fClose.addEventListener('click', hideFind);

  /* ---------------------------------------------------------------- keys and buttons */

  text.addEventListener('input', repaint);
  text.addEventListener('scroll', sync);
  ['keyup', 'click', 'select', 'focus'].forEach(function (n) { text.addEventListener(n, place); });
  document.addEventListener('selectionchange', function () { if (document.activeElement === text) place(); });
  window.addEventListener('resize', function () { if (wrapped) numberLines(); sync(); });

  text.addEventListener('keydown', function (ev) {
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); indent(ev.shiftKey); }
    else if (ev.key === 'Enter' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.isComposing) { ev.preventDefault(); newline(); }
  });
  document.addEventListener('keydown', function (ev) {
    var mod = (ev.ctrlKey || ev.metaKey) && !ev.altKey, k = ev.key.toLowerCase();
    if (ev.key === 'Escape') { if (find.classList.contains('on')) { ev.preventDefault(); hideFind(); } return; }
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && k === 'z') { ev.preventDefault(); setWrap(!wrapped); return; }
    if (!mod) return;
    if (k === 'n') { ev.preventDefault(); careful('new', function () { fresh(); }); }
    else if (k === 's') { ev.preventDefault(); if (ev.shiftKey) saveAs(); else save(); }
    else if (k === 'o') { ev.preventDefault(); openViaPicker(); }
    else if (k === 'f') { ev.preventDefault(); showFind('find'); }
    else if (k === 'g') { ev.preventDefault(); showFind('goto'); }
    else if (k === 'd' && ev.shiftKey) { ev.preventDefault(); setDark(!isDark()); }
  });
  function openViaPicker() {
    if (!(CTX.desktop && CTX.desktop.pickObject)) { note(S('noPicker', 'No Open/Save dialog is available.'), '', 'bad'); return; }
    CTX.desktop.pickObject({ theme: isDark() ? 'dark' : 'light', title: S('openTitle', 'Open'), startURI: (file.dir || CTX.baseURI || CTX.homeURI || null) })
      .then(function (url) { if (url) openWithCare(url); });
  }

  /* ---------------------------------------------------------------- start */

  var keptWrap = false; try { keptWrap = localStorage.getItem('textile.wrap') === '1'; } catch (e) { /* no storage */ }
  if (CTX.resize) CTX.resize(860, 560);
  if (CTX.startURI && /\/$/.test(CTX.startURI)) fresh(CTX.startURI);                   // "New text file" in a container
  else { fresh(CTX.baseURI || null); if (CTX.startURI) load(CTX.startURI); }
  if (keptWrap) setWrap(true);
})();
