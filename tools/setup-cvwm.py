#!/usr/bin/env python3
"""setup-cvwm.py - stand up seedmi so that cvwm runs against it, for a given hostname.

    ./setup-cvwm.py cdmi.example.local        # the hostname must already resolve to this machine

It does what cvwm needs and nothing it does not:
  * generates a TLS certificate for the hostname (the export origin rejects IP addresses, so a name is required);
  * checks the hostname resolves to this machine (it does not edit /etc/hosts and needs no root);
  * starts seedmi-dc (the reference domain controller: LDAP + OAuth + KDC) with a couple of users who have homes;
  * starts seedmi with the discovery tree, the root domain resolved at the controller with a home_base, a home
    server, and an HTTP export that serves the cvwm desktop at /desktop/ on seedmi's own origin (same-origin, no CORS);
  * enables the NFS and SMB export servers at their default ports (NFSv4.1 on 2049, SMB on 445) so NFS and SMB
    export entries are served; SMB's 445 is a privileged port, so bind it without root by first running
    `sudo sysctl net.ipv4.ip_unprivileged_port_start=445` (NFS's 2049 is unprivileged and needs nothing);
  * enables the CDMI over MCP protocol binding on its own listener, on the hostname at port 8100 (https);
  * installs the cvwm package into the desktop container and activates that export;
  * optionally starts seedmi-kms (--with-kms) and seedmi-dac (--with-dac, which implies --with-kms since the
    DAC identity's keys are held at the KMS), wiring seedmi's [[kms]] and [dac] tables to them.

Everything the run creates lives under <workspace>/run-<hostname>/ so a second run with a different name does not collide. The whole run is
also written to a Markdown runlog in that directory. This is a development setup: self-signed certificates,
plaintext passwords in the generated config, anonymous reads on the desktop export. Not for production.

Standard library only; no third-party packages. Requires the external programs node and openssl on PATH. Run it
from the workspace that holds the seedmi trees, with the cvwm package as a subdirectory:

    .../workspace$ ls
    cvwm/  seedmi/  seedmi-dc/  seedmi-dac/  seedmi-kms/  run-<host>/
    .../workspace$ python3 cvwm/tools/setup-cvwm.py <hostname>

The workspace is found automatically (the current directory, or the parent of the cvwm/ this script is in); give it
explicitly with --base, or point at individual trees with --seedmi / --cvwm. run-<host>/ is created in the workspace.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import signal
import socket
import secrets
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_VERSION = "2.100.0"   # setup-cvwm.py (semver)
HERE_TOOLS = os.path.dirname(os.path.abspath(__file__))   # this script's directory, holding kms-make-dac-keys.mjs


# --------------------------------------------------------------------------- Markdown output + runlog
class Out:
    """Writes the run as Markdown, to the terminal and (once opened) to a runlog file at the same time."""

    def __init__(self):
        self._log = None
        self._phase_n = 0

    def open_log(self, path):
        self._log = open(path, "w", encoding="utf-8")

    def _emit(self, text):
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
        if self._log:
            self._log.write(text + "\n")
            self._log.flush()

    # structural
    def line(self, text=""):
        self._emit(text)

    def heading(self, text):
        self._emit("# " + text)

    def pre(self, lines):
        self._emit("```")
        for ln in lines:
            self._emit(ln)
        self._emit("```")

    def phase(self, description):
        self._phase_n += 1
        self._emit("")
        self._emit("## Phase %d: %s" % (self._phase_n, description))
        self._emit("")
        self._emit("_%s._" % description)
        self._emit("")

    # within a phase
    def note(self, text):
        self._emit("- " + text)

    def did(self, text):
        self._emit("- done: " + text)

    def warn(self, text):
        self._emit("- **warning:** " + text)

    def error(self, text, extra_lines=None):
        """A fatal error as a Markdown blockquote. extra_lines are further blockquote lines (already without '> ')."""
        self._emit("")
        self._emit("> **error:** " + text)
        for ln in (extra_lines or []):
            self._emit("> " + ln if ln else ">")

    def close(self):
        if self._log:
            self._log.close()
            self._log = None


OUT = Out()


class SetupError(Exception):
    """A fatal, reported error: its message and optional blockquote lines are printed and the program exits."""

    def __init__(self, message, extra_lines=None, code=1):
        super().__init__(message)
        self.message = message
        self.extra_lines = extra_lines or []
        self.code = code


# --------------------------------------------------------------------------- helpers
def run_cmd(args, cwd=None, check=True, capture=False):
    """Run an external command. Returns CompletedProcess; raises SetupError on failure when check is set."""
    try:
        return subprocess.run(
            args, cwd=cwd, check=check,
            stdout=(subprocess.PIPE if capture else subprocess.DEVNULL),
            stderr=(subprocess.PIPE if capture else subprocess.DEVNULL),
            text=True,
        )
    except FileNotFoundError:
        raise SetupError("the program `%s` is not on PATH" % args[0])
    except subprocess.CalledProcessError as e:
        detail = ((e.stderr or "") + (e.stdout or "")).strip()
        # Show the failing command's output as a fenced block so the real cause is visible, not just "failed".
        extra = (["```"] + detail.splitlines()[-20:] + ["```"]) if detail else None
        raise SetupError("`%s` exited with status %d" % (" ".join(args), e.returncode), extra_lines=extra)


def toml_escape(s):
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


def toml_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(toml_value(x) for x in v) + "]"
    return '"' + toml_escape(v) + '"'


def toml_table(rows):
    """rows: list of (key, value) pairs -> TOML lines. Value None emits a bare comment-free skip."""
    out = []
    for k, v in rows:
        if v is None:
            continue
        out.append("%s = %s" % (k, toml_value(v)))
    return out


# A TLS context that does not verify the self-signed development certificates.
def insecure_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def http_request(method, url, user=None, password=None, accept=None, content_type=None, body=None, timeout=10):
    """Make an HTTP(S) request with the insecure context. Returns (status, body_text). status is 0 on a network error."""
    headers = {}
    if accept:
        headers["Accept"] = accept
    if content_type:
        headers["Content-Type"] = content_type
    if user is not None:
        import base64
        token = base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
        headers["Authorization"] = "Basic " + token
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    # Talk to the local server directly: bypass any HTTP(S)_PROXY in the environment (an empty ProxyHandler),
    # which otherwise routes the health check and every request through a proxy that cannot reach it.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                         urllib.request.HTTPSHandler(context=insecure_ctx()))
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read().decode("utf-8", "replace") if e.fp else "")
    except (urllib.error.URLError, ssl.SSLError, socket.timeout, ConnectionError, OSError):
        return 0, ""


def local_addresses():
    """Every address this machine answers on: loopback, plus what its own hostname resolves to on each interface."""
    addrs = {"127.0.0.1", "::1"}
    try:
        host = socket.gethostname()
        for family in (socket.AF_INET, socket.AF_INET6):
            try:
                for info in socket.getaddrinfo(host, None, family):
                    addrs.add(info[4][0].split("%")[0])
            except socket.gaierror:
                pass
    except OSError:
        pass
    # Also whatever a connected UDP socket reveals as this host's primary address (no packet is sent).
    for target in (("8.8.8.8", 80), ("2001:4860:4860::8888", 80)):
        fam = socket.AF_INET if ":" not in target[0] else socket.AF_INET6
        try:
            s = socket.socket(fam, socket.SOCK_DGRAM)
            try:
                s.connect(target)
                addrs.add(s.getsockname()[0].split("%")[0])
            finally:
                s.close()
        except OSError:
            pass
    return addrs


def resolve_addresses(host):
    """Every address a hostname resolves to, as a set of strings; empty if it does not resolve."""
    found = set()
    try:
        for info in socket.getaddrinfo(host, None):
            found.add(info[4][0].split("%")[0])
    except socket.gaierror:
        pass
    return found


def read_version_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.readline().strip()
    except OSError:
        return "?"


def read_cvwm_version(cvwm_js):
    try:
        with open(cvwm_js, encoding="utf-8") as f:
            for line in f:
                m = re.search(r"cvwm version:\s*([0-9.]+)", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return "?"


def read_seedmi_version(seedmi_dir):
    try:
        with open(os.path.join(seedmi_dir, "package.json"), encoding="utf-8") as f:
            return json.load(f).get("version", "?")
    except (OSError, ValueError):
        return "?"


# --------------------------------------------------------------------------- the setup
class Setup:
    def __init__(self, args):
        self.host = args.host
        self.https_port = args.port
        self.http_port = args.http_port
        self.with_dac = args.with_dac
        self.with_kms = args.with_kms or args.with_dac   # DAC's identity keys are held at the KMS, so DAC implies KMS

        # Service discovery (ECR-224A). seedmi offers the cdmi_domain_doh item, which hands a client (servers)
        # the DoH resolver to begin DNS-SD discovery at and the browsing domains to search. seedmi speaks no DNS: the
        # records the item leads to are put in place by seedmi-mdns (advertises this server on the local link) and
        # seedmi-zone (republishes what it hears into a real zone). seedmi-mdns runs by default; seedmi-zone is opt-in
        # (--zone), and the two cannot share the single multicast port 5353, so --zone stands in for the responder.
        self.doh_resolver = getattr(args, "doh_resolver", None)
        self.browse_domains = [d.strip().lower() for d in (getattr(args, "browse_domains", None) or "local").split(",") if d.strip()]
        self.with_zone = bool(getattr(args, "zone", False))
        self.zone_name = getattr(args, "zone_name", None)
        self.zone_update = getattr(args, "zone_update", None)
        self.with_mdns = (not getattr(args, "no_mdns", False)) and not self.with_zone
        if self.doh_resolver:
            self._validate_resolver(self.doh_resolver)      # fail early with a friendly message, before seedmi rejects it
        # A browsing domain reached only through seedmi-zone is the zone's subtree, so add it to the item's list.
        if self.with_zone and self.zone_name and self.zone_name.lower() not in self.browse_domains:
            self.browse_domains.append(self.zone_name.lower())

        # Service-level data system metadata (seedmi 0.113, [service_level]). These say what this deployment can
        # achieve for the items whose provided counterparts report it and that no measurement reveals: where it stores
        # objects (regions), and the recovery objectives (rpo/rto). The architectural items (one copy, one
        # infrastructure) and the measured ones (latency, throughput) need no configuration. A provided item is reported
        # only where an object requests the corresponding item, so configuring these does not add metadata to every
        # object; regions additionally turns on cdmi_geographic_placement evaluation (a placement permitting nowhere the
        # server stores is then forbidden). All optional; validated here so a bad value fails before seedmi starts.
        self.service_regions = self._parse_regions(getattr(args, "regions", None))
        self.rpo = self._parse_duration(getattr(args, "rpo", None), "--rpo")
        self.rto = self._parse_duration(getattr(args, "rto", None), "--rto")

        # An export origin's host must be a name of at least two labels: seedmi refuses an IP address and a single
        # label, and it refuses them only when the export is created, long after everything else is built. Check now.
        if re.match(r"^[0-9.]+$", self.host) or re.match(r"^\[?[0-9a-fA-F:]+\]?$", self.host):
            raise SetupError("`%s` is an IP address; an export origin needs a hostname (try `cdmi.example.local`)." % self.host, code=2)
        if "." not in self.host:
            raise SetupError("`%s` is a single label; an export origin needs at least two (try `%s.local`)." % (self.host, self.host), code=2)

        # The realm's DNS domain is the hostname itself, so a user signs in as user@<hostname> (e.g. alice@snia.local).
        # The Kerberos realm is that hostname upper-cased, as the controller requires (seedmi-dc's REALM is upper-case
        # labels), and the base DN derives from the same hostname. cvwm's login shows the DNS (lower-case) form; the
        # controller resolves an account to realm-qualified form (alice@SNIA.LOCAL), which is what ACLs and ownership use.
        self.domain_dns = self.host
        self.realm = args.realm or self.host.upper()
        self.base_dn = args.base_dn or ("dc=" + self.host.replace(".", ",dc="))

        # The seedmi family of trees (seedmi, seedmi-dc, seedmi-kms, seedmi-dac) and the cvwm package sit together in
        # a workspace directory. This script lives at cvwm/tools/, so that workspace is not the script's own directory
        # but its grandparent -- or wherever the command is run from, which is how the intended invocation works:
        #     .../workspace$ python3 cvwm/tools/setup-cvwm.py frosta.local
        # Choose the base by looking for the seedmi tree in, in order: an explicit --base, the current directory, the
        # script's grandparent (cvwm/..), and the script's own directory (a flat checkout). The run dir and outputs
        # land in that base, so run-<host>/ appears beside seedmi/ as the listing shows.
        script_dir = os.path.dirname(os.path.abspath(__file__))
        candidates = []
        if getattr(args, "base", None):
            candidates.append(os.path.abspath(args.base))
        candidates += [os.getcwd(), os.path.dirname(os.path.dirname(script_dir)), script_dir]
        base = None
        for c in candidates:
            if os.path.isfile(os.path.join(c, "seedmi", "src", "main.ts")):
                base = c; break
        if base is None:
            base = os.path.abspath(args.base) if getattr(args, "base", None) else os.getcwd()
        self.base_dir = base
        self.seedmi_dir = os.path.abspath(args.seedmi) if args.seedmi else os.path.join(base, "seedmi")
        # cvwm defaults to the package this script is part of (cvwm/), i.e. the script's parent.
        self.cvwm_dir = os.path.abspath(args.cvwm) if args.cvwm else os.path.dirname(script_dir)
        self.dc_dir = os.path.join(base, "seedmi-dc")
        self.kms_dir = os.path.join(base, "seedmi-kms")
        self.dac_dir = os.path.join(base, "seedmi-dac")
        self.mdns_dir = os.path.join(base, "seedmi-mdns")
        self.zone_dir = os.path.join(base, "seedmi-zone")
        self.run = os.path.join(base, "run-" + self.host)
        self.pki = os.path.join(self.run, "pki")

        # The setup runs as a real domain user (the controller authenticates it) given the backup_operator privilege
        # below. A local [[user]] cannot be used: the root domain is controller-served, and seedmi refers every
        # credential under a controller-served domain to the controller, which does not know a local account.
        self.setup_user = "alice"
        self.setup_pass = "alice"
        self.setup_group_bare = "storage-admins"
        self.setup_group = "storage-admins@" + self.realm

        self.base_uri = "https://%s:%d/cdmi/3.0.0/" % (self.host, self.https_port)
        self.desktop_url = "https://%s:%d/desktop/index.html" % (self.host, self.https_port)

        self.dc_https_port = 8636
        self.dc_ldap_port = 8637
        # Each sub-domain is resolved by its OWN controller instance, which shares the realm and LDAP base with the
        # root (so a principal keeps its name -- bob@REALM is one identity everywhere) but serves ONLY that
        # sub-domain's members. Membership is therefore scoped: mallory is a principal of orchestration, bob of
        # agents, and neither is a principal of the other's domain. The reference controller is single-realm and
        # single-base, so a separate instance per sub-domain -- not an OU under one directory -- is how membership
        # is narrowed with the reference tools unchanged.
        self.subdomains = [
            {"name": "orchestration", "https_port": 8644, "ldap_port": 8646, "members": ["mallory"]},
            {"name": "agents",        "https_port": 8645, "ldap_port": 8647, "members": ["bob"]},
        ]
        self.kms_port = 5696                 # KMIP
        self.dac_port = 9444                 # DAC provider HTTPS (distinct from seedmi's 9443)
        self.mcp_port = 8100                 # CDMI over MCP (revision 347): its own listener
        self.oauth_port = 8101               # seedmi's built-in authorization server (issues MCP tokens)
        self.oauth_client_id = "mcp-inspector"        # the client the MCP Inspector authenticates as (client_credentials)
        self.oauth_client_secret = secrets.token_urlsafe(24)   # its secret, generated per run
        self.dac_path = "/decide"
        self.kms_label = "primary"
        self.kms_scope = "cdmi/root/"        # the prefix the DAC identity keys live under, matched by cdmi_domain_kms
        self.dac_sign_id = "dac-sign"        # the bare id [dac] refers to; seedmi prepends the domain's scope
        self.dac_enc_id = "dac-enc"
        self.dac_sign_key = self.kms_scope + self.dac_sign_id   # the full KMS Name the key is created under
        self.dac_enc_key = self.kms_scope + self.dac_enc_id
        self.pids = []
        self.procs = []
        self.launches = []          # (name, argv) in start order, so start.sh can relaunch exactly what ran
        self.runlog = None

    # -- preconditions ------------------------------------------------------
    def check_prerequisites(self):
        for prog in ("node", "openssl"):
            if shutil.which(prog) is None:
                raise SetupError("`%s` is required on PATH" % prog)
        if not os.path.isfile(os.path.join(self.seedmi_dir, "src", "main.ts")):
            raise SetupError("no seedmi at `%s` (pass --seedmi DIR)" % self.seedmi_dir)
        if not (os.path.isfile(os.path.join(self.cvwm_dir, "cvwm.js")) and
                os.path.isfile(os.path.join(self.cvwm_dir, "install.py"))):
            raise SetupError("no cvwm package at `%s` (pass --cvwm DIR)" % self.cvwm_dir)
        if self.with_kms and not os.path.isfile(os.path.join(self.kms_dir, "src", "kmsd.ts")):
            raise SetupError("no seedmi-kms at `%s` (needed for --with-kms/--with-dac)" % self.kms_dir)
        if self.with_dac and not os.path.isfile(os.path.join(self.dac_dir, "src", "dacd.ts")):
            raise SetupError("no seedmi-dac at `%s` (needed for --with-dac)" % self.dac_dir)
        if self.with_mdns and not os.path.isfile(os.path.join(self.mdns_dir, "src", "mdnsd.ts")):
            # The responder runs by default, but its absence (an older seedmi release) is not a reason to stop the run.
            OUT.warn("no seedmi-mdns at `%s`; this server will not be advertised on the link. Use a seedmi release with seedmi-mdns, or pass --no-mdns to silence this." % self.mdns_dir)
            self.with_mdns = False
        if self.with_zone:
            if not os.path.isfile(os.path.join(self.zone_dir, "src", "zoned.ts")):
                raise SetupError("no seedmi-zone at `%s` (needed for --zone)" % self.zone_dir)
            if not self.zone_name:
                raise SetupError("--zone needs --zone-name SUBTREE (the DNS subtree it publishes into, e.g. lan.example.com)",
                                 extra_lines=["It must differ from the browsed link ('local'), and you must run a name server it can write to",
                                              "(an Unbound via unbound-control, or a BIND/Knot/PowerDNS via --zone-update)."])
            if self.zone_name.lower() in ("local",) or self.zone_name.lower() in [d.lower() for d in ("local",)]:
                raise SetupError("--zone-name must differ from the browsed link 'local'")

    @staticmethod
    def _validate_resolver(v):
        """The [discovery].resolver rules seedmi enforces, checked here so a bad value fails before seedmi starts."""
        try:
            u = urllib.parse.urlparse(v)
        except Exception:
            raise SetupError("--doh-resolver is an absolute https URI, e.g. https://resolver.example/dns-query")
        if u.scheme != "https" or not u.netloc:
            raise SetupError("--doh-resolver is an absolute URI of the scheme https with a host (the DoH endpoint origin and path)")
        if u.query or u.fragment or "@" in u.netloc:
            raise SetupError("--doh-resolver carries no query, fragment or userinfo: a client appends its question as ?dns=<base64url>")

    @staticmethod
    def _parse_regions(v):
        """Parse --regions into the list [service_level].regions takes: concrete ISO 3166-1/3166-2 codes (uppercased),
        no "!" exclusion and no "*", since these are the locations the server actually stores in, not a placement list.
        Returns None when unset (the section then omits regions and placement is not evaluated)."""
        if not v:
            return None
        out = []
        for raw in v.split(","):
            code = raw.strip().upper()
            if not code:
                continue
            if not (re.match(r"^[A-Z]{2}$", code) or re.match(r"^[A-Z]{2}-[A-Z0-9]{1,3}$", code)):
                raise SetupError("--regions holds ISO 3166 codes such as CA or CA-BC (a country code, or a subdivision code); `%s` is neither." % raw.strip(),
                                 extra_lines=["", "These name the storage locations this deployment keeps objects in, so they carry no `!` exclusion and no `*`."])
            out.append(code)
        if not out:
            raise SetupError("--regions was given but held no codes; drop the flag, or list at least one (e.g. CA-BC).")
        return out

    @staticmethod
    def _parse_duration(v, flag):
        """Parse --rpo / --rto into the positive-integer seconds string [service_level] takes, or None to omit it."""
        if v is None:
            return None
        s = str(v).strip().lower()
        if s in ("", "none", "off"):
            return None
        if not re.match(r"^[1-9][0-9]*$", s):
            raise SetupError("%s is a duration in seconds, as a positive whole number (or 'none' to omit); got `%s`." % (flag, v))
        return s

    def check_store_absent(self):
        # A store from an earlier run keeps its original root access list (the default is applied only at creation),
        # so a store made under a different configuration may not match this run. The script does not delete data.
        data = os.path.join(self.run, "data")
        if os.path.isdir(data):
            raise SetupError(
                "a store already exists at `%s`." % data,
                extra_lines=[
                    "",
                    "This script does not delete data. To start clean, remove it yourself:",
                    "",
                    "```",
                    "rm -rf %s" % data,
                    "```",
                    "",
                    "or run against a different hostname (which uses a different run directory).",
                ])

    # -- header + runlog ----------------------------------------------------
    def start_runlog_and_header(self):
        os.makedirs(self.run, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
        self.runlog = os.path.join(self.run, stamp + "-run.md")
        OUT.open_log(self.runlog)

        pkg_v = read_version_file(os.path.join(self.cvwm_dir, "VERSION"))
        cvwm_v = read_cvwm_version(os.path.join(self.cvwm_dir, "cvwm.js"))
        seedmi_v = read_seedmi_version(self.seedmi_dir)
        OUT.heading("seedmi for cvwm")
        OUT.line()
        OUT.pre([
            "package        %s   (cvwm-%s.zip)" % (pkg_v, pkg_v),
            "setup-cvwm.py  %s" % SCRIPT_VERSION,
            "seedmi         %s" % seedmi_v,
            "cvwm           %s" % cvwm_v,
            "",
            "host      %s  (realm %s, base %s)" % (self.host, self.realm, self.base_dn),
            "https     %d   http %d" % (self.https_port, self.http_port),
            "seedmi    %s" % self.seedmi_dir,
            "cvwm      %s" % self.cvwm_dir,
            "run dir   %s" % self.run,
        ])

    # -- phase 1: resolution ------------------------------------------------
    def phase_resolve(self):
        OUT.phase("Check the hostname resolves to this machine")
        resolved = resolve_addresses(self.host)
        if not resolved:
            raise SetupError(
                "`%s` does not resolve. Point it at this machine before running, by one of:" % self.host,
                extra_lines=[
                    "- a DNS record (A/AAAA) for `%s` at this host's address, or" % self.host,
                    "- a name your resolver already sends to loopback (many map `*.localhost`), e.g. `%s.localhost`, or" % self.host.split(".")[0],
                    "- a line in /etc/hosts (needs your admin): `127.0.0.1 %s`" % self.host,
                ])
        mine = local_addresses()
        foreign = sorted(a for a in resolved if a not in mine)
        if foreign:
            raise SetupError(
                "`%s` resolves to %s, which is not an address of this machine." % (self.host, " ".join(foreign)),
                extra_lines=[
                    "seedmi runs here, so the name must resolve to this host (loopback or a local interface).",
                    "Point `%s` at this machine, or run the script where `%s` resolves to." % (self.host, self.host),
                ])
        OUT.note("`%s` resolves to this machine (%s)" % (self.host, " ".join(sorted(resolved))))
        OUT.did("%s resolves to this machine" % self.host)

    # -- phase 2: certificates ---------------------------------------------
    def _gen_cert(self, name, cn, san):
        run_cmd([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
            "-keyout", os.path.join(self.pki, name + ".key"),
            "-out", os.path.join(self.pki, name + ".crt"),
            "-subj", "/CN=" + cn, "-addext", "subjectAltName=" + san,
        ])

    def phase_certs(self):
        OUT.phase("Generate TLS certificates for the hostname and the controller")
        os.makedirs(self.pki, exist_ok=True)
        OUT.note("generating certificates in `%s` ..." % self.pki)
        # A binding certificate for seedmi (SAN = the hostname) and one for the controller. The controller makes its
        # own token-signing key at first start, so none is written here.
        self._gen_cert("binding", self.host, "DNS:%s" % self.host)
        self._gen_cert("dc", self.host, "DNS:%s,IP:127.0.0.1" % self.host)

        # KMS and DAC have their own PKI helpers (kms-pki.ts, dac-pki.ts) that build the CA/server/client and, for the
        # DAC, the provider and signing chain that must chain correctly. Use them so the trust is what each server
        # expects, then copy the files this run refers to into pki/ under stable names.
        if self.with_kms:
            OUT.note("generating KMS certificates ...")
            kms_pki = os.path.join(self.run, "kms-pki")
            run_cmd(["node", os.path.join(self.kms_dir, "src", "kms-pki.ts"), "--out", kms_pki, "--client", "seedmi"], cwd=self.run, capture=True)
            self._adopt(kms_pki, "ca.pem", "kms-ca.crt")
            self._adopt(kms_pki, "server.pem", "kms-server.crt"); self._adopt(kms_pki, "server.key", "kms-server.key")
            self._adopt(kms_pki, "seedmi.pem", "kms-client.crt"); self._adopt(kms_pki, "seedmi.key", "kms-client.key")
        if self.with_dac:
            OUT.note("generating DAC certificates ...")
            dac_pki = os.path.join(self.run, "dac-pki")
            run_cmd(["node", os.path.join(self.dac_dir, "src", "dac-pki.ts"), "--out", dac_pki, "--host", self.host], cwd=self.run, capture=True)
            # dac-pki writes https.crt/key (listener), provider.crt/key, signing.crt/key, and its CA. Names vary by
            # release; adopt what is present. The listener cert's CA is what seedmi trusts to reach the provider.
            for src_name, dst in [("https.crt", "dac-https.crt"), ("https.key", "dac-https.key"),
                                  ("provider.crt", "dac-provider.crt"), ("provider.key", "dac-provider.key"),
                                  ("signing.crt", "dac-signing.crt"), ("signing.key", "dac-signing.key")]:
                self._adopt(dac_pki, src_name, dst)
            # The listener certificate is self-signed, so what seedmi trusts to reach the provider is that cert itself.
            self._adopt(dac_pki, "https.crt", "dac-ca.crt")

        made = ["a binding certificate", "a controller certificate"]
        if self.with_kms: made.append("KMS certificates")
        if self.with_dac: made.append("DAC certificates")
        OUT.did("wrote " + ", ".join(made) + " in %s" % self.pki)

    def _adopt(self, from_dir, src_name, dst_name, optional=False):
        """Copy a generated PKI file into pki/ under a stable name this run refers to."""
        src = os.path.join(from_dir, src_name)
        if not os.path.isfile(src):
            if optional:
                return
            raise SetupError("expected PKI file `%s` was not produced" % src)
        shutil.copyfile(src, os.path.join(self.pki, dst_name))

    # -- phase 3: dc config -------------------------------------------------
    # The realm's whole population. The root controller serves all of them; a sub-domain controller serves only the
    # members named for that sub-domain, which is what scopes domain membership. Groups are defined in every
    # controller (they are cheap and a user references them), but a user appears only where it is a member.
    DC_GROUPS = [("staff", []), ("storage-admins", ["staff"]), ("orchestrators", ["staff"]), ("agents", ["staff"])]
    DC_USERS = [
        ("alice",   "alice",   ["storage-admins"], "/home/alice"),
        ("mallory", "mallory", ["orchestrators"],  "/home/mallory"),
        ("bob",     "bob",     ["agents"],         "/home/bob"),
    ]

    def _write_dc_config(self, path, https_port, ldap_port, members, with_homes, header):
        """Write one controller config: the realm, a listener on the given ports, every group, and the [[user]]
        entries for `members` (with homes only where with_homes, i.e. the root controller that serves sign-in)."""
        pki = self.pki
        lines = ["# generated by setup-cvwm.py for %s" % self.host, "# " + header, "[realm]"]
        lines += toml_table([("name", self.realm), ("domain", self.domain_dns)])
        lines.append("")
        lines.append("[listen]")
        lines += toml_table([
            ("host", "127.0.0.1"),
            ("port", https_port),
            ("ldap_port", ldap_port),
            ("certificate_file", os.path.join(pki, "dc.crt")),
            ("key_file", os.path.join(pki, "dc.key")),
        ])
        lines.append("")
        for gname, gparents in self.DC_GROUPS:
            lines.append("[[group]]")
            lines += toml_table([("name", gname)] + ([("groups", gparents)] if gparents else []))
            lines.append("")
        for uname, upass, ugroups, uhome in self.DC_USERS:
            if uname not in members:
                continue
            fields = [("name", uname), ("password", upass), ("groups", ugroups)]
            if with_homes:
                fields.append(("home", uhome))
            lines.append("[[user]]")
            lines += toml_table(fields)
            lines.append("")
        self._write(path, lines)
        # Verify the controller config has the fields it needs before starting it: a [listen] table with an ldap_port
        # (without it dcd binds no LDAP port and seedmi's principal lookups never connect) and the cert/key files.
        self._check_dc_config(path)

    def phase_dc_config(self):
        OUT.phase("Write the domain controller configurations (a root controller and one per sub-domain)")
        # The root controller serves every principal and their homes: sign-in and home provisioning are root-domain,
        # so all three users resolve here. Passwords are plaintext (development only).
        self._write_dc_config(
            os.path.join(self.run, "dc.toml"), self.dc_https_port, self.dc_ldap_port,
            ["alice", "mallory", "bob"], with_homes=True,
            header="root controller: all principals (alice administers, mallory orchestrates, bob is an agent), with homes")
        # A controller per sub-domain, serving only that sub-domain's members. Because it shares the realm and base,
        # the principals keep their names; because it lists only its members, a non-member (e.g. mallory at agents)
        # does not resolve there and so is not a principal of that domain. Homes are root-domain, so these omit them.
        for sd in self.subdomains:
            self._write_dc_config(
                os.path.join(self.run, "dc-%s.toml" % sd["name"]), sd["https_port"], sd["ldap_port"],
                sd["members"], with_homes=False,
                header="%s controller: members %s only" % (sd["name"], ", ".join(sd["members"])))
        subs = "; ".join("%s -> %s" % (sd["name"], ", ".join(sd["members"])) for sd in self.subdomains)
        OUT.did("wrote dc.toml (root: alice, mallory, bob) and a controller per sub-domain (%s), realm %s" % (subs, self.realm))

    # -- phase 4: seedmi config --------------------------------------------
    def phase_seedmi_config(self):
        OUT.phase("Write the seedmi configuration (discovery tree, domain, home server, service level)")
        pki = self.pki
        lines = []
        lines.append("# generated by setup-cvwm.py for %s" % self.host)
        lines += toml_table([("store", os.path.join(self.run, "data")), ("well_known", True), ("namespace_name", "store")])
        lines.append("")
        lines.append("[http]")
        lines += toml_table([("host", self.host), ("port", self.http_port)])
        lines.append("")
        lines.append("[https]")
        lines += toml_table([("port", self.https_port), ("certificate", "binding")])
        lines.append("")
        lines.append("[[certificate]]")
        lines += toml_table([("id", "binding"), ("chain_file", os.path.join(pki, "binding.crt")), ("key_file", os.path.join(pki, "binding.key"))])
        lines.append("")
        lines.append("[export]")
        lines += toml_table([("origins", ["https://%s:%d" % (self.host, self.https_port)])])
        lines.append("")
        lines.append("# Serve NFS and SMB export entries at their default ports. NFSv4.1 on 2049 (an unprivileged port) needs")
        lines.append("# nothing special; SMB on 445 is a privileged port, so seedmi is started after")
        lines.append("# `sudo sysctl net.ipv4.ip_unprivileged_port_start=445` has made it bindable without root.")
        lines.append("[nfs]")
        lines += toml_table([("enabled", True), ("host", self.host), ("port", 2049)])
        lines.append("")
        lines.append("[smb]")
        lines += toml_table([("enabled", True), ("host", self.host), ("port", 445)])
        lines.append("")
        lines.append("# Resolve the root domain's principals at the controller, and state where their homes are held.")
        lines.append("[[domain_controller]]")
        lines += toml_table([
            ("domain", "/cdmi_domains/"),
            ("realm", self.realm),
            ("ldap", "ldaps://127.0.0.1:%d" % self.dc_ldap_port),
            ("base", self.base_dn),
            ("ca_file", os.path.join(pki, "dc.crt")),
            ("home_base", self.base_uri),
            ("issuer", "https://%s:%d" % (self.host, self.oauth_port)),
            ("audience", "https://%s:%d/mcp" % (self.host, self.mcp_port)),
        ])
        lines.append("")
        # Each sub-domain is resolved at its OWN controller instance (a distinct LDAP port), which shares this realm
        # and base -- so a principal keeps its name -- but serves only that sub-domain's members. This is what scopes
        # membership: a principal absent from a sub-domain's controller does not resolve there, so it is not a
        # principal of that domain (mallory of orchestration, bob of agents, and neither of the other). What each
        # group may DO where is still set by [[group_privileges]] below, independently of membership.
        for sd in self.subdomains:
            lines.append("[[domain_controller]]")
            lines += toml_table([
                ("domain", "/cdmi_domains/%s/" % sd["name"]),
                ("realm", self.realm),
                ("ldap", "ldaps://127.0.0.1:%d" % sd["ldap_port"]),
                ("base", self.base_dn),
                ("ca_file", os.path.join(pki, "dc.crt")),
                ("home_base", self.base_uri),
                ("issuer", "https://%s:%d" % (self.host, self.oauth_port)),
                ("audience", "https://%s:%d/mcp" % (self.host, self.mcp_port)),
            ])
            lines.append("")
        lines.append("# Privileges are granted to a group within a domain path. storage-admins administers the domains at")
        lines.append("# the root (backup_operator to write the tree, cross_domain to place objects across domains, and")
        lines.append("# domain_auth_admin to set a domain's authentication) -- alice is in this group, so she is the")
        lines.append("# domain administrator. orchestrators hold cross_domain in the orchestration sub-domain ONLY, so")
        lines.append("# mallory may act across domains there but nowhere else. agents (bob) get no special privilege;")
        lines.append("# they are ordinary principals of the agents sub-domain.")
        lines.append("# Group names are matched as the controller reports them; both the realm-qualified (group@REALM) and")
        lines.append("# the bare form are granted, so the match holds whichever the controller emits.")
        def grant(domain, group_bare, privs):
            for grp in (group_bare + "@" + self.realm, group_bare):
                lines.append("[[group_privileges]]")
                lines.extend(toml_table([("domain", domain), ("group", grp), ("privileges", privs)]))
                lines.append("")
        admin_privs = ["backup_operator", "cross_domain", "domain_auth_admin"]
        if self.with_kms:
            admin_privs.append("domain_kms_admin")   # to set the root domain's cdmi_domain_kms (its KMS scope)
        grant("/cdmi_domains/", "storage-admins", admin_privs)
        grant("/cdmi_domains/orchestration/", "orchestrators", ["cross_domain"])
        # (agents need no grant; bob is an ordinary principal of /cdmi_domains/agents/.)
        lines.append("# This server holds the homes of that domain, each made on its owner's first request.")
        lines.append("[home_server]")
        lines += toml_table([("container", "/home/"), ("domain", "/cdmi_domains/"), ("provision", True)])
        lines.append("")
        # The pipe relay (RELAY draft 2): cvwm's ssh, nc and cdmi-scp reach a TCP host through a pipe, and seedmi
        # refuses a destination no [[pipe_permit]] admits ("not permitted through this pipe"). Enabled here for the
        # setup host on the SSH port, so `ssh <host>` from an xterm works; widen hosts/ports/addresses as needed.
        lines.append("[pipes]")
        lines += toml_table([("enabled", True)])
        lines.append("")
        lines.append("# Permit SSH to the setup host itself. addresses lists the ranges a resolved name must fall in;")
        lines.append("# the loopback and private ranges cover a .local host that resolves to a LAN or loopback address.")
        lines.append("[[pipe_permit]]")
        lines += toml_table([
            ("name", "ssh"),
            ("hosts", [self.host]),
            ("ports", [22]),
            ("addresses", ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"]),
        ])
        # --- KMS: seedmi reaches it over KMIP; its [[kms]] table names the label a domain's cdmi_domain_kms uses.
        if self.with_kms:
            lines.append("")
            lines.append("# The key management server, reached over KMIP. A domain claims it by its cdmi_domain_kms item,")
            lines.append("# naming this label; the DAC identity's keys live at it (see [dac]).")
            lines.append("[[kms]]")
            lines.extend(toml_table([
                ("label", self.kms_label),
                ("kind", "kmip"),
                ("host", "127.0.0.1"),
                ("port", self.kms_port),
                ("ca_file", os.path.join(pki, "kms-ca.crt")),
                ("certificate_file", os.path.join(pki, "kms-client.crt")),
                ("key_file", os.path.join(pki, "kms-client.key")),
            ]))
        # --- DAC: seedmi's delegated-access-control identity, its two keys held at the KMS above.
        if self.with_dac:
            lines.append("")
            lines.append("# Delegated access control: seedmi refers a decision, for an object carrying cdmi_dac_uri and")
            lines.append("# cdmi_dac_certificate, to the provider at the URI below. seedmi's own signing and unwrapping keys")
            lines.append("# are held at the KMS (by the ids below) and operated there; seedmi holds neither.")
            lines.append("[[permit]]")
            lines.extend(toml_table([
                ("uri", "https://%s:%d/" % (self.host, self.dac_port)),
                ("addresses", ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"]),
            ]))
            lines.append("")
            lines.append("[dac]")
            lines.extend(toml_table([
                ("signing_key_id", self.dac_sign_id),      # bare; seedmi prepends the root domain's scope (cdmi_domain_kms)
                ("encryption_key_id", self.dac_enc_id),
                ("ca_file", os.path.join(pki, "dac-ca.crt")),
            ]))

        # The built-in authorization server (0.88) mints the tokens the MCP endpoint accepts. It authenticates against
        # seedmi's own [[user]] list, and a token it issues names that user as its subject VERBATIM -- seedmi does not
        # realm-qualify a token subject. Our principals are controller-resolved and realm-qualified (bob@REALM), and the
        # ACLs and ownership use that form, so the [[user]] names and groups here are the realm-qualified ones, so the
        # token's subject and groups match. seedmi warns these users cannot authenticate a CDMI request directly (the
        # domain is controller-served) -- which is true and harmless: they exist only to shape the token.
        def qual(name): return name + "@" + self.realm
        for uname, ugroups in (("alice", ["storage-admins"]), ("mallory", ["orchestrators"]), ("bob", ["agents"])):
            lines.append("[[user]]")
            lines.extend(toml_table([
                ("name", qual(uname)),
                ("password", uname),
                ("groups", [qual(g) for g in ugroups] + [qual("staff")]),
            ]))
            lines.append("")

        # A built-in authorization server so the MCP endpoint can be reached without an external IdP. With no key it
        # generates an RS256 pair at startup and publishes the public half as a JWK Set, which is how the MCP endpoint
        # verifies a token (0.88). server_base_uri is the issuer, and the MCP protected-resource metadata advertises it.
        # audience is the CDMI base URI; 0.88 also accepts the MCP uri as an audience, so a token the Inspector obtains
        # for the endpoint is accepted. A real deployment drops this and points [[domain_controller]] issuer at its IdP.
        lines.append("")
        lines.append("[oauth]")
        lines.extend(toml_table([
            ("server", True),
            ("server_port", self.oauth_port),
            ("server_base_uri", "https://%s:%d" % (self.host, self.oauth_port)),
            ("server_certificate", "binding"),   # present the binding cert -> the AS is https (RFC 8414/6749 want https)
            ("server_scopes", ["cdmi:read", "cdmi:write", "cdmi:admin"]),
            ("audience", self.base_uri),
            # CORS for the browser (0.93). The authorization server is a listener of its own, so its metadata, JWK Set and
            # token endpoint are all fetched cross-origin by a browser client (the MCP Inspector, and cvwm's mcpinspector
            # app). server_origins is the allow-list it answers a preflight and echoes an Access-Control-Allow-Origin for;
            # a dev AS whose clients are these tools answers any. "*" is safe here: the server authenticates by a header
            # (Bearer/Basic), never a cookie, so 0.93 echoes the specific origin and allows credentials rather than
            # emitting a bare "*". Narrow this to the Inspector/desktop origins for anything real.
            ("server_origins", ["*"]),
        ]))
        lines.append("")
        # The client the MCP Inspector authenticates as (client_credentials grant: a program with no user in front of
        # it). Its token acts as this user; the ACLs decide what it may do. Give the Inspector this id and secret.
        lines.append("[[oauth_client]]")
        lines.extend(toml_table([
            ("id", self.oauth_client_id),
            ("secret", self.oauth_client_secret),
            ("scopes", ["cdmi:read", "cdmi:write", "cdmi:admin"]),
            ("user", qual("bob")),
        ]))

        # CDMI over MCP (revision 347): a protocol binding on a listener of its own, on the hostname at port 8100.
        # Naming a [[certificate]] makes the endpoint https (USAGE.md), so it presents the binding certificate and its
        # uri is https://<host>:<port>/mcp, reported to clients in cdmi_mcp_uri. Tokens are accepted from the domains'
        # authorization servers; scopes_required is off for a dev setup.
        lines.append("")
        lines.append("[mcp]")
        lines.extend(toml_table([
            ("host", self.host),
            ("port", self.mcp_port),
            ("uri", "https://%s:%d/mcp" % (self.host, self.mcp_port)),
            ("certificate", "binding"),          # present a [[certificate]] -> the endpoint is https (USAGE.md)
            ("scopes_required", "false"),
            # origins is the endpoint's browser allow-list, used for two things. 0.90 validates the Origin header and
            # refuses one it does not answer (a DNS-rebinding guard). 0.93 additionally answers the OPTIONS preflight and
            # emits CORS headers off this same list, so a browser client (the MCP Inspector, and cvwm's mcpinspector app)
            # can call the endpoint cross-origin at all. A dev endpoint whose client is the Inspector answers any origin;
            # the bearer token still protects it, and 0.93 echoes the specific origin with credentials rather than a bare
            # "*". Narrow this to the Inspector/desktop origins for anything real.
            ("origins", ["*"]),
        ]))
        # Service discovery (ECR-224A). doh = true makes seedmi accept and report the cdmi_domain_doh domain item, so
        # servers can read it (and a client may set it). When a resolver is given, seedmi also publishes the item
        # onto the root domain at startup (resolver + browse_domains), which is the bootstrap a client reads first.
        lines.append("")
        lines.append("[discovery]")
        disc = [("doh", True)]
        if self.doh_resolver:
            disc.append(("resolver", self.doh_resolver))
            disc.append(("browse_domains", self.browse_domains))
        lines.extend(toml_table(disc))
        if not self.doh_resolver:
            lines.append("# No resolver configured, so no cdmi_domain_doh is auto-published; a client sets one, or pass")
            lines.append("# --doh-resolver to this script. Browsing domains a client would search: %s." % ", ".join(self.browse_domains))

        # Service-level data system metadata (0.113). The provided items report what this deployment achieves for the
        # service-level family; the architectural items (one copy, one infrastructure, no dispersion) and the measured
        # ones (latency, throughput at startup) need no configuration, so only the non-architectural, non-measurable
        # items appear here: the storage regions and the recovery objectives. Each provided item is reported only where
        # an object requests the corresponding item, so this does not add metadata to every object. regions additionally
        # turns on cdmi_geographic_placement evaluation, so a placement that permits none of these locations is refused.
        sl = []
        if self.service_regions is not None:
            sl.append(("regions", self.service_regions))
        if self.rpo is not None:
            sl.append(("rpo", self.rpo))
        if self.rto is not None:
            sl.append(("rto", self.rto))
        if sl:
            lines.append("")
            lines.append("[service_level]")
            lines.extend(toml_table(sl))
            if self.service_regions is None:
                lines.append("# No regions configured: cdmi_geographic_placement is validated but not evaluated (this")
                lines.append("# server does not claim to know where it is), and no cdmi_geographic_placement_provided is")
                lines.append("# reported. Pass --regions (e.g. CA-BC,US-CA) to name the locations objects are kept in.")

        self._write(os.path.join(self.run, "seedmi.toml"), lines)
        extras = ["MCP on %d" % self.mcp_port]
        if self.with_kms: extras.append("KMS on %d" % self.kms_port)
        if self.with_dac: extras.append("DAC on %d" % self.dac_port)
        if self.service_regions is not None: extras.append("regions %s" % ",".join(self.service_regions))
        if self.rpo is not None or self.rto is not None: extras.append("service level (RPO/RTO)")
        OUT.did("wrote %s (binding on %d; discovery tree on; home server on%s)" % (
            os.path.join(self.run, "seedmi.toml"), self.https_port, ("; " + ", ".join(extras)) if extras else ""))

    def _write(self, path, lines):
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def _check_dc_config(self, path):
        """Confirm the [listen] fields whose absence makes dcd fail confusingly at startup. A minimal scan, not a full
        TOML parse, so it runs on any Python (tomllib is 3.11+ and the target host may be older). It reads the keys of
        the [listen] table this script wrote, which are plain `key = value` lines."""
        listen = self._read_toml_table(path, "listen")
        if listen is None:
            raise SetupError("the controller config `%s` has no [listen] table." % path)
        missing = [k for k in ("port", "ldap_port", "certificate_file", "key_file") if k not in listen]
        if missing:
            raise SetupError(
                "the controller config `%s` is missing %s in its [listen] table." % (path, ", ".join("`%s`" % m for m in missing)),
                extra_lines=["Without ldap_port the controller binds no LDAP port and seedmi's principal lookups never connect."])
        for key in ("certificate_file", "key_file"):
            value = listen[key].strip().strip('"')
            if not os.path.isfile(value):
                raise SetupError("the controller's %s `%s` does not exist." % (key, value))

    def _read_toml_table(self, path, table):
        """The `key = value` entries of one top-level table in a simple generated TOML file, as a dict of raw strings;
        None if the table is absent. Handles the flat, comment-and-blank-line form this script emits (no nesting,
        no multi-line values), which is all that is needed to check the fields dcd requires."""
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except OSError as e:
            raise SetupError("the controller config `%s` cannot be read: %s" % (path, e))
        out = None
        for raw in lines:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                name = line[1:-1].strip()
                if name == table:
                    out = {}         # entered the table
                elif out is not None:
                    break            # left it at the next table header
                continue
            if out is not None and "=" in line:
                key, _, value = line.partition("=")
                out[key.strip()] = value.strip()
        return out

    # -- phase 5: start servers --------------------------------------------
    def _start(self, name, cwd, argv):
        # start_new_session puts the child in its own process group, so stop.sh (and teardown) can signal the group;
        # killing the pid alone leaves node's children running.
        out = open(os.path.join(self.run, name + ".out"), "w")
        proc = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True)
        self.pids.append(proc.pid)
        self.procs.append(proc)
        self.launches.append((name, list(argv)))
        return proc

    def _start_optional(self, name, cwd, argv, what, hints=None):
        """Start a best-effort daemon (the mDNS responder, the zone publisher). Its absence must not fail the run:
        multicast needs a link a container may not have, and port 5353 may be held. So a start that dies at once is a
        warning with its log tail, not a SetupError, and the setup continues."""
        OUT.note("starting %s ..." % what)
        proc = self._start(name, cwd, argv)
        time.sleep(0.6)
        if proc.poll() is not None:
            tail = self._tail(os.path.join(self.run, name + ".out"), 8)
            OUT.warn("%s exited at startup (status %s); the setup continues without it." % (what, proc.poll()))
            for h in (hints or []):
                OUT.note(h)
            if tail:
                OUT.note("last lines of `%s`:" % os.path.join(self.run, name + ".out"))
                for l in tail:
                    OUT.line("    " + l)
            return None
        OUT.did("%s is running (pid %d)" % (what, proc.pid))
        return proc

    def _write_mdns_config(self):
        """seedmi-mdns advertises this server on the local link as one _cdmi._tcp instance. The SRV target is this
        host's own (publicly resolvable) name, which carries the binding certificate, so a browser that discovers it
        connects over ordinary TLS; the liveness check polls the well-known tree and verifies that same certificate."""
        pki = self.pki
        lines = [
            "# generated by setup-cvwm.py for %s" % self.host,
            "[link]",
        ]
        lines += toml_table([("ipv6", True)])
        lines.append("")
        lines.append("# One CDMI server on this host. The target is this host's own name (not a .local alias), so the")
        lines.append("# certificate a browser will check is the one this server presents; the check verifies it too.")
        lines.append("[[instance]]")
        lines += toml_table([
            ("name", "seedmi %s" % self.host),
            ("domain", "local"),
            ("target", self.host),
            ("port", self.https_port),
            ("ver", ["CDMIv3.0"]),
            ("display", "seedmi on %s" % self.host),
            ("check", True),
            ("check_ca_file", os.path.join(pki, "binding.crt")),   # the self-signed binding cert is its own anchor
            ("check_interval_ms", 30000),
        ])
        lines.append("")
        lines.append("[log]")
        lines += toml_table([("level", "problems"), ("file", os.path.join(self.run, "mdns.log"))])
        self._write(os.path.join(self.run, "mdns.toml"), lines)

    def _write_zone_config(self):
        """seedmi-zone browses the link ('local') and republishes CDMI servers it hears into a real DNS zone subtree,
        so an ordinary DoH resolver can answer for them. It needs a name server to write to: an Unbound via
        unbound-control (the default), or a BIND/Knot/PowerDNS via RFC 2136 dynamic update (--zone-update)."""
        pki = self.pki
        lines = [
            "# generated by setup-cvwm.py for %s" % self.host,
            "[link]",
        ]
        lines += toml_table([("ipv6", True), ("browse", ["local"])])
        lines.append("")
        lines.append("[zone]")
        lines += toml_table([
            ("name", self.zone_name),
            ("ttl_host", 120),
            ("ttl_other", 300),
            ("sweep_interval_ms", 60000),
            ("ca_file", os.path.join(pki, "binding.crt")),   # the gate verifies a discovered host's cert against this
        ])
        lines.append("")
        if self.zone_update:
            # host:port:key_name:key_algorithm:key_secret_file  -> an RFC 2136 dynamic update signed with TSIG.
            parts = self.zone_update.split(":")
            if len(parts) != 5:
                raise SetupError("--zone-update is host:port:key_name:key_algorithm:key_secret_file "
                                 "(e.g. ns1.example.com:53:seedmi-zone:hmac-sha256:/path/to/tsig.key)")
            uh, up, kn, ka, kf = parts
            lines.append("# RFC 2136 dynamic update, signed with TSIG (BIND, Knot, PowerDNS).")
            lines.append("[update]")
            lines += toml_table([("host", uh), ("port", int(up)), ("key_name", kn),
                                 ("key_algorithm", ka), ("key_secret_file", kf)])
        else:
            lines.append("# Records injected into a running Unbound via unbound-control -- the tight fit where Unbound is")
            lines.append("# also the DoH server the browser talks to. Requires unbound-control on PATH and a running Unbound.")
            lines.append("[unbound]")
            lines += toml_table([("command", "unbound-control")])
        lines.append("")
        lines.append("[log]")
        lines += toml_table([("level", "problems"), ("file", os.path.join(self.run, "zone.log"))])
        self._write(os.path.join(self.run, "zone.toml"), lines)

    def phase_kms(self):
        """Start seedmi-kms (KMIP) and, when DAC is enabled, create the two DAC identity key pairs at it. Runs before
        seedmi, which connects to the KMS at startup for its [[kms]] table."""
        OUT.phase("Start the key management server and create the DAC identity keys")
        # kms.toml: the server's listener, store, and the one shared prefix binding keys use. The DAC keys are claimed
        # under cdmi/root/ by the seedmi client on first registration (no admit rule needed for a fresh store).
        kms_store = os.path.join(self.run, "kms-data")
        lines = [
            "# generated by setup-cvwm.py for %s" % self.host,
            "[server]",
        ]
        lines.extend(toml_table([
            ("host", "127.0.0.1"), ("port", self.kms_port),
            ("cert_file", os.path.join(self.pki, "kms-server.crt")),
            ("key_file", os.path.join(self.pki, "kms-server.key")),
            ("ca_file", os.path.join(self.pki, "kms-ca.crt")),
            ("vendor", "seedmi-kms"),
        ]))
        lines += ["", "[store]"] + toml_table([("path", kms_store)])
        lines += ["", "[log]"] + toml_table([("level", "requests"), ("file", os.path.join(self.run, "kms.log"))])
        lines += ["", "[[shared]]"] + toml_table([("prefix", "cdmi_binding/")])
        lines += ["", "[[admit]]"] + toml_table([("prefix", "cdmi_binding/"), ("identity", "*"), ("degree", "use")])
        self._write(os.path.join(self.run, "kms.toml"), lines)

        OUT.note("starting seedmi-kms on 127.0.0.1:%d ..." % self.kms_port)
        kms = self._start("kms", self.run, ["node", os.path.join(self.kms_dir, "src", "kmsd.ts"),
                                                "--config", os.path.join(self.run, "kms.toml")])
        time.sleep(0.5); self._alive("kms", kms)
        self._wait_port("kms", kms, "127.0.0.1", self.kms_port, "KMIP port")
        OUT.did("seedmi-kms is running and its KMIP port is open")

        if self.with_dac:
            OUT.note("creating the DAC identity key pairs (%s, %s) at the KMS ..." % (self.dac_sign_key, self.dac_enc_key))
            out = run_cmd(["node", os.path.join(HERE_TOOLS, "kms-make-dac-keys.mjs"),
                           "--seedmi", self.seedmi_dir, "--host", "127.0.0.1", "--port", str(self.kms_port),
                           "--label", self.kms_label,
                           "--ca", os.path.join(self.pki, "kms-ca.crt"),
                           "--cert", os.path.join(self.pki, "kms-client.crt"),
                           "--key", os.path.join(self.pki, "kms-client.key"),
                           "--sign-id", self.dac_sign_key, "--enc-id", self.dac_enc_key,
                           "--out-sign-pub", os.path.join(self.pki, "dac-seedmi-sign.pub")],
                          cwd=self.run, capture=True)
            OUT.did("created the DAC signing and unwrapping keys at the KMS")

    def phase_dac(self):
        """Start seedmi-dac (the delegated-access-control provider). Runs after seedmi is up, since it decides for the
        objects seedmi refers to it; its own trust of seedmi is by the CA below."""
        OUT.phase("Start the delegated access control provider")
        lines = [
            "# generated by setup-cvwm.py for %s" % self.host,
            "[listen]",
        ]
        lines.extend(toml_table([
            ("host", "0.0.0.0"), ("port", self.dac_port), ("path", self.dac_path),
            ("certificate_file", os.path.join(self.pki, "dac-https.crt")),
            ("key_file", os.path.join(self.pki, "dac-https.key")),
        ]))
        lines += ["", "[provider]"]
        lines.extend(toml_table([
            ("decryption_key_file", os.path.join(self.pki, "dac-provider.key")),
            ("certificate_file", os.path.join(self.pki, "dac-provider.crt")),
            ("signing_key_file", os.path.join(self.pki, "dac-signing.key")),
            ("signing_chain_file", os.path.join(self.pki, "dac-signing.crt")),
            ("replay_window_ms", 600000),
        ]))
        # Answer seedmi: it signs each request with its DAC signing key (held at the KMS), so the provider authenticates
        # it by that key's registered public half -- key_file, not a certificate CA. response_ca_file lets the provider
        # trust seedmi's binding certificate when it delivers a deferred response to seedmi's response endpoint.
        lines += ["", "# Evaluate requests from this seedmi, authenticated by its registered DAC signing key."]
        lines += ["[[server]]"]
        lines.extend(toml_table([
            ("name", "seedmi"),
            ("key_file", os.path.join(self.pki, "dac-seedmi-sign.pub")),
            ("response_uris", [self.base_uri + "cdmi_dac_response"]),
            ("response_ca_file", os.path.join(self.pki, "binding.crt")),
        ]))
        # A permissive default rule set for a development provider: deny deletes, otherwise grant.
        lines += ["", "# Development rules: refuse deletes, allow the rest. Tighten for anything real."]
        lines += ["[[rule]]"] + toml_table([("operations", ["cdmi_delete"]), ("decision", "deny")])
        lines += ["", "[[rule]]"] + toml_table([("decision", "grant"), ("mask", "ALL_PERMS")])
        # seedmi-dac 0.88: the log is JSON Lines and has no other form, so [log] no longer takes "format"; level and file only.
        lines += ["", "[log]"] + toml_table([("level", "requests"), ("file", os.path.join(self.run, "dac.log"))])
        self._write(os.path.join(self.run, "dac.toml"), lines)

        OUT.note("starting seedmi-dac on %s:%d ..." % (self.host, self.dac_port))
        dac = self._start("dac", self.run, ["node", os.path.join(self.dac_dir, "src", "dacd.ts"),
                                                "--config", os.path.join(self.run, "dac.toml")])
        time.sleep(0.5); self._alive("dac", dac)
        self._wait_port("dac", dac, self.host, self.dac_port, "provider HTTPS port")
        OUT.did("seedmi-dac is running and its HTTPS port is open at https://%s:%d%s" % (self.host, self.dac_port, self.dac_path))

    def phase_start(self):
        OUT.phase("Start the domain controller and seedmi, check each is alive and serving the right certificate")

        # ---- the domain controller ----
        OUT.note("starting the domain controller ...")
        dc_main = os.path.join(self.dc_dir, "src", "dcd.ts")
        if not os.path.isfile(dc_main):
            ts = sorted(f for f in os.listdir(os.path.join(self.dc_dir, "src")) if f.endswith(".ts"))
            if not ts:
                raise SetupError("no controller entry point under `%s`" % os.path.join(self.dc_dir, "src"))
            dc_main = os.path.join(self.dc_dir, "src", ts[0])
        dc = self._start("dc", self.run, ["node", dc_main, "--config", os.path.join(self.run, "dc.toml")])
        # A process that dies at startup is caught at once, with its log, rather than surfacing as a puzzling failure
        # three phases later. The most common causes are a missing entry in [listen] (e.g. no ldap_port) or a bad cert.
        time.sleep(0.5)
        self._alive("dc", dc)
        OUT.note("waiting for the controller's LDAP port (127.0.0.1:%d) ..." % self.dc_ldap_port)
        self._wait_port("dc", dc, "127.0.0.1", self.dc_ldap_port, "LDAP port")
        OUT.note("waiting for the controller's HTTPS port (127.0.0.1:%d) ..." % self.dc_https_port)
        self._wait_port("dc", dc, "127.0.0.1", self.dc_https_port, "HTTPS port")
        # The controller serves TLS on its HTTPS port with the certificate this script generated for it.
        self._check_cert("controller", "127.0.0.1", self.dc_https_port, self.host, server_hostname=self.host)
        OUT.did("the root domain controller is running, its LDAP and HTTPS ports are open, and its certificate names `%s`" % self.host)

        # ---- the sub-domain controllers ----
        # One controller per sub-domain, each serving only that sub-domain's members. seedmi resolves a request under
        # a sub-domain's principals here, so a non-member does not resolve and is not a principal of that domain.
        for sd in self.subdomains:
            OUT.note("starting the %s controller (members: %s) ..." % (sd["name"], ", ".join(sd["members"])))
            proc = self._start("dc-" + sd["name"], self.run, ["node", dc_main, "--config", os.path.join(self.run, "dc-%s.toml" % sd["name"])])
            time.sleep(0.3)
            self._alive("dc-" + sd["name"], proc)
            OUT.note("waiting for the %s controller's LDAP port (127.0.0.1:%d) ..." % (sd["name"], sd["ldap_port"]))
            self._wait_port("dc-" + sd["name"], proc, "127.0.0.1", sd["ldap_port"], "LDAP port")
        OUT.did("the sub-domain controllers are running (%s), each serving only its members" %
                "; ".join("%s: %s" % (sd["name"], ", ".join(sd["members"])) for sd in self.subdomains))

        # ---- seedmi ----
        OUT.note("starting seedmi ...")
        se = self._start("seedmi", self.run,
                         ["node", os.path.join(self.seedmi_dir, "src", "main.ts"),
                          "--config", os.path.join(self.run, "seedmi.toml"), "--log", "requests"])
        time.sleep(0.5)
        self._alive("seedmi", se)
        OUT.note("waiting for seedmi's binding port (%s:%d) ..." % (self.host, self.https_port))
        self._wait_port("seedmi", se, self.host, self.https_port, "binding port")
        # The binding certificate's SAN must be the hostname: the export origin rejects a mismatch, and cvwm only
        # mounts a same-origin base URI, so a wrong SAN here is a silent dead end later.
        self._check_cert("seedmi binding", self.host, self.https_port, self.host, server_hostname=self.host)
        OUT.note("waiting for the seedmi binding to answer a CDMI request ...")
        for i in range(1, 31):
            self._alive("seedmi", se)
            status, _ = http_request("GET", self.base_uri, timeout=2)
            if status:
                break
            time.sleep(1)
            if i == 30:
                tail = self._tail(os.path.join(self.run, "seedmi.out"), 8)
                raise SetupError(
                    "seedmi's binding is open but did not answer a CDMI request at %s within 30s. Last lines of `%s`:" % (self.base_uri, os.path.join(self.run, "seedmi.out")),
                    extra_lines=["```"] + tail + ["```"])
        OUT.did("seedmi is running, its binding serves a certificate for `%s`, and it answers CDMI at %s" % (self.host, self.base_uri))

        # ---- service discovery: the mDNS responder, or the zone publisher (they cannot share port 5353) ----
        if self.with_mdns:
            self._write_mdns_config()
            self._start_optional(
                "mdns", self.run, ["node", os.path.join(self.mdns_dir, "src", "mdnsd.ts"), "--config", os.path.join(self.run, "mdns.toml")],
                "the mDNS responder (advertises _cdmi._tcp on the local link)",
                hints=["Port 5353 may be held (avahi-daemon, or another responder), or this host may have no multicast link",
                       "(a container does not). Stop the other responder, or run with --no-mdns."])
        if self.with_zone:
            self._write_zone_config()
            self._start_optional(
                "zone", self.run, ["node", os.path.join(self.zone_dir, "src", "zoned.ts"), "--config", os.path.join(self.run, "zone.toml")],
                "the zone publisher (republishes _cdmi._tcp.local into %s)" % self.zone_name,
                hints=["It needs a name server to write to: a running Unbound with unbound-control on PATH (the default),",
                       "or a BIND/Knot/PowerDNS reached by --zone-update host:port:key_name:key_algorithm:key_secret_file."])

    def _tail(self, path, n):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                return f.read().splitlines()[-n:]
        except OSError:
            return []

    def _alive(self, name, proc):
        """Raise if a just-started process has already exited, quoting the tail of its log so the cause is visible."""
        code = proc.poll()
        if code is not None:
            tail = self._tail(os.path.join(self.run, name + ".out"), 12)
            raise SetupError(
                "%s exited at startup (status %d). Last lines of `%s`:" % (name, code, os.path.join(self.run, name + ".out")),
                extra_lines=["```"] + tail + ["```"])

    def _wait_port(self, name, proc, host, port, what, timeout=30):
        """Wait until (host, port) accepts a TCP connection, checking the process stays alive; raise on timeout/exit."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            self._alive(name, proc)
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1)
            try:
                s.connect((host, port))
                return
            except OSError:
                time.sleep(0.5)
            finally:
                s.close()
        self._alive(name, proc)   # one last check: it may have died right at the deadline
        tail = self._tail(os.path.join(self.run, name + ".out"), 12)
        raise SetupError(
            "%s did not open its %s at %s:%d within %ds. Last lines of `%s`:" % (name, what, host, port, timeout, os.path.join(self.run, name + ".out")),
            extra_lines=["```"] + tail + ["```"])

    def _peer_cert(self, host, port, server_hostname=None):
        """The certificate a TLS endpoint presents, as a dict (subject, SAN, notAfter), without verifying the chain."""
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        raw.settimeout(5)
        try:
            raw.connect((host, port))
            tls = ctx.wrap_socket(raw, server_hostname=server_hostname or host)
            try:
                # getpeercert() returns {} without CERT_REQUIRED, so read the DER and parse the essentials.
                der = tls.getpeercert(binary_form=True)
                return self._cert_fields(der)
            finally:
                tls.close()
        finally:
            try:
                raw.close()
            except OSError:
                pass

    def _cert_fields(self, der):
        """Subject CN and subjectAltName DNS/IP names from a DER certificate, via ssl's own decoder (no deps)."""
        try:
            pem = ssl.DER_cert_to_PEM_cert(der)
            # ssl._ssl._test_decode_cert needs a file; write to a temp path in the run dir.
            path = os.path.join(self.run, ".peercert.pem")
            with open(path, "w") as f:
                f.write(pem)
            try:
                d = ssl._ssl._test_decode_cert(path)
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
            cn = ""
            for rdn in d.get("subject", ()):
                for k, v in rdn:
                    if k == "commonName":
                        cn = v
            sans = [v for (k, v) in d.get("subjectAltName", ()) if k in ("DNS", "IP Address")]
            return {"cn": cn, "sans": sans, "notAfter": d.get("notAfter", "")}
        except Exception:
            return None

    def _check_cert(self, name, host, port, expect_name, server_hostname=None):
        """Fetch the endpoint's certificate and confirm it names expect_name (in CN or a SAN); report what it presents."""
        try:
            cert = self._peer_cert(host, port, server_hostname)
        except (ssl.SSLError, OSError) as e:
            raise SetupError("%s did not complete a TLS handshake at %s:%d: %s" % (name, host, port, e))
        if not cert:
            OUT.note("%s presents a certificate at %s:%d (details could not be decoded)" % (name, host, port))
            return
        names = ([cert["cn"]] if cert["cn"] else []) + cert["sans"]
        if expect_name and expect_name not in names:
            raise SetupError(
                "%s at %s:%d presents a certificate for %s, not `%s`." % (name, host, port, ", ".join("`%s`" % n for n in names) or "(no name)", expect_name),
                extra_lines=["The export origin and the certificate SAN must match the hostname; regenerate with the right SAN."])
        OUT.note("%s certificate ok: CN `%s`, SAN %s%s" % (
            name, cert["cn"] or "(none)",
            ", ".join("`%s`" % n for n in cert["sans"]) or "(none)",
            (", expires " + cert["notAfter"]) if cert["notAfter"] else ""))

    # -- phase 6: grant + diagnostic ---------------------------------------
    def _grant_read(self, uri):
        # From seedmi 0.70 an export evaluates each object's access list per request, so the read grant goes on the
        # BINDING ROOT (covering the export container and the whole app tree cvwm reads through the binding), and
        # BEFORE anything is installed (an inheritable entry covers only objects created after it). READ already
        # implies LIST_CONTAINER on this server; LIST_CONTAINER and EXECUTE are belt-and-braces.
        read_mask = "READ, LIST_CONTAINER, READ_METADATA, READ_ATTRIBUTES, EXECUTE"
        acl = {"metadata": {"cdmi_acl": [
            {"identifier": "OWNER@", "acetype": "ALLOW", "aceflags": "OBJECT_INHERIT, CONTAINER_INHERIT", "acemask": "ALL_PERMS"},
            {"identifier": "EVERYONE@", "acetype": "ALLOW", "aceflags": "OBJECT_INHERIT, CONTAINER_INHERIT", "acemask": read_mask},
            {"identifier": "EVERYONE@", "acetype": "ALLOW", "aceflags": "NO_FLAGS", "acemask": read_mask},
        ]}}
        status, _ = http_request("PATCH", uri, user=self.setup_user, password=self.setup_pass,
                                 content_type="application/cdmi-container", body=json.dumps(acl))
        return status

    def _create_home_container(self, uri):
        """Create the container the home server provisions homes in. Its list lets the domain's authenticated users
        add a subcontainer (their own home), inheritable so a home, once made, keeps its owner-only list."""
        add = "ADD_SUBCONTAINER, READ, LIST_CONTAINER, READ_METADATA, READ_ATTRIBUTES, EXECUTE"
        body = {"metadata": {"cdmi_acl": [
            {"identifier": "OWNER@", "acetype": "ALLOW", "aceflags": "OBJECT_INHERIT, CONTAINER_INHERIT", "acemask": "ALL_PERMS"},
            {"identifier": "AUTHENTICATED@", "acetype": "ALLOW", "aceflags": "NO_FLAGS", "acemask": add},
        ]}}
        status, _ = http_request("PUT", uri, user=self.setup_user, password=self.setup_pass,
                                 content_type="application/cdmi-container", body=json.dumps(body))
        return status

    def phase_grant(self):
        OUT.phase("Grant anonymous read, create the home container, and check the setup user")
        # Diagnostic: cdmi_domain_userinfo reports the requesting principal's groups and privileges, so this shows
        # whether the group qualification and the backup_operator grant landed.
        OUT.note("checking the setup user's resolved identity ...")
        # cdmi_domain_userinfo is a domain metadata item (seedmi 0.106+, ECR-226A): read it from the root
        # domain object's metadata. (Before 0.106 it was a reserved child read as an object; that child is gone,
        # and the old GET .../cdmi_domain_userinfo?value now 404s, which read as "lacks backup_operator".)
        status, text = http_request("GET", self.base_uri + "cdmi_domains/?metadata=cdmi_domain_userinfo",
                                    user=self.setup_user, password=self.setup_pass, accept="application/cdmi-domain")
        self._report_userinfo(status, text)

        OUT.note("granting anonymous read on the binding root (covers /desktop/ and the app tree) ...")
        code = self._grant_read(self.base_uri)
        OUT.note("PATCH `%s` -> HTTP %s" % (self.base_uri, code or "no response"))

        # The home server provisions each principal's home (/home/<name>/) inside the container it is configured for
        # (/home/), on that principal's first request -- but only where that container already exists. seedmi does
        # not create it, so without this the first home request answers 404 ("no object is addressed by /home/").
        # It admits AUTHENTICATED@ to add a subcontainer, so the domain's users' homes can be provisioned in it.
        OUT.note("creating the `/home/` container the home server provisions homes in ...")
        home_status = self._create_home_container(self.base_uri + "home/")
        OUT.note("PUT `%shome/` -> HTTP %s" % (self.base_uri, home_status or "no response"))
        if home_status not in (201, 202, 204):
            OUT.warn("creating `/home/` returned %s; home provisioning may 404 on first sign-in." % (home_status or "no response"))

        # The sub-domains must exist as domain objects for their [[group_privileges]] scopes to address anything.
        # seedmi does not create them; the setup user (backup_operator + cross_domain) does. cross_domain is what
        # lets a domain object be created whose domain differs from its parent's.
        for sub in ("orchestration", "agents"):
            uri = self.base_uri + "cdmi_domains/" + sub + "/"
            status = self._create_domain(uri)
            OUT.note("PUT `%s` -> HTTP %s" % (uri, status or "no response"))
            if status not in (201, 202, 204):
                OUT.warn("creating the `%s` domain returned %s; its privilege scope will not resolve." % (sub, status or "no response"))

        # When KMS is enabled, the root domain must declare its KMS scope so seedmi can resolve the DAC keys, whose
        # [dac] ids are bare and prefixed with this scope. Requires domain_kms_admin (granted to storage-admins above).
        if self.with_kms:
            claim = {"metadata": {"cdmi_domain_kms": {self.kms_label: {
                "endpoint": "kmip://127.0.0.1:%d" % self.kms_port, "scope": self.kms_scope}}}}
            kstatus, ktext = http_request("PATCH", self.base_uri + "cdmi_domains/",
                                          user=self.setup_user, password=self.setup_pass,
                                          content_type="application/cdmi-domain", body=json.dumps(claim))
            OUT.note("claim KMS scope `%s` on the root domain -> HTTP %s" % (self.kms_scope, kstatus or "no response"))
            if kstatus not in (200, 202, 204):
                OUT.warn("claiming the KMS scope returned %s; the DAC keys will not resolve until the root domain's "
                         "cdmi_domain_kms names label `%s` and scope `%s`." % (kstatus or "no response", self.kms_label, self.kms_scope))

        OUT.did("granted anonymous read, created `/home/` and the orchestration and agents sub-domains, and reported the setup user")

    def _create_domain(self, uri):
        """Create a domain object. It is enabled and admits its authenticated principals to read it."""
        body = {"metadata": {
            "cdmi_domain_enabled": "true",
            "cdmi_acl": [
                {"identifier": "OWNER@", "acetype": "ALLOW", "aceflags": "OBJECT_INHERIT, CONTAINER_INHERIT", "acemask": "ALL_PERMS"},
                {"identifier": "AUTHENTICATED@", "acetype": "ALLOW", "aceflags": "NO_FLAGS", "acemask": "READ, READ_METADATA, LIST_CONTAINER, READ_ATTRIBUTES"},
            ],
        }}
        status, _ = http_request("PUT", uri, user=self.setup_user, password=self.setup_pass,
                                 content_type="application/cdmi-domain", body=json.dumps(body))
        return status

    def _report_userinfo(self, status, text):
        if not status:
            OUT.note("userinfo unavailable (the binding did not answer)")
            return
        if status != 200:
            OUT.note("userinfo unavailable (HTTP %s reading the domain object)" % status)
            return
        try:
            doc = json.loads(text)
            # 0.106+: the userinfo is a metadata item of the domain object. Fall back to the old
            # object `value` shape so an older server still reports.
            value = (doc.get("metadata") or {}).get("cdmi_domain_userinfo")
            if value is None:
                value = doc.get("value")
            if isinstance(value, str):
                value = json.loads(value)
            value = value or {}
        except (ValueError, TypeError, AttributeError) as e:
            OUT.note("could not read userinfo: %s" % e)
            return
        groups = value.get("groups") or []
        privs = value.get("privileges") or []
        OUT.note("identifier: `%s`" % value.get("identifier"))
        OUT.note("groups: %s" % (", ".join("`%s`" % g for g in groups) if groups else "(none)"))
        OUT.note("privileges: %s" % (", ".join("`%s`" % p for p in privs) if privs else "(none)"))
        if "backup_operator" not in privs:
            OUT.warn("the setup user lacks `backup_operator`; the group in `[[group_privileges]]` must match one of "
                     "the groups above exactly (the realm-qualified form). See SEEDMI-NOTES.md.")

    # -- phase 7: install + export -----------------------------------------
    def phase_install(self):
        OUT.phase("Install the cvwm desktop and activate its HTTP export")
        OUT.note("installing the cvwm desktop into /desktop/ ...")
        run_cmd([sys.executable, os.path.join(self.cvwm_dir, "install.py"), self.base_uri, "--no-verify",
                 "--basic", "%s:%s" % (self.setup_user, self.setup_pass), "--desktop", "desktop"],
                cwd=self.run, capture=True)

        OUT.note("activating the desktop export ...")
        export = {"exports": {"web": {
            "type": "HTTP",
            "origins": ["https://%s:%d" % (self.host, self.https_port)],
            "path": "/desktop/", "read_only": "true", "anonymous_read": "true",
        }}}
        export_status, _ = http_request("PATCH", self.base_uri + "desktop/",
                                        user=self.setup_user, password=self.setup_pass,
                                        content_type="application/cdmi-container", body=json.dumps(export))
        OUT.note("activate export `web` at /desktop/ -> HTTP %s" % (export_status or "no response"))

        # Confirm the desktop is served anonymously, as a browser will do. The status distinguishes the remedies:
        # 403 is an access-control miss (the grant did not reach the files); 404 is an addressing miss.
        desktop_status, _ = http_request("GET", self.desktop_url, timeout=5)
        if desktop_status == 200:
            OUT.note("the desktop is served (%s returns 200)" % self.desktop_url)
        elif desktop_status == 403:
            OUT.warn("the desktop answers 403: the read grant did not reach the installed files. An inheritable "
                     "entry covers only objects created after it, so the grant must precede the install. This should "
                     "not happen with this script (it grants first); if it does, remove `%s` and run again." % os.path.join(self.run, "data"))
        elif desktop_status == 404:
            OUT.warn("the desktop answers 404: either the export is not active (check that `%s` resolves and that the "
                     "origin in `%s` matches the URL above), or the export path overlaps the protocol binding (an "
                     "export at `/cdmi/...` is shadowed by the binding, so keep `/desktop/` clear of it)." % (self.host, os.path.join(self.run, "seedmi.toml")))
        else:
            OUT.warn("the desktop answered %s; check `%s`" % (desktop_status or "no response", os.path.join(self.run, "seedmi.out")))
        OUT.did("installed the desktop into /desktop/ and activated its export (status %s)" % (desktop_status or "no response"))

        if self.with_dac:
            self._write_dac_reference()

    def _write_dac_reference(self):
        """Write /dev/dac.txt: the DAC provider URI on the first line, then the provider certificate as a JWK -- the two
        values an object needs to be governed (cdmi_dac_uri and cdmi_dac_certificate). It is placed in the CDMI /dev/
        container (created by the install above) so it can be read from the desktop; 'Define DAC...' takes them from it."""
        provider_uri = "https://%s:%d%s" % (self.host, self.dac_port, self.dac_path)
        OUT.note("writing the DAC provider reference to /dev/dac.txt ...")
        # The certificate objects give (cdmi_dac_certificate) is the JWK the provider prints, not the PEM.
        out = run_cmd(["node", os.path.join(self.dac_dir, "src", "dacd.ts"),
                       "--config", os.path.join(self.run, "dac.toml"), "--certificate-jwk"],
                      cwd=self.run, capture=True)
        jwk = (out.stdout if hasattr(out, "stdout") else out) or ""
        if not jwk.strip():
            OUT.warn("could not obtain the DAC provider certificate (--certificate-jwk gave nothing); /dev/dac.txt not written")
            return
        body = provider_uri + "\n\n" + jwk.strip() + "\n"
        # Ensure /dev/ exists (install.py made it only if tests were installed), then PUT the object.
        http_request("PUT", self.base_uri + "dev/", user=self.setup_user, password=self.setup_pass,
                     content_type="application/cdmi-container", body=json.dumps({"metadata": {}}))
        status, _ = http_request("PUT", self.base_uri + "dev/dac.txt",
                                 user=self.setup_user, password=self.setup_pass,
                                 content_type="application/cdmi-object",
                                 body=json.dumps({"mimetype": "text/plain", "valuetransferencoding": "utf-8",
                                                  "metadata": {}, "value": body}))
        OUT.note("PUT `%sdev/dac.txt` -> HTTP %s" % (self.base_uri, status or "no response"))
        if status in (201, 202, 204):
            OUT.did("wrote /dev/dac.txt (provider URI %s, then its certificate JWK)" % provider_uri)
        else:
            OUT.warn("writing /dev/dac.txt returned %s" % (status or "no response"))

    # -- finish -------------------------------------------------------------
    def write_start_script(self):
        """Write run-<host>/start.sh: relaunch exactly the servers this run started, in the same order, from the
        configuration already in the run directory. It is for bringing the stack back up after a reboot or a stop.sh,
        without re-running setup (which would regenerate certificates, secrets and the data store). setup-cvwm.py
        remains the authoritative, health-checked path; start.sh is the plain convenience restart.

        Dependencies are honoured the way the setup honoured them: seedmi waits for the controller's ports, and the DAC
        provider waits for seedmi's binding, before each is launched. Each child is put in its own session (setsid) so
        stop.sh can signal the whole group, and its pid is recorded in run.pids so stop.sh can find a restarted stack."""
        import shlex
        path = os.path.join(self.run, "start.sh")
        # The port a dependency must be up on before the named server is launched.
        waits = {
            "seedmi": [("127.0.0.1", self.dc_ldap_port, "the domain controller's LDAP port"),
                       ("127.0.0.1", self.dc_https_port, "the domain controller's HTTPS port")],
            "dac":    [(self.host, self.https_port, "seedmi's binding")],
        }
        with open(path, "w", encoding="utf-8") as f:
            f.write("#!/usr/bin/env bash\n")
            f.write("# Start the servers for %s from the configuration in this directory.\n" % self.host)
            f.write("# Written by setup-cvwm.py; re-run setup to change the configuration. This only restarts it.\n")
            f.write("set -u\n")
            f.write('cd "$(dirname "$0")" || exit 1\n\n')
            f.write("wait_port() {  # host port label [timeout]\n")
            f.write("  local h=$1 p=$2 lbl=$3 t=${4:-30} i=0\n")
            f.write('  while ! (exec 3<>"/dev/tcp/$h/$p") 2>/dev/null; do\n')
            f.write('    i=$((i + 1)); if [ "$i" -ge "$t" ]; then echo "timed out waiting for $lbl ($h:$p)" >&2; return 1; fi\n')
            f.write("    sleep 1\n  done\n")
            f.write("  exec 3>&- 2>/dev/null || true\n}\n\n")
            f.write("launch() {  # name -- argv...\n")
            f.write('  local name=$1; shift\n')
            f.write('  echo "starting $name ..."\n')
            f.write('  setsid "$@" >> "$name.out" 2>&1 &\n')
            f.write('  echo $! >> run.pids\n}\n\n')
            f.write(": > run.pids\n\n")
            for name, argv in self.launches:
                for h, p, lbl in waits.get(name, []):
                    f.write('wait_port %s %d %s || echo "  (continuing anyway)" >&2\n' % (shlex.quote(h), p, shlex.quote(lbl)))
                f.write("launch %s %s\n" % (shlex.quote(name), " ".join(shlex.quote(a) for a in argv)))
            f.write('\necho "started $(wc -l < run.pids) process(es); pids in run.pids. Stop with ./stop.sh"\n')
        os.chmod(path, 0o755)

    def write_stop_script(self):
        path = os.path.join(self.run, "stop.sh")
        with open(path, "w", encoding="utf-8") as f:
            f.write("#!/usr/bin/env bash\n")
            f.write("# stop the servers started by setup-cvwm.py (or by start.sh) for %s\n" % self.host)
            f.write('cd "$(dirname "$0")" 2>/dev/null || true\n')
            # A restart via start.sh records fresh pids in run.pids; prefer those so stop.sh follows a restarted stack.
            f.write('if [ -f run.pids ]; then\n')
            f.write('  while read -r pid; do [ -n "$pid" ] && { kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null; }; done < run.pids\n')
            f.write("else\n")
            for pid in self.pids:
                # negative pid signals the process group (start_new_session made each child a group leader)
                f.write("  kill -- -%d 2>/dev/null || kill %d 2>/dev/null\n" % (pid, pid))
            f.write("fi\n")
            f.write('echo "stopped."\n')
        os.chmod(path, 0o755)

    def summary(self):
        OUT.line()
        OUT.line()
        OUT.line("## Ready")
        OUT.line()
        OUT.line("- open: <%s>" % self.desktop_url)
        OUT.line("- CDMI over MCP: https://%s:%d/mcp (its own listener; reported to clients as cdmi_mcp_uri)" % (self.host, self.mcp_port))
        OUT.line("- NFS export server: %s:2049 (NFSv4.1); SMB export server: %s:445. SMB's 445 is a privileged port —" % (self.host, self.host))
        OUT.line("  bind it without root via `sudo sysctl net.ipv4.ip_unprivileged_port_start=445` before starting seedmi")
        OUT.line("  (persist it in /etc/sysctl.d/ to survive a reboot). NFS's 2049 is unprivileged and needs nothing.")
        OUT.line("")
        OUT.line("To use the desktop's own **mcpinspector** app (in the browser, no external Inspector): the MCP endpoint")
        OUT.line("and the authorization server are configured for CORS, but they are on their own ports, and a browser")
        OUT.line("accepts a self-signed certificate per origin (scheme+host+port). Accepting it for the desktop (:%d) does" % self.https_port)
        OUT.line("not cover :%d or :%d, so a cross-origin fetch to them fails until each is accepted. Once, in this browser," % (self.mcp_port, self.oauth_port))
        OUT.line("open each URL and click through the certificate warning, then open mcpinspector and Connect:")
        OUT.line("  - <https://%s:%d/>   (the MCP endpoint)" % (self.host, self.mcp_port))
        OUT.line("  - <https://%s:%d/>   (the authorization server)" % (self.host, self.oauth_port))
        OUT.line("A CA-issued certificate for the binding, or adding this run's CA to the OS/browser trust store, removes this step.")
        OUT.line("")
        OUT.line("To connect the external MCP Inspector to this server, fill its fields as follows (it uses the")
        OUT.line("client_credentials grant — a program with no user in front of it):")
        OUT.line("- MCP server URL (transport: Streamable HTTP): https://%s:%d/mcp" % (self.host, self.mcp_port))
        OUT.line("- Issuer / IdP URL: https://%s:%d  (the authorization server; the Inspector discovers /token and /jwks from its RFC 8414 metadata)" % (self.host, self.oauth_port))
        OUT.line("- Pre-configure OAuth credentials for servers requiring authentication: yes")
        OUT.line("- IdP Client ID (EMA legs 1–2) is the same value as Resource AS Client ID (EMA leg 3): this server is both the IdP and the resource's authorization server, so one [[oauth_client]] serves both.")
        OUT.line("- Resource AS Client ID: %s" % self.oauth_client_id)
        OUT.line("  The resource authorization server's registered client credential ([[oauth_client]] id) — not a user name, and not the app client id/secret, which belong in Client Settings.")
        OUT.line("- Resource AS Client Secret: %s" % self.oauth_client_secret)
        OUT.line("  The registered client secret ([[oauth_client]] secret) — not the app client id/secret, which belong in Client Settings.")
        OUT.line("- Scopes: cdmi:read cdmi:write cdmi:admin")
        OUT.line("  Space-separated OAuth scopes (RFC 6749). Do not use commas — a comma-separated entry is sent as one invalid token and rejected by the authorization server.")
        OUT.line("- the Inspector discovers the token endpoint from the endpoint's metadata; it needs no user login. The token acts as %s (the client's user), and the object ACLs decide what it may do." % (self.realm and ("bob@" + self.realm) or "bob"))
        OUT.line("")
        OUT.line("If the Inspector reports \"Version negotiation probe failed: fetch failed\", that is TLS trust, not auth: the")
        OUT.line("MCP endpoint (and the AS) present a self-signed development certificate, and the Inspector's Node backend")
        OUT.line("rejects an untrusted certificate before any request is sent (the connection is made by the Inspector's")
        OUT.line("Node proxy, not the browser, so it is that process that must trust the certificate). Give it this run's")
        OUT.line("certificate when starting it — with npx:")
        OUT.line("    NODE_EXTRA_CA_CERTS=%s npx @modelcontextprotocol/inspector" % os.path.join(self.pki, "binding.crt"))
        OUT.line("  or, running it from its repo with `npm run web`:")
        OUT.line("    NODE_EXTRA_CA_CERTS=%s npm run web" % os.path.join(self.pki, "binding.crt"))
        OUT.line("  If npm does not forward the variable to the proxy (some web scripts spawn it through a wrapper), export")
        OUT.line("  it in the shell first — export NODE_EXTRA_CA_CERTS=%s — then run `npm run web`, or add it to the server" % os.path.join(self.pki, "binding.crt"))
        OUT.line("  command in the package.json web script (with cross-env for portability). It is read once at Node startup,")
        OUT.line("  so set it before launching, not after.")
        OUT.line("  For a throwaway session only: NODE_TLS_REJECT_UNAUTHORIZED=0 (with npx or npm run web) disables all TLS")
        OUT.line("  checks. A CA-issued certificate for the binding removes the need for any of this.")
        OUT.line("- sign in with the full user@domain: `alice@%s`/`alice`, `mallory@%s`/`mallory`, or `bob@%s`/`bob` to get a Home disk" % (self.host, self.host, self.host))
        OUT.line("  (the login field is pre-filled with `@%s`; type your name before it. The controller resolves the account to `alice@%s`, which is what its ACLs and ownership use.)" % (self.host, self.realm))
        OUT.line("- roles: **alice** administers the domains (storage-admins: backup_operator, cross_domain, domain_auth_admin at the root); **mallory** holds cross_domain in `/cdmi_domains/orchestration/` only; **bob** is a principal of `/cdmi_domains/agents/` with no special privilege")
        OUT.line("- setup ran as `%s`, given `backup_operator` to write the tree (config, not a login you need)" % self.setup_user)
        OUT.line("- config and logs are in `%s/`; stop with `%s`, and restart later with `%s`" %
                 (self.run, os.path.join(self.run, "stop.sh"), os.path.join(self.run, "start.sh")))
        OUT.line("- this run was logged to `%s`" % self.runlog)
        OUT.line("")
        OUT.line("Service discovery (servers):")
        if self.doh_resolver:
            OUT.line("- seedmi offers `cdmi_domain_doh` and auto-published it on the root domain: resolver `%s`, browsing domains %s" %
                     (self.doh_resolver, ", ".join("`%s`" % d for d in self.browse_domains)))
        else:
            OUT.line("- seedmi offers `cdmi_domain_doh` (`[discovery] doh = true`); no resolver was configured, so nothing is auto-published.")
            OUT.line("  Pass `--doh-resolver https://<resolver>/dns-query` to publish the bootstrap, or type a resolver in servers.")
        if self.with_mdns:
            OUT.line("- seedmi-mdns advertises this server on the link as `_cdmi._tcp` instance `seedmi %s` (domain `local`, target `%s:%d`)." % (self.host, self.host, self.https_port))
            OUT.line("  A browser cannot query multicast DNS, so `local` is reachable to servers only through a DoH resolver that serves it (a Discovery Proxy, or `--zone`).")
        if self.with_zone:
            OUT.line("- seedmi-zone republishes `_cdmi._tcp.local` into `%s` (needs a running name server; see `%s`)." % (self.zone_name, os.path.join(self.run, "zone.toml")))
        elif not self.with_mdns:
            OUT.line("- neither responder is running (`--no-mdns` without `--zone`).")
        OUT.line("")
        OUT.line("Notes on the domain model:")
        OUT.line("- membership is scoped per sub-domain by giving each its OWN controller instance. The root controller")
        OUT.line("  (LDAP 127.0.0.1:%d) serves all three principals; the orchestration controller (%d) serves only" % (self.dc_ldap_port, self.subdomains[0]["ldap_port"]))
        OUT.line("  mallory and the agents controller (%d) only bob. All share this realm and LDAP base, so a principal" % self.subdomains[1]["ldap_port"])
        OUT.line("  keeps one identity (bob@%s everywhere); a principal absent from a sub-domain's controller does not" % self.realm)
        OUT.line("  resolve there and so is NOT a principal of that domain -- mallory is not a member of agents, nor bob")
        OUT.line("  of orchestration. What each group may DO where is set separately by `[[group_privileges]]`.")
        OUT.line("- sign-in and home provisioning are root-domain, so all three resolve at the root controller and get a")
        OUT.line("  Home disk; the sub-domain controllers are consulted only for objects belonging to their domains.")
        OUT.line("- basic-auth requests (cvwm's sign-in) are resolved by LDAP at the target object's domain controller, so")
        OUT.line("  this scoping applies to them. A bearer token, by contrast, carries its own principal and group claims,")
        OUT.line("  so token-based access is bounded by the token's claims and the issuer/audience, not by these directories.")
        OUT.line("- CDMI 3.0 (rev 354) defines no `cdmi_domain_members` and no domain-administrator metadata (Annex B marks the")
        OUT.line("  name reserved-but-undefined), so \"domain administrator\" is modelled by alice's privileges and ownership of")
        OUT.line("  the domain tree, not a member role on the domain object.")
        OUT.line("- To make a home actually land in a sub-domain (so an object bob creates belongs to `/cdmi_domains/agents/`),")
        OUT.line("  a per-domain `[home_server]`/home_base would be needed; this run holds all homes under the root domain.")
        if self.with_kms or self.with_dac:
            OUT.line("")
            OUT.line("Key management and delegated access control:")
        if self.with_kms:
            OUT.line("- seedmi-kms runs on KMIP 127.0.0.1:%d; seedmi reaches it via its [[kms]] table (label %s); store %s" % (self.kms_port, self.kms_label, os.path.join(self.run, 'kms-data')))
            OUT.line("- KMS activity is logged to %s; its startup and any crash output to %s" % (os.path.join(self.run, 'kms.log'), os.path.join(self.run, 'kms.out')))
            OUT.line("- to use it for a domain, set that domain's cdmi_domain_kms to name this label and a scope (needs domain_kms_admin, which alice holds)")
        if self.with_dac:
            OUT.line("- seedmi-dac runs on https://%s:%d%s; seedmi's [dac] names its two keys, held at the KMS (%s, %s)" % (self.host, self.dac_port, self.dac_path, self.dac_sign_key, self.dac_enc_key))
            OUT.line("- an object is governed only when it carries cdmi_dac_uri and cdmi_dac_certificate; the dev rules refuse cdmi_delete and grant the rest")
            OUT.line("- get the provider certificate with: node seedmi-dac/src/dacd.ts --config %s --certificate-jwk" % os.path.join(self.run, 'dac.toml'))
            OUT.line("- /dev/dac.txt holds the provider URI (first line) and its certificate (JWK) — the two values 'Define DAC…' needs")
            OUT.line("- DAC decisions and problems are logged to %s; its startup and any crash output to %s" % (os.path.join(self.run, 'dac.log'), os.path.join(self.run, 'dac.out')))

    # -- orchestration ------------------------------------------------------
    def kill_all(self):
        """Signal every started process group, so a failed run leaves nothing behind (node's children included)."""
        if not self.procs:
            return
        OUT.note("stopping the %d process(es) this run started ..." % len(self.procs))
        for proc in self.procs:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)   # the group (start_new_session made each a leader)
            except (ProcessLookupError, PermissionError):
                try:
                    proc.terminate()
                except ProcessLookupError:
                    pass
        # give them a moment, then SIGKILL any that remain
        deadline = time.time() + 5
        for proc in self.procs:
            remaining = max(0, deadline - time.time())
            try:
                proc.wait(timeout=remaining or 0.1)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass

    def check_ports_free(self):
        """Error out if a port this run needs is already in use — a sign a server is already running here."""
        busy = []
        checks = [("HTTPS", self.https_port), ("HTTP", self.http_port),
                  ("controller HTTPS", self.dc_https_port), ("controller LDAP", self.dc_ldap_port),
                  ("MCP", self.mcp_port), ("OAuth AS", self.oauth_port)]
        for sd in self.subdomains:
            checks.append(("%s controller HTTPS" % sd["name"], sd["https_port"]))
            checks.append(("%s controller LDAP" % sd["name"], sd["ldap_port"]))
        if self.with_kms: checks.append(("KMS", self.kms_port))
        if self.with_dac: checks.append(("DAC", self.dac_port))
        for label, port in checks:
            if self._port_in_use(port):
                busy.append("%s port %d" % (label, port))
        if busy:
            raise SetupError(
                "a process is already listening on %s." % ", ".join(busy),
                extra_lines=[
                    "",
                    "Another run may still be up. Stop it before starting a new one:",
                    "",
                    "```",
                    "%s" % os.path.join(self.run, "stop.sh"),
                    "```",
                    "",
                    "or change the ports with --port / --http-port. This script does not touch a process it did not start.",
                ])

    def _port_in_use(self, port):
        # A port is in use if something is already bound to it on loopback. IPv6 is checked only where available.
        families = [(socket.AF_INET, ("127.0.0.1", port))]
        if socket.has_ipv6:
            families.append((socket.AF_INET6, ("::1", port)))
        for family, addr in families:
            try:
                s = socket.socket(family, socket.SOCK_STREAM)
            except OSError:
                continue                 # this address family is not supported here
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    s.bind(addr)
                except OSError:
                    return True          # cannot bind: something is there
            finally:
                s.close()
        return False

    def run_all(self):
        self.check_prerequisites()
        self.check_store_absent()
        self.check_ports_free()
        self.start_runlog_and_header()
        self.phase_resolve()
        self.phase_certs()
        self.phase_dc_config()
        self.phase_seedmi_config()
        if self.with_kms:
            self.phase_kms()
        self.phase_start()
        if self.with_dac:
            self.phase_dac()
        self.phase_grant()
        self.phase_install()
        self.write_start_script()
        self.write_stop_script()
        self.summary()


def build_parser():
    p = argparse.ArgumentParser(
        prog="setup-cvwm.py",
        description="Stand up seedmi so cvwm runs against it, for a hostname that already resolves to this machine.")
    p.add_argument("host", help="the hostname (at least two labels; must resolve to this machine)")
    p.add_argument("--realm", help="Kerberos realm (default: the hostname, upper-cased, e.g. SNIA.LOCAL)")
    p.add_argument("--base-dn", dest="base_dn", help="LDAP base DN (default: derived from the hostname)")
    p.add_argument("--with-kms", action="store_true", help="start seedmi-kms and wire seedmi's [[kms]] table")
    p.add_argument("--with-dac", action="store_true", help="start seedmi-dac and wire seedmi's [dac] (implies --with-kms; the DAC identity keys are held at the KMS)")
    p.add_argument("--port", type=int, default=9443, help="HTTPS port (default 9443)")
    p.add_argument("--http-port", dest="http_port", type=int, default=9080, help="HTTP port (default 9080)")
    p.add_argument("--base", help="the workspace holding seedmi/, seedmi-dc/, etc. (default: found automatically — the current directory or cvwm/..)")
    p.add_argument("--seedmi", help="the seedmi tree (default: <base>/seedmi)")
    p.add_argument("--cvwm", help="the cvwm package (default: the cvwm/ this script lives in)")
    # Service discovery (ECR-224A). seedmi always offers the cdmi_domain_doh item (via [discovery] doh = true); a
    # resolver here also auto-publishes the bootstrap on the root domain. seedmi-mdns advertises this server on the
    # link and runs by default; seedmi-zone republishes into a real zone and is opt-in (--zone), and the two cannot
    # share the single multicast port 5353.
    p.add_argument("--doh-resolver", dest="doh_resolver", help="absolute https DoH resolver URL to publish in cdmi_domain_doh (e.g. https://resolver.example/dns-query); when given, seedmi auto-publishes the bootstrap on the root domain")
    p.add_argument("--browse-domains", dest="browse_domains", help="comma-separated browsing domains for cdmi_domain_doh (default: local; the --zone subtree is added automatically)")
    p.add_argument("--no-mdns", dest="no_mdns", action="store_true", help="do not start seedmi-mdns (the local-link _cdmi._tcp responder)")
    p.add_argument("--zone", action="store_true", help="also run seedmi-zone, which republishes _cdmi._tcp.local into a real DNS zone (opt-in; needs --zone-name and a name server; stands in for the responder, as both want port 5353)")
    p.add_argument("--zone-name", dest="zone_name", help="the DNS subtree seedmi-zone publishes into (e.g. lan.example.com); required with --zone and must differ from 'local'")
    p.add_argument("--zone-update", dest="zone_update", help="write the zone by RFC 2136 dynamic update instead of Unbound: host:port:key_name:key_algorithm:key_secret_file")
    # Service-level data system metadata (seedmi 0.113): [service_level] names what this deployment can achieve for the
    # items whose provided counterparts report it -- where it stores objects, and its recovery objectives.
    # Service-level data system metadata ([service_level]) is opt-in and off by default: seedmi's top-level config
    # whitelist does not list service_level (through 0.116 at least), so a config that carries the section fails to
    # start even though the server parses it. Passing any of these writes the section — use it only on a seedmi whose
    # whitelist accepts service_level.
    p.add_argument("--regions", dest="regions", help="comma-separated ISO 3166 codes for the storage locations this deployment keeps objects in (e.g. CA-BC,US-CA); enables cdmi_geographic_placement evaluation and cdmi_geographic_placement_provided. Writes [service_level] (see note)")
    p.add_argument("--rpo", dest="rpo", help="recovery point objective in seconds, reported as cdmi_RPO_provided. Writes [service_level] (see note)")
    p.add_argument("--rto", dest="rto", help="recovery time objective in seconds, reported as cdmi_RTO_provided. Writes [service_level] (see note)")
    return p


def main(argv):
    args = build_parser().parse_args(argv)
    setup = Setup(args)
    try:
        setup.run_all()
    except SetupError as e:
        OUT.error(e.message, e.extra_lines)
        setup.kill_all()
        OUT.close()
        return e.code
    except KeyboardInterrupt:
        OUT.error("interrupted")
        setup.kill_all()
        OUT.close()
        return 130
    except Exception as e:
        OUT.error("an unexpected error occurred: %s" % e)
        setup.kill_all()
        OUT.close()
        raise
    OUT.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
