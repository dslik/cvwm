/*! ssh [-v] [-p port] [-P pipe] [-i keyobject] [user@]host - an SSH-2 client for cvwm, as SSH.md describes it: the
    protocol over a socket from net.connect(), the terminal cvwm already has, keys from net.crypto, trust on first
    use through net.hosts. Version 1: an interactive shell on a PTY, by password, keyboard-interactive or an
    unencrypted openssh-key-v1 key. -v shows the negotiation, -vv traces every message. Inside the session, "~." on a line of its own ends it. */
(function () {
  var c = window.CDMI_CONTEXT, sh = c.shell, net = c.net, B = net && net.bytes, K = net && net.crypto;
  if (!net) { c.stderr('ssh: this desktop offers no network'); return c.exit(126); }
  var o = sh.opts(c.argv.slice(1), { p: 'value', P: 'value', i: 'value', l: 'value' });
  if (!o._.length || o.h) { c.stderr('usage: ssh [-v] [-vv] [-p port] [-P pipe] [-i keyobject] [user@]host'); return c.exit(2); }
  var target = o._[0], m = /^(?:([^@]+)@)?(.+)$/.exec(target), user = m[1] || o.l || 'root', host = m[2], port = parseInt(o.p, 10) || 22;
  // -v shows the negotiation, -vv traces every message. -vv (or -v -v) also traces every protocol message. o.v is true for one -v, or a count.
  var vlevel = o.v === true ? 1 : (typeof o.v === 'number' ? o.v : (Array.isArray(o.v) ? o.v.length : 0));
  if (o.vv) vlevel = Math.max(vlevel, 2);
  function log(t) { if (vlevel >= 1) c.stdout('\x1b[2mssh: ' + t + '\x1b[0m'); }
  function trace(t) { if (vlevel >= 2) c.stdout('\x1b[2mssh2: ' + t + '\x1b[0m'); }
  var MSGNAME = null;   // filled after MSG is defined, for readable traces
  function fail(where, msg) { var e = new Error(msg); e.where = where; return e; }

  /* ---------------------------------------------------------------- RFC 4251 encodings: pack/unpack */
  function pack(fmt) {                    // B byte, b boolean, u uint32, s bytes as string, t text as string, m mpint (BigInt), n name-list
    var parts = [], a = 1;
    for (var i = 0; i < fmt.length; i++) {
      var v = arguments[a++], f = fmt[i];
      if (f === 'B') parts.push(new Uint8Array([v & 255]));
      else if (f === 'b') parts.push(new Uint8Array([v ? 1 : 0]));
      else if (f === 'u') parts.push(B.u32(v >>> 0));
      else if (f === 's') parts.push(B.u32(v.length), v);
      else if (f === 't') { var e = B.encode(v); parts.push(B.u32(e.length), e); }
      else if (f === 'n') { var e2 = B.encode(v.join(',')); parts.push(B.u32(e2.length), e2); }
      else if (f === 'm') parts.push(mpint(v));
      else throw fail('pack', 'unknown format ' + f);
    }
    return B.concat.apply(null, parts);
  }
  function mpint(x) {                     // BigInt >= 0 to the two's-complement form of RFC 4251
    if (x === 0n) return B.u32(0);
    var hex = x.toString(16); if (hex.length % 2) hex = '0' + hex; if (parseInt(hex.slice(0, 2), 16) & 0x80) hex = '00' + hex;
    var b = new Uint8Array(hex.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    return B.concat(B.u32(b.length), b);
  }
  function Unpacker(bytes) { this.b = bytes; this.at = 0; }
  Unpacker.prototype = {
    byte: function () { if (this.at >= this.b.length) throw fail('parse', 'short message'); return this.b[this.at++]; },
    bool: function () { return this.byte() !== 0; },
    u32: function () { if (this.at + 4 > this.b.length) throw fail('parse', 'short message'); var v = B.readU32(this.b, this.at); this.at += 4; return v; },
    str: function () { var n = this.u32(); if (this.at + n > this.b.length) throw fail('parse', 'short message'); var v = this.b.subarray(this.at, this.at + n); this.at += n; return v; },
    text: function () { return B.decode(this.str()); },
    list: function () { var t = this.text(); return t ? t.split(',') : []; },
    mpint: function () { var s = this.str(); return K.bn.fromBE(s); },
    rest: function () { return this.b.subarray(this.at); }
  };
  function bnBE(x) { var hex = x.toString(16); if (hex.length % 2) hex = '0' + hex; return K.bn.toBE(x, hex.length / 2); }

  MSGNAME = {}; var MSG = { DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7, KEXINIT: 20, NEWKEYS: 21, KEXDH_INIT: 30, KEXDH_REPLY: 31, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
    USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_PK_OK: 60, USERAUTH_INFO_REQUEST: 60, USERAUTH_INFO_RESPONSE: 61,
    GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82, CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93, CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95,
    CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98, CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100, PING: 192, PONG: 193 };
  for (var _mk in MSG) MSGNAME[MSG[_mk]] = _mk;

  /* ---------------------------------------------------------------- algorithms (SSH.md section 3) */
  var G14 = BigInt('0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF'), G16 = BigInt('0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D788719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA993B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF');
  var KEX = ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'diffie-hellman-group16-sha512', 'diffie-hellman-group14-sha256'];
  var KEX_EXT = ['ext-info-c', 'kex-strict-c', 'kex-strict-c-v00@openssh.com'];
  var HOSTKEYS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'rsa-sha2-512', 'rsa-sha2-256'];
  var CIPHERS = ['chacha20-poly1305@openssh.com', 'aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-gcm', 'aes128-gcm', 'aes256-ctr', 'aes128-ctr'];
  var MACS = ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'];
  var CIPHER_INFO = { 'chacha20-poly1305@openssh.com': { chacha: 1, key: 64, iv: 0 }, 'aes256-gcm@openssh.com': { aead: 1, key: 32 }, 'aes128-gcm@openssh.com': { aead: 1, key: 16 }, 'aes256-gcm': { aead: 1, key: 32 }, 'aes128-gcm': { aead: 1, key: 16 }, 'aes256-ctr': { key: 32 }, 'aes128-ctr': { key: 16 } };
  var MAC_INFO = { 'hmac-sha2-256-etm@openssh.com': { hash: 'SHA-256', len: 32, etm: 1 }, 'hmac-sha2-512-etm@openssh.com': { hash: 'SHA-512', len: 64, etm: 1 }, 'hmac-sha2-256': { hash: 'SHA-256', len: 32 }, 'hmac-sha2-512': { hash: 'SHA-512', len: 64 } };
  function first(mine, theirs, what) { for (var i = 0; i < mine.length; i++) if (theirs.indexOf(mine[i]) >= 0) return mine[i]; throw fail('key exchange', 'no common ' + what + ' (server offers ' + theirs.join(', ') + ')'); }

  /* ---------------------------------------------------------------- the packet layer (RFC 4253 section 6) */
  function Transport(socket) {
    this.socket = socket; this.reader = net.reader(socket);
    this.seqIn = 0; this.seqOut = 0; this.enc = null; this.dec = null;      // cipher state each way, null before NEWKEYS
    this.strict = false; this.inKex = false; this.sessionId = null; this.bytesIn = 0; this.bytesOut = 0;
  }
  Transport.prototype.send = async function (payload) {
    trace('send ' + (MSGNAME[payload[0]] || ('type ' + payload[0])) + ' (' + payload.length + ' bytes)');
    var st = this.enc, block = st ? 16 : 8, aad = st && (st.aead || st.etm || st.chacha) ? 4 : 0;       // with AEAD, ETM or chacha the length is outside the padded part
    var padLen = block - ((5 + payload.length - aad) % block); if (padLen < 4) padLen += block;
    var body = B.concat(new Uint8Array([padLen]), payload, K.random(padLen)), len = B.u32(body.length), out;
    if (!st) out = B.concat(len, body);
    else if (st.chacha) { var lenC = st.cc.encLength(this.seqOut, len); out = B.concat(lenC, st.cc.seal(this.seqOut, lenC, body)); }
    else if (st.aead) { out = B.concat(len, await st.gcm.seal(st.iv, len, body)); K.gcmNext(st.iv); }
    else if (st.etm) { var ct = await st.ctr.encrypt(body), mac = await K.hmac(st.mac.hash, st.macKey, B.concat(B.u32(this.seqOut), len, ct)); out = B.concat(len, ct, mac.subarray(0, st.mac.len)); }
    else { var ct2 = await st.ctr.encrypt(B.concat(len, body)), mac2 = await K.hmac(st.mac.hash, st.macKey, B.concat(B.u32(this.seqOut), len, body)); out = B.concat(ct2, mac2.subarray(0, st.mac.len)); }
    this.seqOut = (this.seqOut + 1) >>> 0; this.bytesOut += out.length;
    await this.socket.write(out);
  };
  Transport.prototype.recv = async function () {
    var st = this.dec, r = this.reader, body, len;
    if (!st) { var lenB = await r.read(4); len = B.readU32(lenB); if (len > 262144) throw fail('transport', 'packet too long'); body = await r.read(len); }
    else if (st.chacha) { var lenC = await r.read(4), lenP = st.cc.decLength(this.seqIn, lenC); len = B.readU32(lenP); if (len > 262144) throw fail('transport', 'packet too long'); var ctTag = await r.read(len + 16); body = st.cc.open(this.seqIn, lenC, ctTag); if (!body) throw fail('transport', 'message authentication failed'); }
    else if (st.aead) { lenB = await r.read(4); len = B.readU32(lenB); if (len > 262144) throw fail('transport', 'packet too long'); var ct = await r.read(len + 16); body = await st.gcm.open(st.iv, lenB, ct); K.gcmNext(st.iv); if (!body) throw fail('transport', 'message authentication failed'); }
    else if (st.etm) { lenB = await r.read(4); len = B.readU32(lenB); if (len > 262144) throw fail('transport', 'packet too long'); var ct2 = await r.read(len), tag = await r.read(st.mac.len), want = await K.hmac(st.mac.hash, st.macKey, B.concat(B.u32(this.seqIn), lenB, ct2)); if (!same(tag, want.subarray(0, st.mac.len))) throw fail('transport', 'message authentication failed'); body = await st.ctr.decrypt(ct2); }
    else { var firstBlock = await st.ctr.decrypt(await r.read(16)); len = B.readU32(firstBlock); if (len > 262144) throw fail('transport', 'packet too long'); var rest = await st.ctr.decrypt(await r.read(len - 12)), tag2 = await r.read(st.mac.len); body = B.concat(firstBlock.subarray(4), rest); var want2 = await K.hmac(st.mac.hash, st.macKey, B.concat(B.u32(this.seqIn), B.u32(len), body)); if (!same(tag2, want2.subarray(0, st.mac.len))) throw fail('transport', 'message authentication failed'); }
    if (this.strict && this.inKex && this.seqIn === 0xffffffff) throw fail('transport', 'sequence number wrapped during key exchange');
    this.seqIn = (this.seqIn + 1) >>> 0; this.bytesIn += len + 4;
    var padLen = body[0]; if (padLen < 4 || padLen >= body.length) throw fail('transport', 'bad padding');
    return body.subarray(1, body.length - padLen);
  };
  function same(a, b) { if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

  /* Messages the transport answers by itself, whatever layer is waiting: the rest go to the caller. */
  Transport.prototype.next = async function () {
    for (;;) {
      var p = await this.recv(), t = p[0];
      trace('recv ' + (MSGNAME[t] || ('type ' + t)) + ' (' + p.length + ' bytes)');
      if (this.strict && this.inKex && !(t === MSG.KEXINIT || t === MSG.NEWKEYS || (t >= 30 && t <= 49))) throw fail('transport', 'unexpected message ' + t + ' during key exchange (strict kex)');
      if (t === MSG.IGNORE) continue;
      if (t === MSG.DEBUG) { var u = new Unpacker(p.subarray(1)); if (u.bool()) log('debug from server: ' + u.text()); continue; }
      if (t === MSG.PING) { await this.send(B.concat(new Uint8Array([MSG.PONG]), p.subarray(1))); continue; }
      if (t === MSG.UNIMPLEMENTED) { log('server: unimplemented, seq ' + new Unpacker(p.subarray(1)).u32()); continue; }
      if (t === MSG.DISCONNECT) { var d = new Unpacker(p.subarray(1)), code = d.u32(), why = d.text(); throw fail('server', 'disconnected: ' + why + ' (' + code + ')'); }
      if (t === MSG.EXT_INFO) { var x = new Unpacker(p.subarray(1)), n = x.u32(); for (var i = 0; i < n; i++) { var name = x.text(), val = x.str(); if (name === 'server-sig-algs') { this.sigAlgs = B.decode(val).split(','); log('server-sig-algs: ' + this.sigAlgs.join(',')); } } continue; }
      if (t === MSG.KEXINIT && !this.inKex) { log('server asks to re-key'); await this.kex(p); continue; }
      return p;
    }
  };
  Transport.prototype.expect = async function (type) { var p = await this.next(); if (p[0] !== type) throw fail('transport', 'expected message ' + type + ', got ' + p[0]); return p; };

  /* ---------------------------------------------------------------- key exchange (RFC 4253 sections 7-8, 5656, 8731) */
  Transport.prototype.kex = async function (theirs) {
    var tp = this, hashName, hash = function (d) { return K.hash(hashName, d); };
    var mine = pack('B', MSG.KEXINIT), cookie = K.random(16), firstKex = !this.sessionId;
    mine = B.concat(mine, cookie, pack('nnnnnnnnnnbu', KEX.concat(firstKex ? KEX_EXT : []), HOSTKEYS, CIPHERS, CIPHERS, MACS, MACS, ['none'], ['none'], [], [], false, 0));
    this.inKex = true;
    await this.send(mine);
    if (!theirs) theirs = await this.expect(MSG.KEXINIT);
    var u = new Unpacker(theirs.subarray(17)), sKex = u.list(), sHost = u.list(), sC2s = u.list(), sS2c = u.list(), sM2s = u.list(), sMs2c = u.list(); u.list(); u.list(); u.list(); u.list(); var guess = u.bool();
    if (firstKex) {
      if (sKex.indexOf('kex-strict-s') >= 0 || sKex.indexOf('kex-strict-s-v00@openssh.com') >= 0) { this.strict = true; if (this.seqIn !== 1) throw fail('transport', 'the server\'s KEXINIT was not its first message (strict kex)'); }
      this.extInfo = sKex.indexOf('ext-info-s') >= 0;
    }
    var kexAlg = first(KEX, sKex, 'key exchange'), hostAlg = first(HOSTKEYS, sHost, 'host key algorithm'), cAlg = first(CIPHERS, sC2s, 'cipher'), sAlg = first(CIPHERS, sS2c, 'cipher');
    var mAlg = CIPHER_INFO[cAlg].aead ? null : first(MACS, sM2s, 'MAC'), mAlg2 = CIPHER_INFO[sAlg].aead ? null : first(MACS, sMs2c, 'MAC');
    log('kex ' + kexAlg + ', host key ' + hostAlg + ', cipher ' + cAlg + '/' + sAlg + (mAlg ? ', mac ' + mAlg + '/' + mAlg2 : '') + (this.strict ? ', strict kex' : '') + (this.extInfo ? ', ext-info' : ''));
    if (guess) { log('server guessed a first kex packet; discarding it'); await this.recv(); }
    hashName = /sha512/.test(kexAlg) ? 'SHA-512' : /sha384|nistp384/.test(kexAlg) ? 'SHA-384' : 'SHA-256';
    var Kn, hostKeyBlob, sig, exchangeHashParts;
    if (/^curve25519/.test(kexAlg) || /^ecdh/.test(kexAlg)) {
      var pair = /^curve25519/.test(kexAlg) ? await K.x25519() : await K.ecdh(kexAlg === 'ecdh-sha2-nistp256' ? 'P-256' : 'P-384'), qc = await pair.publicKey();
      await this.send(pack('Bs', MSG.KEX_ECDH_INIT, qc));
      var rp = new Unpacker((await this.expect(MSG.KEX_ECDH_REPLY)).subarray(1)); hostKeyBlob = rp.str(); var qs = rp.str(); sig = rp.str();
      var shared = await pair.shared(qs); if (/^curve25519/.test(kexAlg) && !shared.some(function (x) { return x; })) throw fail('key exchange', 'all-zero shared secret');
      Kn = K.bn.fromBE(shared);
      exchangeHashParts = [pack('s', qc), pack('s', qs)];
    } else {
      var P = kexAlg === 'diffie-hellman-group16-sha512' ? G16 : G14, x = K.bn.fromBE(K.random(64)) % (P - 2n) + 1n, e = K.modPow(2n, x, P);
      await this.send(pack('Bm', MSG.KEXDH_INIT, e));
      var dr = new Unpacker((await this.expect(MSG.KEXDH_REPLY)).subarray(1)); hostKeyBlob = dr.str(); var f = dr.mpint(); sig = dr.str();
      if (f <= 1n || f >= P - 1n) throw fail('key exchange', 'the server\'s DH value is out of range');
      Kn = K.modPow(f, x, P);
      exchangeHashParts = [pack('m', e), pack('m', f)];
    }
    var H = await hash(B.concat(pack('tt', this.clientVersion, this.serverVersion), pack('ss', mine, theirs), pack('s', hostKeyBlob), exchangeHashParts[0], exchangeHashParts[1], pack('m', Kn)));
    await this.verifyHostKey(hostAlg, hostKeyBlob, sig, H, firstKex);
    if (!this.sessionId) this.sessionId = H;
    var self = this, Kenc = pack('m', Kn);
    async function derive(letter, need) { var out = await hash(B.concat(Kenc, H, new Uint8Array([letter.charCodeAt(0)]), self.sessionId)); while (out.length < need) out = B.concat(out, await hash(B.concat(Kenc, H, out))); return out.subarray(0, need); }
    async function state(cipher, mac, ivL, keyL, macL) {
      var ci = CIPHER_INFO[cipher], st = { aead: !!ci.aead, chacha: !!ci.chacha };
      if (ci.chacha) { st.cc = K.chachaPoly(await derive(keyL, 64)); }        // no IV, no separate MAC
      else if (ci.aead) { st.gcm = await K.aesGcm(await derive(keyL, ci.key)); st.iv = (await derive(ivL, 12)).slice(); }
      else { st.ctr = await K.aesCtr(await derive(keyL, ci.key), await derive(ivL, 16)); st.mac = MAC_INFO[mac]; st.etm = !!st.mac.etm; st.macKey = await derive(macL, st.mac.len); }
      return st;
    }
    var encNext = await state(cAlg, mAlg, 'A', 'C', 'E'), decNext = await state(sAlg, mAlg2, 'B', 'D', 'F');
    await this.send(pack('B', MSG.NEWKEYS)); this.enc = encNext; if (this.strict) this.seqOut = 0;
    await this.expect(MSG.NEWKEYS); this.dec = decNext; if (this.strict) this.seqIn = 0;
    this.inKex = false; this.bytesIn = this.bytesOut = 0; this.keyedAt = Date.now();
    log('keys in place');
  };

  /* Host keys (RFC 8709, 5656, 8332): the blob parsed by type, the signature over H checked, and the key confirmed by the user. */
  Transport.prototype.verifyHostKey = async function (alg, blob, sigBlob, H, firstKex) {
    var kb = new Unpacker(blob), keyType = kb.text(), sb = new Unpacker(sigBlob), sigType = sb.text(), sigData = sb.str(), ok = false;
    if (keyType === 'ssh-ed25519' && alg === 'ssh-ed25519') { if (sigType !== 'ssh-ed25519') throw fail('host key', 'signature type ' + sigType); ok = await K.ed25519Verify(kb.str(), sigData, H); }
    else if (/^ecdsa-sha2-nistp(256|384)$/.test(keyType) && keyType === alg) {
      var curve = kb.text(), q = kb.str(), s = new Unpacker(sigData), r = s.str(), sv = s.str();
      if (sigType !== keyType || curve !== keyType.slice(11)) throw fail('host key', 'signature type ' + sigType);
      ok = await K.ecdsaVerify(curve === 'nistp256' ? 'P-256' : 'P-384', q, r, sv, H);
    } else if (keyType === 'ssh-rsa' && /^rsa-sha2/.test(alg)) {
      if (sigType !== alg) throw fail('host key', 'signature type ' + sigType + ' where ' + alg + ' was negotiated');
      var e = kb.str(), n = kb.str(); ok = await K.rsaVerify(alg === 'rsa-sha2-512' ? 'SHA-512' : 'SHA-256', e, n, sigData, H);
    } else throw fail('host key', 'the server sent a ' + keyType + ' key where ' + alg + ' was negotiated');
    if (!ok) throw fail('host key', 'the signature on the exchange hash does not verify');
    log('host key ' + keyType + ' ' + (await net.hosts.fingerprint(blob)));
    if (firstKex) { if (!(await net.hosts.confirm(host, port, keyType, blob))) throw fail('host key', 'not accepted'); }
    else { var known = net.hosts.get(host, port); if (known && known.key !== btoa(String.fromCharCode.apply(null, blob))) throw fail('host key', 'changed during re-keying'); }
  };

  /* ---------------------------------------------------------------- authentication (RFC 4252, 4256) */
  async function authenticate(tp) {
    await tp.send(pack('Bt', MSG.SERVICE_REQUEST, 'ssh-userauth')); await tp.expect(MSG.SERVICE_ACCEPT);
    var methods = null, tried = [], key = o.i ? await loadKey(o.i) : null;
    async function attempt(payload) {
      await tp.send(payload);
      for (;;) {
        var p = await tp.next(), t = p[0];
        if (t === MSG.USERAUTH_SUCCESS) return true;
        if (t === MSG.USERAUTH_BANNER) { new Unpacker(p.subarray(1)).text().split('\n').forEach(function (l) { if (l) c.stdout(l); }); continue; }
        if (t === MSG.USERAUTH_FAILURE) { var u = new Unpacker(p.subarray(1)); methods = u.list(); var partial = u.bool(); log('authentication ' + (partial ? 'partial' : 'refused') + '; server allows ' + methods.join(',')); return false; }
        return p;                                                            // something method-specific: the caller looks
      }
    }
    log('trying authentication method none'); var r = await attempt(pack('Bttt', MSG.USERAUTH_REQUEST, user, 'ssh-connection', 'none')); if (r === true) return;
    if (key && methods.indexOf('publickey') >= 0) {
      log('trying publickey (' + (key.type || 'key') + ')');
      tried.push('publickey');
      var sigAlg = key.type === 'ssh-rsa' ? ((tp.sigAlgs || []).indexOf('rsa-sha2-512') >= 0 ? 'rsa-sha2-512' : 'rsa-sha2-256') : key.type;
      r = await attempt(pack('BtttbtS'.replace('S', 's'), MSG.USERAUTH_REQUEST, user, 'ssh-connection', 'publickey', false, sigAlg, key.pub));
      if (r !== false && r !== true && r[0] === MSG.USERAUTH_PK_OK) {
        var toSign = B.concat(pack('s', tp.sessionId), pack('BtttbtS'.replace('S', 's'), MSG.USERAUTH_REQUEST, user, 'ssh-connection', 'publickey', true, sigAlg, key.pub));
        var sig = await key.sign(toSign, sigAlg);
        r = await attempt(B.concat(pack('BtttbtS'.replace('S', 's'), MSG.USERAUTH_REQUEST, user, 'ssh-connection', 'publickey', true, sigAlg, key.pub), pack('s', pack('ts', sigAlg, sig))));
        if (r === true) return;
      }
    }
    for (var n = 0; n < 3; n++) {
      if (methods.indexOf('keyboard-interactive') >= 0) {
        if (tried.indexOf('keyboard-interactive') < 0) tried.push('keyboard-interactive');
        r = await attempt(pack('Bttttt', MSG.USERAUTH_REQUEST, user, 'ssh-connection', 'keyboard-interactive', '', ''));
        while (r !== true && r !== false) {
          if (r[0] !== MSG.USERAUTH_INFO_REQUEST) throw fail('authentication', 'unexpected message ' + r[0]);
          var q = new Unpacker(r.subarray(1)), name = q.text(), instr = q.text(); q.text(); var count = q.u32(), answers = [];
          if (name) c.stdout(name); if (instr) c.stdout(instr);
          for (var i = 0; i < count; i++) { var prompt = q.text(), echo = q.bool(); c.stdout(prompt.replace(/\s+$/, '')); var a = await net.askSecret(prompt, { title: 'ssh ' + user + '@' + host, echo: echo, label: echo ? 'Answer' : 'Secret' }); if (a === null) throw fail('authentication', 'cancelled'); answers.push(a); }
          var resp = pack('Bu', MSG.USERAUTH_INFO_RESPONSE, answers.length); answers.forEach(function (a) { resp = B.concat(resp, pack('t', a)); });
          r = await attempt(resp);
        }
        if (r === true) return;
      } else if (methods.indexOf('password') >= 0) {
        if (tried.indexOf('password') < 0) tried.push('password');
        var pw = await net.askSecret(user + '@' + host + "'s password:", { title: 'ssh ' + user + '@' + host }); if (pw === null) throw fail('authentication', 'cancelled');
        r = await attempt(pack('Btttbt', MSG.USERAUTH_REQUEST, user, 'ssh-connection', 'password', false, pw)); pw = null;
        if (r === true) return;
        if (r !== false) throw fail('authentication', 'the server asked to change the password, which this client does not do');
      } else break;
    }
    throw fail('authentication', 'failed (' + (tried.join(', ') || 'no usable method') + '; the server allows ' + (methods || []).join(', ') + ')');
  }

  /* An unencrypted openssh-key-v1 key from a CDMI object (PROTOCOL.key). */
  async function loadKey(path) {
    var v = await sh.readValue(sh.resolve(path)), text = sh.asText(v); if (text === null) throw fail('key', path + ' is not text');
    var m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text); if (!m) throw fail('key', path + ' is not an openssh-key-v1 key (the only format read)');
    var raw = b64bytes(m[1].replace(/\s+/g, '')), u = new Unpacker(raw.subarray(15));      // after "openssh-key-v1\0"
    var cipher = u.text(), kdf = u.text(), kdfopts = new Unpacker(u.str()); var count = u.u32();
    if (count !== 1) throw fail('key', 'the file holds ' + count + ' keys');
    var pub = u.str(), enc = u.str(), privBytes;
    if (cipher === 'none' && kdf === 'none') privBytes = enc;
    else {
      if (kdf !== 'bcrypt') throw fail('key', 'the key uses the ' + kdf + ' KDF, which this client does not do');
      var salt = kdfopts.str(), rounds = kdfopts.u32(), info = { 'aes256-ctr': { key: 32, iv: 16, ctr: 1 }, 'aes256-cbc': { key: 32, iv: 16 }, 'aes128-ctr': { key: 16, iv: 16, ctr: 1 } }[cipher];
      if (!info) throw fail('key', 'the key is encrypted with ' + cipher + ', which this client does not do');
      var pass = await net.askSecret('Passphrase for ' + path + ':', { title: 'ssh key' }); if (pass === null) throw fail('key', 'cancelled');
      var material = await K.bcryptPbkdf(B.encode(pass), salt, info.key + info.iv, rounds); pass = null;
      var ckey = material.subarray(0, info.key), civ = material.subarray(info.key);
      if (info.ctr) { var dec = await K.aesCtr(ckey, civ); privBytes = await dec.decrypt(enc); }
      else throw fail('key', cipher + ' (CBC) is not implemented; use an aes-ctr key');
    }
    var priv = new Unpacker(privBytes); var c1 = priv.u32(), c2 = priv.u32(); if (c1 !== c2) throw fail('key', 'the passphrase is wrong, or the key is corrupt');
    var type = priv.text(), key = { type: type, pub: pub };
    if (type === 'ssh-ed25519') { priv.str(); var sk = priv.str().subarray(0, 32); key.sign = function (data) { return K.ed25519Sign(sk, data); }; }
    else if (/^ecdsa-sha2-nistp(256|384)$/.test(type)) { var curve = priv.text(), q = priv.str(), d = priv.str(), cv = curve === 'nistp256' ? 'P-256' : 'P-384'; key.sign = async function (data) { var s = await K.ecdsaSign(cv, d, q, data); return pack('mm', K.bn.fromBE(s.r), K.bn.fromBE(s.s)); }; }
    else throw fail('key', type + ' keys are not signed by this client (ssh-ed25519 and ecdsa are)');
    return key;
  }
  function b64bytes(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

  /* ---------------------------------------------------------------- the session (RFC 4254) */
  var TERM_MODES = (function () {                // opcode, value pairs (RFC 4254 section 8, RFC 8160), ended by TTY_OP_END
    var m = [[1, 3], [3, 127], [5, 4], [36, 1], [42, 1], [50, 1], [51, 1], [53, 1], [70, 1], [72, 1], [128, 38400], [129, 38400]], out = [];
    m.forEach(function (p) { out.push(new Uint8Array([p[0]]), B.u32(p[1])); }); out.push(new Uint8Array([0])); return B.concat.apply(null, out);
  })();
  async function session(tp) {
    var local = 0, remote, windowIn = 2 * 1024 * 1024, maxPacket = 32768, windowOut = 0, exitCode = null, closed = false, eof = false, escape = '', consumed = 0, dec = new TextDecoder('utf-8'), pending = [], sending = false, waiters = [];
    log('opening a session channel');
    await tp.send(pack('Btuuu', MSG.CHANNEL_OPEN, 'session', local, windowIn, maxPacket));
    // A server may send a GLOBAL_REQUEST (e.g. hostkeys-00@openssh.com) or a DEBUG/IGNORE message before it
    // confirms the channel; step past those rather than treating them as unexpected. OpenSSH does exactly this.
    var p;
    for (;;) {
      p = await tp.next();
      if (p[0] === MSG.CHANNEL_OPEN_CONFIRMATION) break;
      if (p[0] === MSG.CHANNEL_OPEN_FAILURE) { var f = new Unpacker(p.subarray(5)); throw fail('session', 'channel refused: ' + (f.u32(), f.text())); }
      if (p[0] === MSG.GLOBAL_REQUEST) { var gu = new Unpacker(p.subarray(1)), gn = gu.text(), gwr = gu.bool(); log('global request ' + gn + ' before channel open, ignored'); if (gwr) await tp.send(pack('B', MSG.REQUEST_FAILURE)); continue; }
      if (p[0] === MSG.DEBUG) { var du = new Unpacker(p.subarray(1)); if (du.bool()) log('debug from server: ' + du.text()); continue; }
      if (p[0] === MSG.IGNORE) { log('ignore message before channel open'); continue; }
      throw fail('session', 'unexpected message ' + p[0] + ' while opening the session channel (expected CHANNEL_OPEN_CONFIRMATION)');
    }
    var cf = new Unpacker(p.subarray(1)); cf.u32(); remote = cf.u32(); windowOut = cf.u32(); var remoteMax = cf.u32();
    log('session channel open (remote ' + remote + ', window ' + windowOut + ', max packet ' + remoteMax + ')');
    async function request(name, want, extra) { await tp.send(B.concat(pack('Butb', MSG.CHANNEL_REQUEST, remote, name, want), extra || new Uint8Array(0))); if (!want) return true; var r = await tp.next(); while (r[0] !== MSG.CHANNEL_SUCCESS && r[0] !== MSG.CHANNEL_FAILURE) { await handle(r); r = await tp.next(); } return r[0] === MSG.CHANNEL_SUCCESS; }
    if (!(await request('pty-req', true, pack('tuuuus', 'xterm-256color', c.tty.cols(), c.tty.rows(), 0, 0, TERM_MODES)))) throw fail('session', 'the server refused a PTY');
    if (!(await request('shell', true))) throw fail('session', 'the server refused a shell');
    log('shell open; ~. on a line of its own ends the session');
    async function flush() {
      if (sending) return; sending = true;
      try { while (pending.length && !closed) { var chunk = pending.shift(); while (chunk.length) { if (windowOut <= 0) { await new Promise(function (res) { waiters.push(res); }); continue; } var n = Math.min(chunk.length, windowOut, remoteMax - 64); await tp.send(pack('Bus', MSG.CHANNEL_DATA, remote, chunk.subarray(0, n))); windowOut -= n; chunk = chunk.subarray(n); } } }
      finally { sending = false; }
    }
    /* The escape "~." on a line of its own ends the session (OpenSSH's ~ escapes, of which this is the one). "atBol"
       is true right after a newline; then a "~" is held, and the next character decides: "." ends it, "~" sends one
       literal tilde, anything else sends the tilde and the character. */
    var atBol = true, tilde = false;
    c.stdin(function (t) {
      for (var i = 0; i < t.length; i++) {
        var ch = t[i];
        if (tilde) { tilde = false; if (ch === '.') { c.stdout('\r\n\x1b[2m~. session ended\x1b[0m'); closed = true; tp.socket.close(); return; } if (ch !== '~') pending.push(B.encode('~')); pending.push(B.encode(ch)); atBol = false; continue; }
        if (atBol && ch === '~') { tilde = true; continue; }
        pending.push(B.encode(ch)); atBol = (ch === '\r' || ch === '\n');
      }
      flush();
    });
    c.tty.onResize(function (rows, cols) { if (!closed) tp.send(pack('Butbuuuu', MSG.CHANNEL_REQUEST, remote, 'window-change', false, cols, rows, 0, 0)).catch(function () {}); });
    async function handle(p) {
      var t = p[0], u = new Unpacker(p.subarray(1));
      if (t === MSG.CHANNEL_DATA) { u.u32(); var data = u.str(); c.write(dec.decode(data, { stream: true })); consumed += data.length; if (consumed > windowIn / 2) { await tp.send(pack('Buu', MSG.CHANNEL_WINDOW_ADJUST, remote, consumed)); consumed = 0; } }
      else if (t === MSG.CHANNEL_EXTENDED_DATA) { u.u32(); u.u32(); var ed = u.str(); c.write('\x1b[31m' + dec.decode(ed, { stream: true }) + '\x1b[0m'); consumed += ed.length; if (consumed > windowIn / 2) { await tp.send(pack('Buu', MSG.CHANNEL_WINDOW_ADJUST, remote, consumed)); consumed = 0; } }
      else if (t === MSG.CHANNEL_WINDOW_ADJUST) { u.u32(); windowOut += u.u32(); waiters.splice(0).forEach(function (w) { w(); }); }
      else if (t === MSG.CHANNEL_REQUEST) { u.u32(); var name = u.text(), want = u.bool(); if (name === 'exit-status') exitCode = u.u32(); else if (name === 'exit-signal') { exitCode = 128; c.stdout('\r\n\x1b[2mkilled by ' + u.text() + '\x1b[0m'); } if (want) await tp.send(pack('Bu', MSG.CHANNEL_FAILURE, remote)); }
      else if (t === MSG.CHANNEL_EOF) eof = true;
      else if (t === MSG.CHANNEL_CLOSE) { if (!closed) { closed = true; await tp.send(pack('Bu', MSG.CHANNEL_CLOSE, remote)); } }
      else if (t === MSG.GLOBAL_REQUEST) { var g = u.text(), wr = u.bool(); log('global request ' + g + ' ignored'); if (wr) await tp.send(pack('B', MSG.REQUEST_FAILURE)); }
      else log('ignoring message ' + t);
    }
    try { while (!closed) await handle(await tp.next()); }
    catch (e) { if (!closed && !(e instanceof net.NetError)) throw e; }
    return exitCode === null ? 255 : exitCode;
  }

  /* ---------------------------------------------------------------- main */
  (async function () {
    var socket, tp, code = 255;
    try {
      var pipe = o.P ? (await sh.locate(sh.resolve(o.P))).loc : null;
      socket = await net.connect(host, port, { baseURI: c.baseURI, protocol: 'ssh', pipe: pipe ? sh.leafURL(pipe) : undefined });
      tp = new Transport(socket); tp.clientVersion = 'SSH-2.0-cvwm_1.0';
      await socket.write(B.encode(tp.clientVersion + '\r\n'));
      for (;;) { var line = await tp.reader.readLine(); if (/^SSH-/.test(line)) { tp.serverVersion = line; break; } if (line) c.stdout(line); }
      log('server version ' + tp.serverVersion);
      if (!/^SSH-(2\.0|1\.99)-/.test(tp.serverVersion)) throw fail('transport', 'not an SSH-2 server: ' + tp.serverVersion);
      await tp.kex(null);
      await authenticate(tp);
      log('authenticated as ' + user);
      code = await session(tp);
    } catch (e) {
      if (e && e.where) c.stderr('ssh: ' + e.where + ': ' + e.message); else if (e instanceof net.NetError) c.stderr('ssh: ' + host + ':' + port + ': ' + e.message); else { c.stderr('ssh: ' + (e && e.message || e)); console.error(e); }
      code = 255;
    }
    c.stdin(null); if (socket) socket.close();
    c.stdout('\x1b[2mConnection to ' + host + ' closed.\x1b[0m');
    c.exit(code);
  })();
})();
