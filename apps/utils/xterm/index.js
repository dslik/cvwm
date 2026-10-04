/*!
 * xterm for cvwm: a shell. Store this file as "index.js" in /apps/utils/xterm/ and open it from the desktop.
 *
 * The shell has four built-in commands (cd, help, history, clear, exit). Everything else typed at the prompt
 * is looked for as a command in /bin/<name>/index.js (or /dev/tests/<name>/ for test commands), on the current disk and then on the others, and run
 * in a hidden frame with a process context: argv, cwd, stdout(), stderr(), exit(), and "shell", a library of
 * CDMI helpers this file defines (below, under "the shell library"). A name found in /apps/<name>/ instead is
 * a GUI application, started in a window by cvwm with the same context. DEVELOPERS.md describes both.
 *
 * Output is plain text; a command may colour it with the usual SGR escapes (ESC[1m bold, ESC[31m..36m colours,
 * ESC[0m reset), which the terminal renders.
 *
 * Commands are kept in ~/.history in the home directory (HOMES.md), read at start and appended to as they are
 * entered; without a home the history lasts only for the window.
 *
 * The desktop hands over window.CDMI_CONTEXT = { baseURI, containerURI, diskName, startURI,
 * namespaces:[{name, baseURI}], headers, setTitle(), open(), close() }. It sets dropTarget/onUpload there so
 * that files dropped on the window land in the current container. Without the context (the file loaded
 * by a page of your own) the terminal reads /.well-known/cdmi/cdmi_namespaces/ itself.
 */
(function () {
  'use strict';

  var CTX = window.CDMI_CONTEXT || {};
  var HEADERS = CTX.headers || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string; the terminal stylesheet is pulled where present.
  var R = CTX.rsrc || null;
  function S(id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; }
  var NAME = S('title', 'xterm');
  var ORIGIN = CTX.origin || location.origin;
  var T_CONTAINER = 'application/cdmi-container', T_QUEUE = 'application/cdmi-queue';
  var ACCEPT_DIR = T_CONTAINER + ', application/cdmi-capability;q=0.9, application/cdmi-domain;q=0.9';
  var T_OBJECT = 'application/cdmi-object';
  /* What a name without a trailing "/" may turn out to be; one request, and the server chooses among these. */
  var ACCEPT_LEAF = T_OBJECT + ', ' + T_QUEUE + ';q=0.9, ' + T_CONTAINER + ';q=0.8, application/cdmi-capability;q=0.7, application/cdmi-domain;q=0.7';
  var VALUE_FIELDS = '?objectType&mimetype&metadata&valuetransferencoding&value';     // a value is returned only where a read selects it
  var STAT_FIELDS = 'objectType&objectID&objectName&parentURI&parentID&domainURI&capabilitiesURI&completionStatus&mimetype&valuetransferencoding&valuerange&childrenrange&metadata';

  var NS = [];                       // {name, base}
  var HOME = null;                   // the home loc, or null (HOMES.md)
  var cwd = null, prev = null;       // {ns, segs}
  var history = [], histPos = 0, stash = '';
  var HISTMAX = 2000, histFile = null, histSaved = '', histTimer = 0, histDirty = false;   // ~/.history, once home is known
  var line = '', cur = 0, busy = false, abort = null;
  var extendedOK = {}, dirCache = {};

  /* ---------------------------------------------------------------- the terminal

     A grid of cells, a cursor, and an interpreter of the escape sequences a VT100-family terminal understands:
     cursor movement and addressing, erasing, insertion and deletion, scrolling regions, SGR attributes with 16, 256 and
     true colour, the alternate screen, a saved cursor, and answers to the enquiries (DA, DSR) that programs make.
     Lines that scroll off the top of the main screen go into a scrollback. The grid is drawn afresh at most once a
     frame; the scrollback is ordinary rows above it.

     The shell writes to this the way any program would (its line editor redraws the prompt line with \r and an
     erase), and a running command may take the keyboard over (CDMI_CONTEXT.stdin) and learn the size (.tty). */
  var CSS = document.createElement('style');
  var DEFAULT_CSS =
    'html,body{margin:0;height:100%;background:#000;overflow:hidden}' +
    '#t{box-sizing:border-box;height:100%;overflow-y:auto;overflow-x:hidden;padding:4px 6px;color:#d0d0d0;background:#000;font:13px/18px "DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;outline:none;cursor:text}' +
    '#t .r{white-space:pre;height:18px;overflow:hidden}' +
    '#grid .r{white-space:pre}' +
    '.f0{color:#000}.f1{color:#ff8a80}.f2{color:#7fd48f}.f3{color:#e6d37a}.f4{color:#8fb8ff}.f5{color:#d8a0ff}.f6{color:#7fdfe0}.f7{color:#d0d0d0}' +
    '.f8{color:#6a6a6a}.f9{color:#ffb0a8}.f10{color:#a8f0b8}.f11{color:#f5e7a8}.f12{color:#b8d4ff}.f13{color:#e8c4ff}.f14{color:#b0f0f0}.f15{color:#fff}' +
    '.b0{background:#000}.b1{background:#a03028}.b2{background:#2c7a3c}.b3{background:#8a7a20}.b4{background:#2e4e8e}.b5{background:#7a4a9a}.b6{background:#2a7a7e}.b7{background:#bfbfbf}' +
    '.b8{background:#444}.b9{background:#d05040}.b10{background:#40a050}.b11{background:#b0a030}.b12{background:#4060c0}.b13{background:#a060c0}.b14{background:#40a0a8}.b15{background:#eee}' +
    '.B{font-weight:bold}.D{opacity:.6}.I{font-style:italic}.U{text-decoration:underline}.S{text-decoration:line-through}.Rf{color:#000}.Rb{background:#d0d0d0}' +
    '.cur{outline:1px solid #d0d0d0;outline-offset:-1px}#t.focus .cur{background:#d0d0d0;color:#000;outline:none}' +
    '::selection{background:#4a6a8a;color:#fff}';
  CSS.textContent = (R && R.text('styles', 'xterm')) || DEFAULT_CSS;
  document.head.appendChild(CSS);
  var T = document.createElement('div'); T.id = 't'; T.tabIndex = 0; T.setAttribute('role', 'application'); T.setAttribute('aria-label', S('terminal', 'Terminal'));
  var back = document.createElement('div'), grid = document.createElement('div'); back.id = 'back'; grid.id = 'grid';
  T.appendChild(back); T.appendChild(grid); document.body.appendChild(T);

  var ROWH = 18, CHARW = 7.8, SCROLLBACK = 5000;
  function measure() { var p = document.createElement('span'); p.className = 'r'; p.textContent = 'MMMMMMMMMMMMMMMMMMMM'; p.style.cssText = 'position:absolute;visibility:hidden;display:inline-block;height:auto'; T.appendChild(p); CHARW = p.getBoundingClientRect().width / 20 || 7.8; ROWH = p.getBoundingClientRect().height || 18; T.removeChild(p); }
  measure();

  /* A cell is a character and a packed attribute: fg (9 bits: 256 colours or 24-bit marked), bg, and flags. Kept as
     parallel arrays per row for speed. Colours beyond 255 are true colour, stored as 256 + rgb index in a table. */
  var FLAG = { B: 1, D: 2, I: 4, U: 8, S: 16, R: 32 }, DEF_FG = -1, DEF_BG = -1, rgbTable = [], rgbIndex = {};
  function rgb(r, g, b) { var k = (r << 16) | (g << 8) | b; if (!(k in rgbIndex)) { rgbIndex[k] = rgbTable.length; rgbTable.push('rgb(' + r + ',' + g + ',' + b + ')'); } return 256 + rgbIndex[k]; }
  function Row(cols) { this.ch = new Array(cols).fill(' '); this.fg = new Int16Array(cols).fill(DEF_FG); this.bg = new Int16Array(cols).fill(DEF_BG); this.fl = new Uint8Array(cols); this.wrapped = false; }
  Row.prototype.clear = function (from, to, bg) { for (var i = from; i < to; i++) { this.ch[i] = ' '; this.fg[i] = DEF_FG; this.bg[i] = bg === undefined ? DEF_BG : bg; this.fl[i] = 0; } };

  function Screen(rows, cols) {
    this.rows = rows; this.cols = cols; this.lines = []; for (var i = 0; i < rows; i++) this.lines.push(new Row(cols));
    this.x = 0; this.y = 0; this.top = 0; this.bottom = rows - 1;
    this.fg = DEF_FG; this.bg = DEF_BG; this.fl = 0; this.wrapNext = false; this.saved = null;
  }
  var term = {
    main: null, alt: null, s: null, scrollback: [], title: '', state: 0, params: '', inter: '', osc: '',
    cursorVisible: true, appCursor: false, autoWrap: true, bracketedPaste: false, dirty: true, stuck: true, autoScroll: false, rendered: 0
  };

  function size() { var w = T.clientWidth - 12, h = T.clientHeight - 8; return { cols: Math.max(20, Math.floor(w / CHARW)), rows: Math.max(4, Math.floor(h / ROWH)) }; }
  function resizeScreen(sc, rows, cols) {
    var i;
    if (cols !== sc.cols) sc.lines.forEach(function (r) { var n = new Row(cols); for (i = 0; i < Math.min(cols, sc.cols); i++) { n.ch[i] = r.ch[i]; n.fg[i] = r.fg[i]; n.bg[i] = r.bg[i]; n.fl[i] = r.fl[i]; } r.ch = n.ch; r.fg = n.fg; r.bg = n.bg; r.fl = n.fl; });
    while (sc.lines.length < rows) sc.lines.push(new Row(cols));
    while (sc.lines.length > rows) { if (sc.y >= sc.lines.length - 1 || sc === term.main && sc.y > 0) { var gone = sc.lines.shift(); if (sc === term.main) pushBack(gone); sc.y--; } else sc.lines.pop(); }
    sc.rows = rows; sc.cols = cols; sc.top = 0; sc.bottom = rows - 1; sc.x = Math.min(sc.x, cols - 1); sc.y = Math.max(0, Math.min(sc.y, rows - 1)); sc.wrapNext = false;
  }
  function pushBack(row) {
    term.scrollback.push(row); back.appendChild(renderRow(row, -1));
    if (term.scrollback.length > SCROLLBACK) { term.scrollback.shift(); back.removeChild(back.firstChild); }
    if (term.stuck) { term.autoScroll = true; T.scrollTop = T.scrollHeight; }   // keep following the bottom as lines scroll off
  }

  /* ---- writing */
  function restore(sc) { var sv = sc.saved; if (!sv) return; sc.x = Math.min(sv.x, sc.cols - 1); sc.y = Math.min(sv.y, sc.rows - 1); sc.fg = sv.fg; sc.bg = sv.bg; sc.fl = sv.fl; sc.wrapNext = false; }   // the screen may have shrunk meanwhile
  function scrollUp(sc, n) {
    for (var k = 0; k < n; k++) { var gone = sc.lines.splice(sc.top, 1)[0]; if (sc === term.main && sc.top === 0) pushBack(gone); sc.lines.splice(sc.bottom, 0, new Row(sc.cols)); }
  }
  function scrollDown(sc, n) { for (var k = 0; k < n; k++) { sc.lines.splice(sc.bottom, 1); sc.lines.splice(sc.top, 0, new Row(sc.cols)); } }
  function lineFeed(sc) { if (sc.y >= sc.rows) sc.y = sc.rows - 1; if (sc.y === sc.bottom) scrollUp(sc, 1); else if (sc.y < sc.rows - 1) sc.y++; }
  function putChar(sc, ch) {
    if (sc.wrapNext) { if (term.autoWrap) { sc.lines[sc.y].wrapped = true; sc.x = 0; lineFeed(sc); } sc.wrapNext = false; }
    if (sc.y >= sc.rows) sc.y = sc.rows - 1; if (sc.x >= sc.cols) sc.x = sc.cols - 1;
    var wide = isWide(ch);
    if (wide && sc.x === sc.cols - 1) { if (term.autoWrap) { sc.lines[sc.y].wrapped = true; sc.x = 0; lineFeed(sc); } else return; }   // no room for both halves
    var r = sc.lines[sc.y]; r.ch[sc.x] = ch; r.fg[sc.x] = sc.fg; r.bg[sc.x] = sc.bg; r.fl[sc.x] = sc.fl;
    if (wide) { sc.x++; r.ch[sc.x] = ''; r.fg[sc.x] = sc.fg; r.bg[sc.x] = sc.bg; r.fl[sc.x] = sc.fl; }      // the second cell of a wide character draws nothing
    if (sc.x === sc.cols - 1) sc.wrapNext = true; else sc.x++;
  }
  var WIDE = /^[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\ud83c-\ud83e][\udc00-\udfff]/;
  function isWide(ch) { return WIDE.test(ch); }
  function eraseLine(sc, mode) { var r = sc.lines[sc.y]; if (mode === 0) r.clear(sc.x, sc.cols, sc.bg); else if (mode === 1) r.clear(0, sc.x + 1, sc.bg); else r.clear(0, sc.cols, sc.bg); }
  function eraseScreen(sc, mode) {
    if (mode === 0) { eraseLine(sc, 0); for (var i = sc.y + 1; i < sc.rows; i++) sc.lines[i].clear(0, sc.cols, sc.bg); }
    else if (mode === 1) { eraseLine(sc, 1); for (i = 0; i < sc.y; i++) sc.lines[i].clear(0, sc.cols, sc.bg); }
    else { if (sc === term.main && mode === 2) sc.lines.forEach(function (r) { if (r.ch.join('').trim()) pushBack(r); }); for (i = 0; i < sc.rows; i++) sc.lines[i] = new Row(sc.cols); if (mode === 3) { term.scrollback = []; back.textContent = ''; } }
  }
  function sgr(sc, ps) {
    var p = ps.length ? ps : [0];
    for (var i = 0; i < p.length; i++) {
      var n = p[i];
      if (n === 0) { sc.fg = DEF_FG; sc.bg = DEF_BG; sc.fl = 0; }
      else if (n === 1) sc.fl |= FLAG.B; else if (n === 2) sc.fl |= FLAG.D; else if (n === 3) sc.fl |= FLAG.I; else if (n === 4) sc.fl |= FLAG.U; else if (n === 7) sc.fl |= FLAG.R; else if (n === 9) sc.fl |= FLAG.S;
      else if (n === 22) sc.fl &= ~(FLAG.B | FLAG.D); else if (n === 23) sc.fl &= ~FLAG.I; else if (n === 24) sc.fl &= ~FLAG.U; else if (n === 27) sc.fl &= ~FLAG.R; else if (n === 29) sc.fl &= ~FLAG.S;
      else if (n >= 30 && n <= 37) sc.fg = n - 30; else if (n === 39) sc.fg = DEF_FG; else if (n >= 40 && n <= 47) sc.bg = n - 40; else if (n === 49) sc.bg = DEF_BG;
      else if (n >= 90 && n <= 97) sc.fg = n - 90 + 8; else if (n >= 100 && n <= 107) sc.bg = n - 100 + 8;
      else if (n === 38 || n === 48) {
        var v = null;
        if (p[i + 1] === 5) { v = p[i + 2] | 0; i += 2; } else if (p[i + 1] === 2) { v = rgb(p[i + 2] | 0, p[i + 3] | 0, p[i + 4] | 0); i += 4; }
        if (v !== null) { if (n === 38) sc.fg = v; else sc.bg = v; }
      }
    }
  }
  function csi(sc, final, params, inter) {
    var p = params.length ? params.split(';').map(function (x) { return x === '' ? 0 : parseInt(x, 10); }) : [], n = p[0] || 1, priv = inter === '?';
    switch (final) {
      case 'A': sc.y = Math.max(sc.y >= sc.top ? sc.top : 0, sc.y - n); sc.wrapNext = false; break;
      case 'B': sc.y = Math.min(sc.y <= sc.bottom ? sc.bottom : sc.rows - 1, sc.y + n); sc.wrapNext = false; break;
      case 'C': sc.x = Math.min(sc.cols - 1, sc.x + n); sc.wrapNext = false; break;
      case 'D': sc.x = Math.max(0, sc.x - n); sc.wrapNext = false; break;
      case 'E': sc.x = 0; sc.y = Math.min(sc.rows - 1, sc.y + n); break;
      case 'F': sc.x = 0; sc.y = Math.max(0, sc.y - n); break;
      case 'G': sc.x = Math.min(sc.cols - 1, Math.max(0, n - 1)); sc.wrapNext = false; break;
      case 'H': case 'f': sc.y = Math.min(sc.rows - 1, Math.max(0, (p[0] || 1) - 1)); sc.x = Math.min(sc.cols - 1, Math.max(0, (p[1] || 1) - 1)); sc.wrapNext = false; break;
      case 'd': sc.y = Math.min(sc.rows - 1, Math.max(0, n - 1)); sc.wrapNext = false; break;
      case 'J': eraseScreen(sc, p[0] || 0); break;
      case 'K': eraseLine(sc, p[0] || 0); break;
      case 'L': if (sc.y >= sc.top && sc.y <= sc.bottom) for (var k = 0; k < n; k++) { sc.lines.splice(sc.bottom, 1); sc.lines.splice(sc.y, 0, new Row(sc.cols)); } break;
      case 'M': if (sc.y >= sc.top && sc.y <= sc.bottom) for (k = 0; k < n; k++) { sc.lines.splice(sc.y, 1); sc.lines.splice(sc.bottom, 0, new Row(sc.cols)); } break;
      case 'P': { var r = sc.lines[sc.y]; for (k = 0; k < n; k++) { r.ch.splice(sc.x, 1); r.ch.push(' '); r.fg.copyWithin(sc.x, sc.x + 1); r.bg.copyWithin(sc.x, sc.x + 1); r.fl.copyWithin(sc.x, sc.x + 1); r.fg[sc.cols - 1] = DEF_FG; r.bg[sc.cols - 1] = DEF_BG; r.fl[sc.cols - 1] = 0; } break; }
      case '@': { r = sc.lines[sc.y]; for (k = 0; k < n; k++) { r.ch.splice(sc.x, 0, ' '); r.ch.length = sc.cols; r.fg.copyWithin(sc.x + 1, sc.x); r.bg.copyWithin(sc.x + 1, sc.x); r.fl.copyWithin(sc.x + 1, sc.x); r.fg[sc.x] = DEF_FG; r.bg[sc.x] = sc.bg; r.fl[sc.x] = 0; } break; }
      case 'X': sc.lines[sc.y].clear(sc.x, Math.min(sc.cols, sc.x + n), sc.bg); break;
      case 'S': scrollUp(sc, n); break;
      case 'T': scrollDown(sc, n); break;
      case 'r': sc.top = Math.max(0, (p[0] || 1) - 1); sc.bottom = Math.min(sc.rows - 1, (p[1] || sc.rows) - 1); if (sc.top >= sc.bottom) { sc.top = 0; sc.bottom = sc.rows - 1; } sc.x = 0; sc.y = 0; break;
      case 'm': sgr(sc, p); break;
      case 's': sc.saved = { x: sc.x, y: sc.y, fg: sc.fg, bg: sc.bg, fl: sc.fl }; break;
      case 'u': restore(sc); break;
      case 'h': case 'l': { var on = final === 'h';
        p.forEach(function (m) {
          if (!priv) return;
          if (m === 1) term.appCursor = on; else if (m === 7) term.autoWrap = on; else if (m === 25) term.cursorVisible = on; else if (m === 2004) term.bracketedPaste = on;
          else if (m === 47 || m === 1047 || m === 1049) {
            if (on && term.s === term.main) { if (m === 1049) term.main.saved = { x: term.main.x, y: term.main.y, fg: term.main.fg, bg: term.main.bg, fl: term.main.fl }; term.alt = new Screen(term.main.rows, term.main.cols); term.s = term.alt; }
            else if (!on && term.s === term.alt) { term.s = term.main; if (m === 1049 && term.main.saved) restore(term.main); }
          }
        }); break; }
      case 'n': if (p[0] === 6) reply('\x1b[' + (sc.y + 1) + ';' + (sc.x + 1) + 'R'); else if (p[0] === 5) reply('\x1b[0n'); break;
      case 'c': if (!priv) reply('\x1b[?62;22c'); break;        // VT220 with colour
      case 't': break;                                            // window operations: none
      default: break;
    }
  }
  /* The interpreter: a small state machine over the bytes written. */
  function write(text) {
    var sc = term.s;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i], code = text.charCodeAt(i);
      if (term.state === 0) {
        if (code === 0x1b) term.state = 1;
        else if (code === 0x0a || code === 0x0b || code === 0x0c) lineFeed(sc);
        else if (code === 0x0d) { sc.x = 0; sc.wrapNext = false; }
        else if (code === 0x08) { if (sc.x > 0) sc.x--; sc.wrapNext = false; }
        else if (code === 0x09) { sc.x = Math.min(sc.cols - 1, (Math.floor(sc.x / 8) + 1) * 8); sc.wrapNext = false; }
        else if (code === 0x07) { /* bell: nothing to ring */ }
        else if (code < 0x20 || code === 0x7f) { /* other controls: ignored */ }
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { putChar(sc, text.slice(i, i + 2)); i++; }
        else putChar(sc, ch);
      } else if (term.state === 1) {              // after ESC
        if (ch === '[') { term.state = 2; term.params = ''; term.inter = ''; }
        else if (ch === ']') { term.state = 3; term.osc = ''; }
        else if (ch === 'P' || ch === '^' || ch === '_') term.state = 4;       // DCS, PM, APC: skipped to ST
        else if (ch === '(' || ch === ')' || ch === '#' || ch === '%') term.state = 5;
        else {
          term.state = 0;
          if (ch === '7') sc.saved = { x: sc.x, y: sc.y, fg: sc.fg, bg: sc.bg, fl: sc.fl };
          else if (ch === '8') restore(sc);
          else if (ch === 'D') lineFeed(sc); else if (ch === 'E') { sc.x = 0; lineFeed(sc); }
          else if (ch === 'M') { if (sc.y === sc.top) scrollDown(sc, 1); else if (sc.y > 0) sc.y--; }
          else if (ch === 'c') { reset(); sc = term.s; }
        }
      } else if (term.state === 2) {              // CSI
        if (code >= 0x30 && code <= 0x3f) { if (ch === '?' || ch === '>' || ch === '<' || ch === '=') term.inter += ch; else term.params += ch; }
        else if (code >= 0x20 && code <= 0x2f) term.inter += ch;
        else if (code >= 0x40 && code <= 0x7e) { term.state = 0; csi(sc, ch, term.params, term.inter); sc = term.s; }
        else if (code === 0x1b) term.state = 1; else if (code < 0x20) { /* a control inside a sequence */ } else term.state = 0;
      } else if (term.state === 3) {              // OSC ... BEL or ST
        if (code === 0x07) { term.state = 0; osc(term.osc); }
        else if (code === 0x1b) term.state = 6;
        else term.osc += ch;
      } else if (term.state === 4) { if (code === 0x1b) term.state = 7; }
      else if (term.state === 5) term.state = 0;
      else if (term.state === 6) { term.state = 0; if (ch === '\\') osc(term.osc); }
      else if (term.state === 7) { term.state = ch === '\\' ? 0 : 4; }
    }
    term.dirty = true; schedule();
  }
  function osc(text) { var m = /^([02]);(.*)$/.exec(text); if (m) { term.title = m[2]; if (CTX.setTitle) CTX.setTitle(NAME + ' \u2014 ' + m[2]); } }
  function reset() { var z = size(); term.main = new Screen(z.rows, z.cols); term.alt = null; term.s = term.main; term.cursorVisible = true; term.appCursor = false; term.autoWrap = true; term.bracketedPaste = false; term.state = 0; }
  var replyTo = null;                            // where answers to enquiries go: the running program's stdin, if any
  function reply(text) { if (replyTo) replyTo(text); }

  /* ---- drawing */
  function renderRow(row, cursorX) {
    var div = document.createElement('div'), run = '', cls = null; div.className = 'r';
    function flush() { if (run === '') return; var sp = document.createElement('span'); if (cls) sp.className = cls; sp.textContent = run; div.appendChild(sp); run = ''; }
    for (var i = 0; i < row.ch.length; i++) {
      var fg = row.fg[i], bg = row.bg[i], fl = row.fl[i], c = '';
      if (fl & FLAG.R) { var t = fg; fg = bg; bg = t; if (fg < 0) c += ' Rf'; if (bg < 0) c += ' Rb'; }      // reverse video: the colours swapped
      if (fg >= 0) c += fg < 16 ? ' f' + fg : ''; if (bg >= 0) c += bg < 16 ? ' b' + bg : '';
      for (var f in FLAG) if (fl & FLAG[f] && f !== 'R') c += ' ' + f;
      if (i === cursorX) c += ' cur';
      c = c.trim() || null;
      var extra = (fg >= 16 || bg >= 16) ? ('|' + fg + '|' + bg) : '';
      if (c !== cls || extra) { flush(); cls = c; if (extra) { var sp = document.createElement('span'); if (c) sp.className = c; sp.textContent = row.ch[i]; if (fg >= 16) sp.style.color = fg >= 256 ? rgbTable[fg - 256] : cube(fg); if (bg >= 16) sp.style.background = bg >= 256 ? rgbTable[bg - 256] : cube(bg); div.appendChild(sp); cls = null; continue; } }
      run += row.ch[i];
    }
    flush();
    return div;
  }
  function cube(n) { if (n < 232) { n -= 16; var b = n % 6, g = Math.floor(n / 6) % 6, r = Math.floor(n / 36); return 'rgb(' + [r, g, b].map(function (v) { return v ? 55 + v * 40 : 0; }).join(',') + ')'; } var v = 8 + (n - 232) * 10; return 'rgb(' + v + ',' + v + ',' + v + ')'; }
  var frame = 0;
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  function render() {
    frame = 0; if (!term.dirty) return; term.dirty = false;
    var sc = term.s, atBottom = term.stuck;
    grid.textContent = '';
    for (var i = 0; i < sc.rows; i++) grid.appendChild(renderRow(sc.lines[i], term.cursorVisible && i === sc.y ? Math.min(sc.x, sc.cols - 1) : -1));
    if (atBottom) { term.autoScroll = true; T.scrollTop = T.scrollHeight; }
  }
  // Only a scroll the user makes changes whether the view is stuck to the bottom. A programmatic scroll (render's
  // own scroll-to-bottom) and the transient a content append causes -- scrollHeight grows before scrollTop moves,
  // which would otherwise read as "scrolled up" and un-stick the view, so ssh output stopped following -- are ignored.
  T.addEventListener('scroll', function () {
    if (term.autoScroll) { term.autoScroll = false; return; }
    term.stuck = T.scrollHeight - T.scrollTop - T.clientHeight < ROWH;
  });
  function bottom() { term.stuck = true; T.scrollTop = T.scrollHeight; }

  /* ---- what the shell and the commands call */
  function print(parts) {                       // a string (SGR escapes allowed), or an array of [text, class] pairs; one line
    var CLS = { b: '\x1b[1m', m: '\x1b[2m', e: '\x1b[31m', g: '\x1b[32m', q: '\x1b[33m', d: '\x1b[34;1m', p: '\x1b[35m', r: '\x1b[36m', c: '\x1b[7m' };
    var text = typeof parts === 'string' ? parts : parts.map(function (p) { var cls = (p[1] || '').split(' ').map(function (k) { return CLS[k] || ''; }).join(''); return cls + p[0] + (cls ? '\x1b[0m' : ''); }).join('');
    write(text.replace(/\r?\n/g, '\r\n') + '\r\n');
  }
  function err(msg) { print('\x1b[31m' + msg + '\x1b[0m'); }
  function columns() { return term.s.cols; }
  function clearScreen() { write('\x1b[2J\x1b[H'); }

  /* ---- the line editor, drawn on the screen */
  function promptText() { return '\x1b[32m' + (cwd ? cwd.ns.name : '?') + '\x1b[0m:\x1b[34;1m' + (cwd ? pathStr(cwd) : '') + '\x1b[0m $ '; }
  function promptParts() { return [[cwd ? cwd.ns.name : '?', 'g'], [':', ''], [cwd ? pathStr(cwd) : '', 'd'], [' $ ', '']]; }
  var promptRow = -1, promptLen = 0;             // where the prompt line starts, and its visible length
  function drawInput() {
    if (busy || rawMode) return;
    var sc = term.s, plain = (cwd ? cwd.ns.name : '?') + ':' + (cwd ? pathStr(cwd) : '') + ' $ ';
    if (promptRow < 0 || promptRow > sc.y) { if (sc.x > 0) write('\r\n'); promptRow = sc.y; }
    var rowsUsed = Math.floor((plain.length + Math.max(line.length, 1) - 1) / sc.cols);
    write('\x1b[' + (promptRow + 1) + ';1H\x1b[J' + promptText() + line);
    promptRow = term.s.y - Math.floor((plain.length + line.length) / sc.cols) + (line.length && (plain.length + line.length) % sc.cols === 0 ? 1 : 0);
    var pos = plain.length + cur, cy = promptRow + Math.floor(pos / sc.cols), cx = pos % sc.cols;
    write('\x1b[' + (cy + 1) + ';' + (cx + 1) + 'H');
    promptLen = plain.length; void rowsUsed; bottom();
  }
  function endInput() { write('\r\n'); promptRow = -1; }          // the line is taken: output begins on the next row

  /* ---- raw mode: a running program owns the keyboard */
  var rawMode = null;                            // { stdin(text), onResize(rows, cols) }
  function keyToText(ev) {
    var k = ev.key, ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey, alt = ev.altKey && !ev.ctrlKey && !ev.metaKey, app = term.appCursor;
    var arrows = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
    if (arrows[k]) return (app ? '\x1bO' : '\x1b[') + arrows[k];
    var tilde = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
    if (tilde[k]) return '\x1b[' + tilde[k] + '~';
    var fn = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }; if (fn[k]) return '\x1bO' + fn[k];
    if (k === 'Enter') return '\r'; if (k === 'Backspace') return '\x7f'; if (k === 'Tab') return '\t'; if (k === 'Escape') return '\x1b';
    if (k.length === 1) { if (ctrl) { var c = k.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); if (k === ' ') return '\x00'; return null; } return (alt ? '\x1b' : '') + k; }
    return null;
  }

  /* ---- size: on the window, and on the program that owns the terminal */
  function fit() {
    var z = size(); if (!term.main) reset();
    if (z.rows !== term.main.rows || z.cols !== term.main.cols) {
      resizeScreen(term.main, z.rows, z.cols); if (term.alt) resizeScreen(term.alt, z.rows, z.cols);
      if (rawMode && rawMode.onResize) { try { rawMode.onResize(z.rows, z.cols); } catch (e) { /* the program's trouble */ } }
      if (!busy && !rawMode) {
        // Redraw the input where it already sits after the reflow; do NOT reset promptRow to -1, which would make
        // drawInput start a fresh line (writing \r\n) and push the prompt down on every resize. Clamp it to the
        // cursor's current row so the redraw lands in place.
        if (promptRow < 0 || promptRow > term.s.y) promptRow = term.s.y;
        drawInput();
      }
    }
    term.dirty = true; schedule();
  }
  window.addEventListener('resize', fit);
  reset();

  /* ---------------------------------------------------------------- paths */

  function enc(s) { return encodeURIComponent(s); }
  function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function pathStr(loc) {
    if (HOME && loc.ns === HOME.ns && loc.segs.length >= HOME.segs.length && HOME.segs.every(function (s, i) { return loc.segs[i] === s; })) return '~/' + loc.segs.slice(HOME.segs.length).map(function (s) { return s + '/'; }).join('');
    return '/' + loc.segs.map(function (s) { return s + '/'; }).join('');
  }
  function pathStrPlain(loc) { return '/' + loc.segs.map(function (s) { return s + '/'; }).join(''); }
  function dirURL(loc) { return loc.ns.base + loc.segs.map(function (s) { return enc(s) + '/'; }).join(''); }
  function leafURL(loc) { return loc.ns.base + loc.segs.map(enc).join('/'); }
  function findNS(name) { for (var i = 0; i < NS.length; i++) if (NS[i].name === name) return NS[i]; return null; }
  function locOfURL(url) {
    url = String(url).replace(/[?#].*$/, '');
    var best = null; NS.forEach(function (n) { if (url.indexOf(n.base) === 0 && (!best || n.base.length > best.base.length)) best = n; });
    if (!best) return null;
    return { ns: best, segs: url.slice(best.base.length).split('/').filter(Boolean).map(dec) };
  }
  function resolve(arg) {
    var ns = cwd.ns, segs = cwd.segs.slice(), m = /^([^\/:]+):(.*)$/.exec(arg), p = arg;
    if (HOME && (arg === '~' || arg.indexOf('~/') === 0)) { ns = HOME.ns; segs = HOME.segs.slice(); p = arg.slice(2); }      // ~ and ~/... are home; drop "~/"
    else if (m && findNS(m[1])) { ns = findNS(m[1]); segs = []; p = m[2]; }
    else if (p.charAt(0) === '/') segs = [];
    p.split('/').forEach(function (s) {
      if (!s || s === '.') return;
      if (s === '..') segs.pop(); else segs.push(s.replace(/\?$/, ''));       // "?" marks a reference in a listing and is not part of its name
    });
    return { ns: ns, segs: segs, dirHint: /\/$/.test(arg) || !segs.length };
  }
  function show(loc, dir) { return loc.ns.name + ':' + (dir ? pathStr(loc) : '/' + loc.segs.join('/')); }

  /* ---------------------------------------------------------------- CDMI */

  function Fail(status, message, landed) { this.status = status; this.message = message; this.landed = landed || ''; }

  async function cdmi(url, accept, third, body) {
    var method = 'GET', probing = false;
    if (third === true || third === false) probing = !!third;                                    // cdmi(url, accept, probing)
    else if (typeof third === 'string') method = third;                                          // cdmi(url, accept, method, body)
    if (!/^https:/i.test(url)) throw new Fail(0, 'refused: only https: URIs are opened (TLS only)');
    var h = { Accept: accept }; if (body !== undefined) h['Content-Type'] = accept; for (var k in HEADERS) h[k] = HEADERS[k];
    var res;
    try { res = await fetch(url, { method: method, headers: h, body: body, redirect: 'follow', credentials: 'same-origin', cache: 'no-store', signal: abort ? abort.signal : undefined, fvQuiet: !!probing }); }   // fvQuiet: the desktop's log files an expected miss under Debug
    catch (e) { throw new Fail(0, e.name === 'AbortError' ? 'interrupted' : 'network error: ' + e.message); }
    if (!res.ok) {
      var msg = res.status + ' ' + (res.statusText || ''), body = null;
      try { body = await res.json(); } catch (e) { /* no problem details */ }
      if (body && (body.title || body.detail)) msg = res.status + ' ' + [body.title, body.detail].filter(Boolean).join(': ');
      throw new Fail(res.status, msg.trim(), (res.url || '').replace(/[?#].*$/, ''));
    }
    if (res.url && !/^https:/i.test(res.url)) throw new Fail(0, 'refused: redirected to a URI that is not https:');
    var ct = (res.headers.get('content-type') || '').toLowerCase(), got = { url: (res.url || url).replace(/[?#].*$/, ''), type: ct };
    if (/^application\/(cdmi-|json)/.test(ct)) got.rep = await res.json();
    else { got.rep = { objectType: 'application/cdmi-object', mimetype: ct.split(';')[0] }; got.bytes = new Uint8Array(await res.arrayBuffer()); }
    return got;
  }

  function kindOf(name, type) { return /\?$/.test(name) ? 'r' : /\/$/.test(name) ? 'd' : type === T_QUEUE ? 'q' : 'o'; }

  /* Children of a container as [{name, kind, type, id, size}]. Tries an extended child listing first. */
  async function readDir(loc, detailed) {
    var url = dirURL(loc), got, kids;
    if (extendedOK[loc.ns.base] !== false) {
      try {
        got = await cdmi(url + '?objectType&objectName&childrenrange&children&childfields=objectType;objectName' + (detailed ? ';objectID;metadata' : ''), ACCEPT_DIR, true);
        kids = (got.rep.children || []).filter(function (c) { return Array.isArray(c) && typeof c[1] === 'string'; }).map(function (c) {
          return { name: c[1], type: c[0], kind: kindOf(c[1], c[0]), id: c[2] || '', size: c[3] && c[3].cdmi_size !== undefined ? String(c[3].cdmi_size) : '' };
        });
      } catch (e) { if (e.status !== 400 && e.status !== 501) throw e; if (e.status === 400) extendedOK[loc.ns.base] = false; }      // 501: this object does not offer it (a capability object); 400: the server does not
    }
    if (!kids) {
      got = await cdmi(url, ACCEPT_DIR);
      kids = (got.rep.children || []).filter(function (c) { return typeof c === 'string'; }).map(function (c) { return { name: c, type: null, kind: kindOf(c, null), id: '', size: '' }; });
    }
    if (got.rep.objectType && !/cdmi-(container|capability|domain)/.test(got.rep.objectType)) throw new Fail(0, 'not a container');
    return { kids: kids, rep: got.rep, url: got.url };
  }

  function leaf(url, query) { return cdmi(url + (query || ''), ACCEPT_LEAF, true); }

  /* Where does this path lead, and is it a container? Follows references and path-form redirects. */
  async function locate(loc) {
    if (loc.dirHint) return { loc: loc, dir: true };
    try {
      var got = await leaf(leafURL(loc), '?objectType&objectName'), there = locOfURL(got.url);
      return { loc: there || loc, dir: /cdmi-(container|capability|domain)/.test(got.rep.objectType || ''), outside: there ? null : got.url };
    } catch (e) {
      if (e.status !== 404 && e.status !== 406) throw e;
      await cdmi(dirURL(loc) + '?objectType', ACCEPT_DIR);            // throws the 404 the user should see
      return { loc: loc, dir: true };
    }
  }

  function b64(s) { var bin = atob(String(s).replace(/\s+/g, '')), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  async function readValue(loc) {
    var got;
    try { got = await cdmi(leafURL(loc) + VALUE_FIELDS, ACCEPT_LEAF); }
    catch (e) { if (e.status !== 400) throw e; got = await cdmi(leafURL(loc), ACCEPT_LEAF); }      // the value selection does not apply to a queue or a container; read it as it is
    if (/cdmi-(container|capability|domain)/.test(got.rep.objectType || '')) throw new Fail(0, S('isContainer', 'is a container'));
    if (got.rep.value === undefined && !got.bytes && got.rep.objectType !== T_QUEUE && got.url !== leafURL(loc)) got = await cdmi(got.url + VALUE_FIELDS, T_OBJECT);   // a reference: the redirect dropped our selection
    var rep = got.rep;
    if (/cdmi-(container|capability|domain)/.test(rep.objectType || '')) throw new Fail(0, S('isContainer', 'is a container'));
    if (rep.objectType === T_QUEUE) return { text: JSON.stringify(rep, null, 2), rep: rep };
    if (got.bytes) return { bytes: got.bytes, rep: rep };
    if (rep.valuetransferencoding === 'json') return { text: JSON.stringify(rep.value, null, 2), rep: rep };
    if (rep.valuetransferencoding === 'base64') return { bytes: b64(rep.value || ''), rep: rep };
    return { text: rep.value === undefined ? '' : String(rep.value), rep: rep };
  }
  function asText(v) {
    if (v.text !== undefined) return v.text;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(v.bytes); } catch (e) { return null; }
  }
  /* ---------------------------------------------------------------- the shell library

     What a command gets as CDMI_CONTEXT.shell: the helpers above, so that a command is a few lines. Everything
     that takes a path takes it in the shell's form, "[disk:]/container/object", relative to the current
     container. Errors are thrown as Fail { status, message }. */
  function hexdumpLines(bytes, limit) {
    var lines = [], n = Math.min(bytes.length, limit);
    for (var o = 0; o < n; o += 16) {
      var hx = '', as = '';
      for (var i = 0; i < 16; i++) {
        if (o + i < n) { var b = bytes[o + i]; hx += (b < 16 ? '0' : '') + b.toString(16) + ' '; as += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'; } else hx += '   ';
        if (i === 7) hx += ' ';
      }
      lines.push(('0000000' + o.toString(16)).slice(-8) + '  ' + hx + ' |' + as + '|');
    }
    if (bytes.length > n) lines.push('\x1b[2m... ' + (bytes.length - n) + ' more bytes\x1b[0m');
    return lines;
  }
  function opts(args, flags) {          // splits "-l -n 5 path" into {l:true, n:'5', _:[path]}
    var o = { _: [] };
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (/^-[A-Za-z]+$/.test(a) && a !== '-') { for (var j = 1; j < a.length; j++) { var f = a[j]; if (flags[f] === 'value') { o[f] = a.slice(j + 1) || args[++i]; break; } o[f] = true; } }
      else o._.push(a);
    }
    return o;
  }
  var COLOUR = { d: '\x1b[34;1m', r: '\x1b[36m', q: '\x1b[33m', o: '' };
  function columnsOf(names, width) {   // names: [[text, kind]] laid out in columns across the terminal
    if (!names.length) return [];
    var w = Math.max.apply(null, names.map(function (k) { return k[0].length; })) + 2, per = Math.max(1, Math.floor(width / w)), rows = Math.ceil(names.length / per), out = [];
    for (var r = 0; r < rows; r++) {
      var line = '';
      for (var c = 0; c < per; c++) { var k = names[c * rows + r]; if (k) line += COLOUR[k[1] || 'o'] + k[0] + '\x1b[0m' + new Array(w - k[0].length + 1).join(' '); }
      out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }
  /* A socket joined to the terminal: what arrives is written to the screen, what is typed is sent. Returns a promise
     of the close code. opts.crlf sends \r\n for Enter (a line-oriented server), opts.raw sends keys as they are. */
  function pipe(socket, proc, opts) {
    opts = opts || {};
    var dec = new TextDecoder('utf-8'), enc = new TextEncoder();
    return new Promise(function (resolve) {
      socket.onData(function (b) { write(dec.decode(b, { stream: true })); });
      socket.onClose(function (code, reason) { proc.stdin(null); write('\x1b[0m' + (term.s.x ? '\r\n' : '')); resolve(code); });
      proc.stdin(function (t) {
        if (t === '\x03' && !opts.raw) { socket.close(); return; }
        if (!opts.raw) { if (t === '\r') t = opts.crlf ? '\r\n' : '\n'; else if (t === '\x7f') t = '\b'; write(t === '\n' || t === '\r\n' ? '\r\n' : t); }     // local echo for line servers
        socket.write(enc.encode(t)).catch(function () { /* closed */ });
      });
    });
  }
  function shellFor() {
    return {
      pipe: pipe,
      Fail: Fail, cdmi: cdmi, leaf: leaf, readDir: readDir, readValue: readValue, locate: locate, resolve: resolve, asText: asText,
      dirURL: dirURL, leafURL: leafURL, show: show, pathStr: pathStr, locOfURL: locOfURL, findNS: findNS,
      namespaces: function () { return NS.slice(); }, cwd: function () { return { ns: cwd.ns, segs: cwd.segs.slice() }; }, home: function () { return HOME ? { ns: HOME.ns, segs: HOME.segs.slice() } : null; },
      opts: opts, columns: columnsOf, hexdump: hexdumpLines, colour: COLOUR, width: columns, write: write,
      ACCEPT_DIR: ACCEPT_DIR, ACCEPT_LEAF: ACCEPT_LEAF, T_OBJECT: T_OBJECT, T_QUEUE: T_QUEUE, T_CONTAINER: T_CONTAINER, STAT_FIELDS: STAT_FIELDS, VALUE_FIELDS: VALUE_FIELDS
    };
  }

  /* ---------------------------------------------------------------- commands

     Built in: what changes the shell's own state. Everything else is found in /bin (a text command, run in a
     hidden frame here) or /apps (a GUI application, started in a window by cvwm), on the current disk first. */
  var BUILTIN = {
    cd: { u: S('cdUsage', '[path | -]'), h: S('cdHelp', 'change container; no argument or ~ goes home; follows references; "cd archive:/" changes disk'), run: async function (args) {
      if (args[0] === '-') { if (!prev) throw new Fail(0, S('noPrevContainer', 'no previous container')); var t = cwd; cwd = prev; prev = t; return retitle(); }
      var where = args[0] || (HOME ? '~' : '/');
      var at = await locate(resolve(where));
      if (at.outside) throw new Fail(0, S('outsidePrefix', 'leads outside the mounted namespaces: ') + at.outside);
      if (!at.dir) throw new Fail(0, S('notContainer', 'not a container'));
      await cdmi(dirURL(at.loc) + '?objectType', ACCEPT_DIR);
      prev = cwd; cwd = { ns: at.loc.ns, segs: at.loc.segs }; retitle();
      void where;
    } },
    help: { h: S('helpHelp', 'the built-in commands, and what /bin and /apps hold'), run: async function () {
      print(S('helpIntro', 'Walk CDMI namespaces. Paths are \x1b[1m[disk:]/container/object\x1b[0m; a trailing / means a container.'));
      print('\x1b[1m' + S('helpBuiltIn', 'Built in') + '\x1b[0m');
      Object.keys(BUILTIN).forEach(function (n) { print('  \x1b[1m' + (n + ' ' + (BUILTIN[n].u || '') + '                        ').slice(0, 26) + '\x1b[0m' + BUILTIN[n].h); });
      var found = await commandTable();
      [['bin', S('helpBin', 'Commands in /bin')], ['tests', S('helpTests', 'Test commands in /dev/tests')], ['apps', S('helpApps', 'Applications in /apps')]].forEach(function (kd) {
        var names = Object.keys(found).filter(function (n) { return found[n].kind === kd[0]; }).sort();
        print('\x1b[1m' + kd[1] + '\x1b[0m' + (names.length ? '' : S('helpNone', '  (none on any disk)')));
        columnsOf(names.map(function (n) { return [n, kd[0] === 'apps' ? 'q' : 'o']; }), columns()).forEach(function (l) { print('  ' + l); });
      });
      print('\x1b[2m' + S('helpBackground', 'An application started here keeps the prompt until its window closes; end the name with & to get the prompt back at once, or press Ctrl-C.') + '\x1b[0m');
      print('\x1b[2m' + S('helpKeys', 'Keys: Tab completes, Up/Down history, Ctrl-C interrupts, Ctrl-L clears, Ctrl-A/E/U/K/W edit. A command takes --help.') + '\x1b[0m');
    } },
    history: { h: S('historyHelp', 'commands entered so far'), run: async function () { history.forEach(function (l, i) { print('\x1b[2m' + ('    ' + (i + 1)).slice(-4) + '  \x1b[0m' + l); }); } },
    clear: { h: S('clearHelp', 'clear the screen'), run: async function () { clearScreen(); } },
    exit: { h: S('exitHelp', 'close this window'), run: async function () { if (CTX.close) CTX.close(); else print(S('noWindow', 'There is no window to close.')); } }
  };

  /* The names in /bin and /apps on every disk, read once and kept until "rehash" or a cd to another disk. */
  var table = null;
  var serverNS = null;                 // same-origin namespaces the discovery tree advertises, memoized for the fallback
  /* Where each kind of command lives on a disk: /bin, /apps, and /dev/tests. */
  var LOCATIONS = [['bin', ['bin']], ['apps', ['apps']], ['tests', ['dev', 'tests']]];
  async function serverNamespaces() { if (!serverNS) { try { serverNS = await discover(); } catch (e) { serverNS = []; } } return serverNS; }
  async function commandTable() {
    if (table) return table;
    var found = {}, gotKind = {};
    // Read one location (/bin, /apps, /dev/tests) on one namespace, adding each sub-container as a command. The first
    // disk to offer a name wins, so a command on a mounted disk shadows the same name elsewhere.
    async function scan(ns, kind, segs) {
      try {
        (await readDir({ ns: ns, segs: segs }, false)).kids.forEach(function (c) {
          var nm = c.name.replace(/\/$/, '');
          if (c.kind === 'd' && !found[nm]) { found[nm] = { kind: kind, url: ns.base + segs.map(function (x) { return x + '/'; }).join('') + enc(nm) + '/', ns: ns, segs: segs.concat(nm) }; gotKind[kind] = true; }
        });
      } catch (e) { /* no such container on this namespace */ }
    }
    // First the mounted disks (the current disk, then the others): a home that carries /bin or /apps is used as-is.
    var order = [cwd.ns].concat(NS.filter(function (n) { return n !== cwd.ns; }));
    for (var i = 0; i < order.length; i++) for (var k = 0; k < LOCATIONS.length; k++) await scan(order[i], LOCATIONS[k][0], LOCATIONS[k][1]);
    // Then fall back to the store root for any location the mounted disks did not provide: the same-origin namespaces
    // the server advertises that are not already mounted (the store holds the installed /bin, /apps and /dev/tests). So
    // a shell on a home with no /bin still finds the commands, while a home that does carry them keeps its own.
    var missing = LOCATIONS.filter(function (L) { return !gotKind[L[0]]; });
    if (missing.length) {
      var mounted = {}; order.forEach(function (n) { mounted[n.base] = 1; });
      var roots = (await serverNamespaces()).filter(function (n) { return n.base && !mounted[n.base]; });
      for (var r = 0; r < roots.length; r++) for (var m = 0; m < missing.length; m++) await scan({ name: roots[r].name, base: roots[r].base }, missing[m][0], missing[m][1]);
    }
    // Applications may be grouped in a sub-folder of /apps (e.g. /apps/cdmi/): a container there that holds no
    // index.js is such a folder, not an application. Drop it as a command and add the applications it holds, one
    // level down, under their own names, so "queues" still runs though it lives in /apps/cdmi/queues/.
    var groups = Object.keys(found).filter(function (nm) { return found[nm].kind === 'apps'; });
    for (var g = 0; g < groups.length; g++) {
      var e = found[groups[g]], kids;
      try { kids = (await readDir({ ns: e.ns, segs: e.segs }, false)).kids; } catch (x) { continue; }
      if (kids.some(function (c) { return c.name.replace(/\/$/, '') === 'index.js'; })) continue;   // a real application
      delete found[groups[g]];
      kids.forEach(function (c) { var sn = c.name.replace(/\/$/, ''); if (c.kind === 'd' && !found[sn]) found[sn] = { kind: 'apps', url: e.url + enc(sn) + '/' }; });
    }
    return (table = found);
  }
  BUILTIN.rehash = { h: 'read /bin, /apps and /dev/tests again', run: async function () { table = null; serverNS = null; await commandTable(); } };

  var running = null;                  // the frame of the command now running, so that Ctrl-C can end it
  function processFor(argv, done) {
    return {
      argv: argv, cwd: dirURL(cwd), shell: shellFor(),
      stdout: function (text) { print(String(text).replace(/\n$/, '')); },
      stderr: function (text) { print('\x1b[31m' + String(text).replace(/\n$/, '') + '\x1b[0m'); },
      /* For a program that runs the terminal itself: write() puts bytes on the screen as they are (no newline
         translation), stdin(fn) takes the keyboard over (fn gets what a terminal would send: characters, ^C as
         \x03, arrows as ESC[A...), tty says the size and reports changes to it. Released when the command exits. */
      write: function (text) { write(String(text)); },
      stdin: function (fn) { rawMode = fn ? Object.assign({}, rawMode || {}, { stdin: fn }) : null; replyTo = fn || null; if (fn) term.cursorVisible = true; },
      tty: { rows: function () { return term.s.rows; }, cols: function () { return term.s.cols; }, onResize: function (fn) { rawMode = Object.assign({}, rawMode || {}, { onResize: fn }); },
        title: function (t) { osc('0;' + t); }, bell: function () { /* nothing rings */ } },
      onExit: done
    };
  }

  /* A text command: its index.js run in a hidden frame of this document, with the process context. Ends when it
     calls exit(), or throws before it has started, or is interrupted. */
  function runText(url, argv, found) {
    return new Promise(async function (resolve) {
      var v;
      // Read index.js from the command's own namespace. A command found on the store-root fallback is not on a mounted
      // disk, so locOfURL (which knows only mounted disks) cannot place its URL; the found entry carries ns and segs, so
      // build the object loc from those, falling back to locOfURL only where an entry lacks them.
      var loc = (found && found.ns && found.segs) ? { ns: found.ns, segs: found.segs.concat('index.js') }
        : (locOfURL(url + 'index.js') || { ns: cwd.ns, segs: ['index.js'] });
      try { v = await readValue(loc); }
      catch (e) { print('\x1b[31m' + argv[0] + ': cannot read ' + url + 'index.js: ' + e.message + '\x1b[0m'); return resolve(127); }
      var source = asText(v); if (source === null) { print('\x1b[31m' + argv[0] + ': index.js is not text\x1b[0m'); return resolve(126); }
      var frame = document.createElement('iframe'), finished = false, D = CTX.desktop;
      frame.style.display = 'none'; frame.setAttribute('aria-hidden', 'true');
      var proc = processFor(argv, function (code) { if (finished) return; finished = true; frame.remove(); running = null; rawMode = null; replyTo = null; if (term.s === term.alt) write('\x1b[?1049l'); write('\x1b[0m'); resolve(code); });
      var blob = URL.createObjectURL(new Blob([source + '\n//# sourceURL=' + url + 'index.js'], { type: 'text/javascript' }));
      window.__cvwmProcess = Object.assign({}, proc, { exit: proc.onExit, mockFetch: CTX.mock ? window.fetch : null, desktop: D, net: CTX.net || null, headers: HEADERS, origin: ORIGIN, namespaces: NS.map(function (n) { return { name: n.name, baseURI: n.base }; }), baseURI: cwd.ns.base, diskName: cwd.ns.name, containerURI: url });
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><base href="' + url.replace(/"/g, '%22') + '"><script>(function(){var p=parent.__cvwmProcess;delete parent.__cvwmProcess;' +
        'if(p.mockFetch)window.fetch=p.mockFetch;if(p.desktop)p.desktop.capture(window,"' + argv[0].replace(/[^\w.-]/g, '') + '");var c={};for(var k in p)if(k!=="mockFetch"&&k!=="onExit")c[k]=p[k];window.CDMI_CONTEXT=c;' +
        'window.addEventListener("error",function(e){p.stderr(String(e.message||e.error));p.exit(1)});window.addEventListener("unhandledrejection",function(e){p.stderr(String(e.reason&&e.reason.message||e.reason));p.exit(1)});})();<\/script></head><body><script src="' + blob + '"><\/script></body></html>';
      running = { frame: frame, end: function () { proc.onExit(130); } };
      document.body.appendChild(frame);
      frame.addEventListener('load', function () { URL.revokeObjectURL(blob); });
    });
  }

  /* A GUI application: started by cvwm in a window; its exit code arrives when the window closes. */
  function runApp(url, argv) {
    return new Promise(async function (finish) {
      if (!CTX.desktop || !CTX.desktop.launch) { print('\x1b[31m' + argv[0] + ': is an application, and there is no desktop to open it on\x1b[0m'); return finish(126); }
      var start = null;
      if (argv[1]) { try { var at = await locate(resolve(argv[1])); start = at.outside || (at.dir ? dirURL(at.loc) : leafURL(at.loc)); } catch (e) { print('\x1b[31m' + argv[0] + ': ' + argv[1] + ': ' + e.message + '\x1b[0m'); return finish(1); } }
      var proc = processFor(argv, function (code) { rawMode = null; replyTo = null; finish(code); });
      proc.start = start;
      var w = await CTX.desktop.launch(url, proc);
      if (!w) finish(1); else { running = { frame: null, end: function () { print('\x1b[2m(' + argv[0] + ' is running in its window)\x1b[0m'); finish(0); } }; }
    });
  }

  async function run(argv) {
    var name = argv[0];
    if (BUILTIN[name]) return BUILTIN[name].run(argv.slice(1)).then(function () { return 0; });
    var found = (await commandTable())[name];
    if (!found) throw new Fail(0, S('commandNotFound', 'command not found (try help)'));
    return found.kind === 'apps' ? runApp(found.url, argv) : runText(found.url, argv, found);
  }

  function retitle() { dirCache = {}; table = null; if (CTX.setTitle) CTX.setTitle(NAME + ' \u2014 ' + show(cwd, true)); }

  function tokenize(s) {
    var toks = [], re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:\\.|[^\s"'])+)/g, m;
    while ((m = re.exec(s))) toks.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3].replace(/\\(.)/g, '$1'));
    return toks;
  }

  var lastStatus = 0, jobs = 0;
  async function execute(text) {
    endInput();
    var toks = tokenize(text); if (!toks.length) return;
    if (history[history.length - 1] !== text) { history.push(text); if (history.length > HISTMAX) history.splice(0, history.length - HISTMAX); saveHistory(); }
    var background = toks.length > 1 && toks[toks.length - 1] === '&'; if (background) toks.pop();      // "xclock &": the prompt comes back at once
    if (background) {
      var job = ++jobs; print('\x1b[2m[' + job + '] ' + toks[0] + '\x1b[0m');
      run(toks).then(function (code) { print('\x1b[2m[' + job + '] done: ' + toks[0] + (code ? ' (exit ' + code + ')' : '') + '\x1b[0m'); drawInput(); }, function (e) { err(toks[0] + ': ' + (e.message || e)); drawInput(); });
      return;
    }
    busy = true; abort = new AbortController(); drawInput();
    try { lastStatus = await run(toks); if (lastStatus) print('\x1b[2m(exit ' + lastStatus + ')\x1b[0m'); }
    catch (e) { err(toks[0] + ': ' + (toks.length > 1 && e instanceof Fail && e.status ? toks[toks.length - 1] + ': ' : '') + (e.message || e)); if (!(e instanceof Fail)) console.error(e); lastStatus = 1; }
    busy = false; abort = null; running = null;
  }

  /* ---------------------------------------------------------------- completion */

  async function complete() {
    var head = line.slice(0, cur), m = /(?:^|\s)((?:\\.|\S)*)$/.exec(head), word = m ? m[1] : '', first = !/\s/.test(head.replace(/^\s+/, ''));
    var plain = word.replace(/\\(.)/g, '$1'), names;
    if (first) { var all = Object.keys(BUILTIN).concat(Object.keys(await commandTable())); names = all.filter(function (c, i) { return c.indexOf(plain) === 0 && all.indexOf(c) === i; }).map(function (c) { return c + ' '; }); }
    else {
      var cut = plain.lastIndexOf('/') + 1, dirPart = plain.slice(0, cut), stem = plain.slice(cut);
      if (!cut && /^[^\/:]+:/.test(plain) && findNS(plain.split(':')[0])) { dirPart = plain.split(':')[0] + ':/'; stem = plain.slice(plain.indexOf(':') + 1); }
      if (!cut && !/:/.test(plain)) NS.forEach(function (n) { if (stem && (n.name + ':/').indexOf(stem) === 0) (names = names || []).push(n.name + ':/'); });
      var loc = resolve(dirPart || '.'), key = dirURL(loc);
      try { var kids = dirCache[key] || (dirCache[key] = (await readDir(loc, false)).kids); names = (names || []).concat(kids.filter(function (k) { return k.name.indexOf(stem) === 0; }).map(function (k) { return dirPart + k.name.replace(/\?$/, '') + (k.kind === 'd' ? '' : ' '); })); }
      catch (e) { names = names || []; }
    }
    if (!names.length) return;
    var common = names[0]; names.forEach(function (n) { while (n.indexOf(common) !== 0) common = common.slice(0, -1); });
    if (names.length > 1) common = common.replace(/ $/, '');
    if (common.length > plain.length || names.length === 1) {
      var esc = common.replace(/([\s"'\\])(?!$)/g, '\\$1');
      line = head.slice(0, head.length - word.length) + esc + line.slice(cur); cur = head.length - word.length + esc.length;
    } else { endInput(); columnsOf(names.map(function (n) { var s = n.trim().slice(n.trim().replace(/\/$/, '').lastIndexOf('/') + 1); return [s, /\/$/.test(s) ? 'd' : 'o']; }), columns()).forEach(function (l) { print(l); }); }
  }

  /* ---------------------------------------------------------------- keyboard */

  function insert(s) { s = s.replace(/[\r\n]+/g, ' '); line = line.slice(0, cur) + s + line.slice(cur); cur += s.length; }

  document.addEventListener('keydown', async function (ev) {
    var k = ev.key, ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
    if (rawMode && rawMode.stdin) {                                            // the running program has the keyboard
      if (ev.metaKey || (ctrl && (k === 'v' || k === 'V'))) return;            // paste stays with the browser
      var t = keyToText(ev); if (t === null) return;
      ev.preventDefault(); try { rawMode.stdin(t); } catch (e) { console.error(e); } bottom(); return;
    }
    if (ctrl && k.toLowerCase() === 'c' && !String(getSelection())) { ev.preventDefault(); if (busy && running) running.end(); if (busy && abort) abort.abort(); if (!busy) { write(line.slice(cur) + '^C\r\n'); promptRow = -1; line = ''; cur = 0; drawInput(); } return; }
    if (busy || ev.metaKey || (ev.altKey && k.length === 1)) return;
    var handled = true;
    if (ctrl) {
      var c = k.toLowerCase();
      if (c === 'a') cur = 0; else if (c === 'e') cur = line.length; else if (c === 'u') { line = line.slice(cur); cur = 0; }
      else if (c === 'k') line = line.slice(0, cur); else if (c === 'l') { clearScreen(); promptRow = -1; }
      else if (c === 'w') { var left = line.slice(0, cur).replace(/\S+\s*$/, ''); line = left + line.slice(cur); cur = left.length; }
      else handled = false;
    } else if (k === 'Enter') { var text = line; line = ''; cur = 0; histPos = -1; await execute(text.trim()); histPos = history.length; }
    else if (k === 'Backspace') { if (cur) { line = line.slice(0, cur - 1) + line.slice(cur); cur--; } }
    else if (k === 'Delete') line = line.slice(0, cur) + line.slice(cur + 1);
    else if (k === 'ArrowLeft') cur = Math.max(0, cur - 1);
    else if (k === 'ArrowRight') cur = Math.min(line.length, cur + 1);
    else if (k === 'Home') cur = 0; else if (k === 'End') cur = line.length;
    else if (k === 'ArrowUp') { if (histPos === history.length) stash = line; if (histPos > 0) { line = history[--histPos]; cur = line.length; } }
    else if (k === 'ArrowDown') { if (histPos < history.length) { histPos++; line = histPos === history.length ? stash : history[histPos]; cur = line.length; } }
    else if (k === 'Tab') { ev.preventDefault(); busy = true; try { await complete(); } finally { busy = false; } }
    else if (k.length === 1) insert(k);
    else handled = false;
    if (handled) { ev.preventDefault(); drawInput(); }
  });
  document.addEventListener('paste', function (ev) {
    var text = (ev.clipboardData || window.clipboardData).getData('text'); ev.preventDefault();
    if (rawMode && rawMode.stdin) { rawMode.stdin(term.bracketedPaste ? '\x1b[200~' + text + '\x1b[201~' : text); return; }
    if (busy) return; insert(text); drawInput();
  });
  T.addEventListener('mouseup', function () { if (!String(getSelection())) T.focus(); });
  T.addEventListener('focus', function () { T.classList.add('focus'); }); T.addEventListener('blur', function () { T.classList.remove('focus'); });

  /* ---------------------------------------------------------------- start */

  async function discover() {
    var tree = ORIGIN + '/.well-known/cdmi/cdmi_namespaces/', found = [];
    try {
      var names = ((await cdmi(tree, T_CONTAINER)).rep.children || []).filter(function (c) { return typeof c === 'string'; });
      for (var i = 0; i < names.length; i++) {
        var name = names[i].replace(/[\/?]$/, '');
        try { var got = await cdmi(tree + enc(name), T_CONTAINER); if (/\/$/.test(got.url) && got.url.indexOf(ORIGIN + '/') === 0 && got.url !== tree + enc(name)) found.push({ name: name, base: got.url }); } catch (e) { /* not readable by us */ }
      }
    } catch (e) { /* no discovery tree */ }
    return found;
  }

  /* Files dropped on this window are uploaded by the desktop into the container we are in. */
  CTX.dropTarget = function () { return cwd ? dirURL(cwd) : null; };
  CTX.onUpload = function (results, to) {
    var there = locOfURL(to); dirCache = {};
    results.forEach(function (r) { print([[r.outcome + '  ', /^(created|replaced)$/.test(r.outcome) ? 'g' : 'e'], [(there ? show(there, true) : to) + r.name, ''], ['  ' + r.size + ' bytes', 'm']]); });
    drawInput();
  };

  /* ~/.history: read once at start (merged ahead of this window's own lines), and written back, debounced, as
     commands are entered. A data object of one command a line. Absent a home, none of this runs. */
  async function loadHistory() {
    if (!HOME) return;
    histFile = { ns: HOME.ns, segs: HOME.segs.concat('.history') };
    try {
      var v = await readValue(histFile), text = asText(v);
      if (text !== null) { var lines = text.split('\n').filter(function (l) { return l.length; }); histSaved = lines.join('\n'); history = lines.concat(history.filter(function (l) { return lines.indexOf(l) < 0; })); if (history.length > HISTMAX) history.splice(0, history.length - HISTMAX); }
    } catch (e) { if (!(e instanceof Fail) || (e.status !== 404 && e.status !== 406)) print('\x1b[2mxterm: could not read ~/.history: ' + (e.message || e) + '\x1b[0m'); }   // a first-time home has none; anything else is worth a line
    histPos = history.length;
  }
  function saveHistory() {
    if (!histFile) return;
    histDirty = true; clearTimeout(histTimer);
    histTimer = setTimeout(function () { writeHistory().catch(function () {}); }, 1500);           // one write for a burst
  }
  async function writeHistory() {
    if (!histFile || !histDirty) return;
    var text = history.join('\n') + '\n'; if (text === histSaved + '\n') { histDirty = false; return; }
    try {
      var res = await cdmi(leafURL(histFile) + '?value', T_OBJECT, 'PUT', JSON.stringify({ valuetransferencoding: 'utf-8', value: text }));
      if (!res.ok) {                                                                              // first time: create it
        res = await cdmi(leafURL(histFile), T_OBJECT, 'PUT', JSON.stringify({ mimetype: 'text/plain', metadata: {}, valuetransferencoding: 'utf-8', value: text }));
      }
      if (res.ok) { histSaved = history.join('\n'); histDirty = false; }
    } catch (e) { /* keep it in memory; try again on the next command */ }
  }
  window.addEventListener('pagehide', function () { if (histDirty && histFile) { navigator.sendBeacon && void 0; writeHistory(); } });

  (async function start() {
    busy = true;
    NS = (CTX.namespaces || []).map(function (n) { return { name: n.name, base: n.baseURI }; });
    if (!NS.length) NS = await discover();
    if (CTX.homeURI) { var hl = locOfURL(CTX.homeURI); if (hl) HOME = hl; }
    if (!NS.length) NS = [{ name: CTX.diskName || 'cdmi', base: CTX.baseURI || new URL('..', document.baseURI).href }];
    var start = (CTX.startURI && locOfURL(CTX.startURI)) || HOME || (CTX.baseURI && locOfURL(CTX.baseURI)) || { ns: NS[0], segs: [] };
    cwd = { ns: start.ns, segs: start.segs.slice() }; histPos = 0;
    await loadHistory();
    fit(); print([['CDMI xterm \u2014 type ', 'm'], ['help', 'b'], [' for commands. Disks: ' + NS.map(function (n) { return n.name + ':'; }).join(' '), 'm']]);
    retitle(); busy = false; drawInput(); T.focus();
  })();
})();
