/*! nc host port [-C] [-r] - a TCP connection through the relay, joined to the terminal: what arrives is shown, what is
    typed is sent. -C sends CRLF for Enter (mail, HTTP and chat servers want it); -r sends keys exactly as typed, no
    local echo. Ctrl-C closes. The smallest program that uses cvwm's net: the same calls an ssh would start with. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, o = sh.opts(c.argv.slice(1), {});
  if (!c.net) { c.stderr('nc: this desktop offers no network'); return c.exit(126); }
  if (o._.length < 2 || o.h) { c.stderr('usage: nc host port [-C] [-r]'); return c.exit(2); }
  (async function () {
    var socket;
    try { socket = await c.net.connect(o._[0], parseInt(o._[1], 10), { baseURI: c.baseURI, protocol: 'raw' }); }
    catch (e) { c.stderr('nc: ' + o._[0] + ':' + o._[1] + ': ' + e.message); return c.exit(e.code === 4403 ? 77 : 1); }
    c.stdout('\x1b[2mconnected to ' + socket.remote + '; Ctrl-C closes\x1b[0m');
    var code = await sh.pipe(socket, c, { crlf: !!o.C, raw: !!o.r });
    c.stdout('\x1b[2mconnection closed (' + socket.stats.sent + ' B out, ' + socket.stats.received + ' B in)\x1b[0m');
    c.exit(code === 1000 ? 0 : 1);
  })();
})();
