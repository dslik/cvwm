/*!
 * xclock for cvwm, after the X11 program: a plain analogue face that fills its window, redrawn to fit
 * whenever the window is resized. Store this file as "index.js" in a container (for example /xclock/), with
 * index.png beside it, and open it.
 *
 * Click the face, or press D, for the digital form (xclock -digital); S shows or hides the second hand
 * (xclock -update 1 against the default of a minute); C chimes on the hour when on, as -chime did, with a
 * short tone made on the spot. The choices are kept for next time.
 */
(function () {
  'use strict';

  var CTX = window.CDMI_CONTEXT || {};
  // Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
  // built-in default. S() reads a string; the stylesheet and the day/month name tables are pulled where present.
  var R = CTX.rsrc || null;
  function S(id, fb) { var v = R && R.text('strings', id); return v == null ? fb : v; }
  var opts = { digital: false, seconds: true, chime: false };
  try { opts = Object.assign(opts, JSON.parse(localStorage.getItem('xclock') || '{}')); } catch (e) { /* no storage; the defaults stand */ }
  function keep() { try { localStorage.setItem('xclock', JSON.stringify(opts)); } catch (e) { /* the choice lasts for this window */ } }

  var style = document.createElement('style');
  var DEFAULT_CSS =
    'html,body{margin:0;height:100%;background:#fff;overflow:hidden;cursor:default;user-select:none;-webkit-user-select:none}' +
    'body{display:flex;align-items:center;justify-content:center}' +
    'svg{width:100%;height:100%;display:block}' +
    '#digital{display:none;font:700 18px/1.2 "DejaVu Sans Mono","Liberation Mono",Menlo,Consolas,monospace;color:#000;text-align:center;padding:6px;white-space:nowrap}' +
    'body.digital svg{display:none}body.digital #digital{display:block}' +
    '#hint{position:fixed;left:0;right:0;bottom:3px;text-align:center;font:11px Helvetica,Arial,sans-serif;color:#555;opacity:0;transition:opacity .3s;pointer-events:none}body:hover #hint{opacity:1}' +
    '@media (prefers-reduced-motion:reduce){#hint{transition:none}}';
  style.textContent = (R && R.text('styles', 'xclock')) || DEFAULT_CSS;
  document.head.appendChild(style);

  var NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) { var e = document.createElementNS(NS, name); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }

  /* The face: a tick at every minute, a longer and heavier one at every five, as xclock draws them. */
  var svg = el('svg', { viewBox: '-100 -100 200 200', role: 'img' }), label = el('title', {});
  svg.appendChild(label);
  for (var i = 0; i < 60; i++) {
    var five = i % 5 === 0, a = i * Math.PI / 30, r1 = five ? 82 : 90, r2 = 96;
    svg.appendChild(el('line', { x1: r1 * Math.sin(a), y1: -r1 * Math.cos(a), x2: r2 * Math.sin(a), y2: -r2 * Math.cos(a), stroke: '#000', 'stroke-width': five ? 2.6 : 1 }));
  }
  /* The hands are the tapered outlines of the original, filled: a kite from the hub to the tip. */
  function hand(length, width, back) { return el('polygon', { points: '0,' + (-length) + ' ' + width + ',0 0,' + back + ' ' + (-width) + ',0', fill: '#000', stroke: '#000', 'stroke-width': 0.6, 'stroke-linejoin': 'round' }); }
  var hour = hand(52, 5.5, 9), minute = hand(80, 4, 9), second = el('line', { x1: 0, y1: 14, x2: 0, y2: -86, stroke: '#c0202c', 'stroke-width': 1.2, 'stroke-linecap': 'round' });
  svg.appendChild(hour); svg.appendChild(minute); svg.appendChild(second); svg.appendChild(el('circle', { r: 2.6, fill: '#000' }));
  var digital = document.createElement('div'); digital.id = 'digital'; digital.setAttribute('role', 'timer');
  var hint = document.createElement('div'); hint.id = 'hint'; hint.textContent = S('hint', 'click or D: digital \u00B7 S: seconds \u00B7 C: chime');
  document.body.appendChild(svg); document.body.appendChild(digital); document.body.appendChild(hint);

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (R) {
    var _d = R.json('data', 'days'); if (Array.isArray(_d) && _d.length === 7) DAYS = _d;
    var _m = R.json('data', 'months'); if (Array.isArray(_m) && _m.length === 12) MONTHS = _m;
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function asText(d) { return DAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + (d.getDate() < 10 ? ' ' : '') + d.getDate() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + (opts.seconds ? ':' + two(d.getSeconds()) : '') + ' ' + d.getFullYear(); }   // the form of ctime(3), which -digital shows

  var lastHour = new Date().getHours(), audio = null, timer = 0;
  function chime(times) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      for (var n = 0; n < times; n++) {
        var o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + n * 0.9;
        o.type = 'sine'; o.frequency.value = 660; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
        o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.85);
      }
    } catch (e) { /* no sound here */ }
  }

  function draw() {
    var d = new Date(), s = d.getSeconds(), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
    hour.setAttribute('transform', 'rotate(' + h * 30 + ')'); minute.setAttribute('transform', 'rotate(' + m * 6 + ')');
    second.setAttribute('transform', 'rotate(' + s * 6 + ')'); second.style.display = opts.seconds ? '' : 'none';
    var text = asText(d); label.textContent = text; digital.textContent = text;
    document.body.classList.toggle('digital', opts.digital);
    if (opts.digital) { var fit = Math.max(10, Math.min(innerWidth / (text.length * 0.64), innerHeight * 0.5)); digital.style.fontSize = fit + 'px'; }   // as large as the window allows
    if (d.getHours() !== lastHour) { lastHour = d.getHours(); if (opts.chime) chime(1); }
    clearTimeout(timer); timer = setTimeout(draw, (opts.seconds ? 1000 : 60000 - s * 1000) - d.getMilliseconds() + 5);          // on the tick, not merely once a second
  }

  function toggle(which) { opts[which] = !opts[which]; keep(); draw(); if (which === 'chime' && opts.chime) chime(1); }
  document.body.addEventListener('click', function () { toggle('digital'); });
  document.addEventListener('keydown', function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var k = ev.key.toLowerCase(); if (k === 'd') toggle('digital'); else if (k === 's') toggle('seconds'); else if (k === 'c') toggle('chime'); else if (k === 'q' && CTX.close) CTX.close();
  });
  window.addEventListener('resize', function () { if (opts.digital) draw(); });

  if (CTX.setTitle) CTX.setTitle(S('title', 'xclock'));
  if (CTX.resize) CTX.resize(260, 290);
  draw();
})();
