/*! tree [-L depth] [path] - the containers and objects below a path (default depth 2). A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, o = sh.opts(c.argv.slice(1), { L: 'value' }), max = parseInt(o.L, 10) || 2, count = 0;
  (async function () {
    try {
      var at = await sh.locate(sh.resolve(o._[0] || '.')); if (!at.dir) throw new sh.Fail(0, 'not a container');
      c.stdout(sh.colour.d + sh.show(at.loc, true) + '\x1b[0m');
      async function walk(loc, prefix, depth) {
        var kids = (await sh.readDir(loc, false)).kids, more = Math.max(0, kids.length - 25);
        if (more) kids = kids.slice(0, 25).concat([{ name: '... ' + more + ' more', kind: 'o', note: true }]);
        for (var i = 0; i < kids.length; i++) {
          if (++count > 500) { if (count === 501) c.stdout('\x1b[2m... stopped after 500 entries\x1b[0m'); return; }
          var k = kids[i], last = i === kids.length - 1;
          c.stdout('\x1b[2m' + prefix + (last ? '`-- ' : '|-- ') + '\x1b[0m' + (k.note ? '\x1b[2m' : sh.colour[k.kind]) + k.name + '\x1b[0m');
          if (k.kind === 'd' && depth < max && !/^cdmi_/.test(k.name)) await walk({ ns: loc.ns, segs: loc.segs.concat(k.name.replace(/\/$/, '')) }, prefix + (last ? '    ' : '|   '), depth + 1);
        }
      }
      await walk(at.loc, '', 1); c.exit(0);
    } catch (e) { c.stderr('tree: ' + e.message); c.exit(1); }
  })();
})();
