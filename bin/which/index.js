/*! which name... - where a command or application would be run from. A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, names = c.argv.slice(1), code = 0;
  if (!names.length) { c.stderr('usage: which name...'); return c.exit(2); }
  (async function () {
    var order = [sh.cwd().ns].concat(sh.namespaces().filter(function (n) { return n !== sh.cwd().ns; }));
    for (var i = 0; i < names.length; i++) {
      var hit = null;
      var where = [[['bin'], ''], [['apps'], '  (application)'], [['dev', 'tests'], '  (test)']];
      for (var j = 0; j < order.length && !hit; j++) for (var k = 0; k < where.length && !hit; k++) {
        var segs = where[k][0].concat(names[i]), loc = { ns: order[j], segs: segs };
        try { await sh.leaf(sh.leafURL({ ns: order[j], segs: segs.concat('index.js') }), '?objectName'); hit = sh.show(loc, true) + where[k][1]; } catch (e) { /* not here */ }
      }
      if (hit) c.stdout(hit); else { c.stderr('which: ' + names[i] + ': not found in /bin, /apps or /dev/tests of any disk'); code = 1; }
    }
    c.exit(code);
  })();
})();
