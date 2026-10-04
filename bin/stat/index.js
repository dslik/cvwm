/*! stat [path] - the fields and metadata of an object, without its value. A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, arg = c.argv[1] || '.';
  (async function () {
    try {
      var at = await sh.locate(sh.resolve(arg)), url = at.outside || (at.dir ? sh.dirURL(at.loc) : sh.leafURL(at.loc)), got;
      try { got = at.dir ? await sh.cdmi(url + '?' + sh.STAT_FIELDS, sh.ACCEPT_DIR) : await sh.leaf(url, '?' + sh.STAT_FIELDS); }
      catch (e) { if (e.status !== 400) throw e; got = at.dir ? await sh.cdmi(url, sh.ACCEPT_DIR) : await sh.leaf(url); }
      var rep = got.rep, md = rep.metadata || {}, rows = [['uri', got.url]];
      Object.keys(rep).forEach(function (k) { if (k !== 'value' && k !== 'children' && k !== 'metadata' && k !== 'capabilities') rows.push([k, rep[k]]); });
      Object.keys(md).forEach(function (k) { rows.push(['metadata.' + k, md[k]]); });
      var pad = Math.max.apply(null, rows.map(function (r) { return r[0].length; })) + 2;
      rows.forEach(function (r) { c.stdout('  \x1b[2m' + (r[0] + new Array(pad + 1).join(' ')).slice(0, pad) + '\x1b[0m' + (typeof r[1] === 'string' ? r[1] : JSON.stringify(r[1]))); });
      c.exit(0);
    } catch (e) { c.stderr('stat: ' + arg + ': ' + e.message); c.exit(1); }
  })();
})();
