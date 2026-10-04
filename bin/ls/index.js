/*! ls [-l] [path...] - list the children of a container (or name an object). A cvwm command: /bin/ls/index.js. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, o = sh.opts(c.argv.slice(1), {});
  if (o.h || o['-help']) { c.stdout('usage: ls [-l] [path...]\n  -l   one child a line, with type, size and object ID'); return c.exit(0); }
  (async function () {
    var targets = o._.length ? o._ : ['.'], code = 0;
    for (var i = 0; i < targets.length; i++) {
      try {
        var at = await sh.locate(sh.resolve(targets[i]));
        if (at.outside) { c.stderr('ls: ' + targets[i] + ': leads outside the mounted namespaces: ' + at.outside); code = 1; continue; }
        if (!at.dir) { c.stdout(at.loc.segs[at.loc.segs.length - 1]); continue; }
        if (targets.length > 1) c.stdout('\x1b[2m' + sh.show(at.loc, true) + ':\x1b[0m');
        var kids = (await sh.readDir(at.loc, !!o.l)).kids;
        if (!o.l) { sh.columns(kids.map(function (k) { return [k.name, k.kind]; }), sh.width()).forEach(c.stdout); continue; }
        var w = Math.max.apply(null, kids.map(function (k) { return k.size.length; }).concat([4])), idw = Math.max.apply(null, kids.map(function (k) { return (k.id || '-').length; }).concat([1]));
        kids.forEach(function (k) {
          var t = k.kind === 'r' ? 'reference' : (k.type || (k.kind === 'd' ? sh.T_CONTAINER : '-')).replace('application/cdmi-', '');
          c.stdout('\x1b[2m' + (t + '          ').slice(0, 11) + '\x1b[0m' + (new Array(w + 1).join(' ') + (k.size || '-')).slice(-w) + '  \x1b[2m' + ((k.id || '-') + new Array(idw + 1).join(' ')).slice(0, idw) + '\x1b[0m  ' + sh.colour[k.kind] + k.name + '\x1b[0m');
        });
      } catch (e) { c.stderr('ls: ' + targets[i] + ': ' + e.message); code = 1; }
    }
    c.exit(code);
  })();
})();
