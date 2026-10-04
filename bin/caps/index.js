/*! caps [path] - the capabilities that apply to an object (its capabilitiesURI is read). A cvwm command. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, arg = c.argv[1] || '.';
  (async function () {
    try {
      var at = await sh.locate(sh.resolve(arg));
      var got = at.dir ? await sh.cdmi(sh.dirURL(at.loc) + '?capabilitiesURI', sh.ACCEPT_DIR) : await sh.leaf(sh.leafURL(at.loc), '?capabilitiesURI'), uri = got.rep.capabilitiesURI;
      if (!uri) throw new sh.Fail(0, 'the object reports no capabilitiesURI');
      c.stdout('\x1b[2m# ' + uri + '\x1b[0m');
      var url = uri.indexOf('/.well-known/') === 0 ? c.origin + uri : at.loc.ns.base + uri.replace(/^\//, '');
      var caps = (await sh.cdmi(url, 'application/cdmi-capability')).rep.capabilities || {};
      Object.keys(caps).sort().forEach(function (k) { c.stdout('  ' + (k + '                                        ').slice(0, Math.max(38, k.length + 3)) + '\x1b[32m' + (typeof caps[k] === 'string' ? caps[k] : JSON.stringify(caps[k])) + '\x1b[0m'); });
      c.exit(0);
    } catch (e) { c.stderr('caps: ' + arg + ': ' + e.message); c.exit(1); }
  })();
})();
