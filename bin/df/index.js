/*! df - the mounted namespaces and their base URIs; the current one is marked. A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, ns = sh.namespaces(), here = sh.cwd().ns, w = Math.max.apply(null, ns.map(function (n) { return n.name.length; })) + 2;
  ns.forEach(function (n) { c.stdout('\x1b[32m' + (n === here ? '* ' : '  ') + (n.name + ':' + new Array(w).join(' ')).slice(0, w + 1) + '\x1b[0m' + n.base); });
  c.exit(0);
})();
