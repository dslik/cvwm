#!/usr/bin/env python3
"""Generate a static CDMI tree that the unmodified cvwm desktop can browse
read-only, plus the Apache config to serve it. No changes to cvwm itself.

Layout rule reproduced by Apache:
  - a request ending in "/"  -> that directory's  index.cdmi   (DirectoryIndex)
  - every file is served as   application/json                 (ForceType)
  - the query string is ignored (ordinary static file serving)
  - the two bootstrap files (index.html, cvwm.js) keep their normal types
Each filesystem node is a JSON document holding the CDMI *representation* of
that node -- a container's index.cdmi lists its children as plain name strings;
an "object" file (readme.txt, logo.png, ...) holds {value, mimetype, ...} even
though it is named like the thing it represents.
"""
import base64, json, os, shutil, struct, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
PKG  = os.path.dirname(HERE)

# Positional args:  make-static-test.py [out-dir] [url-prefix]
# url-prefix (e.g. "/a") places the bootstrap page, cvwm.js and the data tree
# under that path. The CDMI discovery tree (/.well-known/cdmi/) ALWAYS stays at
# the origin root -- cvwm hardcodes that path -- but it points the "home"
# reference at <prefix>/home/, so everything except the mandated well-known docs
# lives under the subdirectory.  Default prefix "" = serve from the origin root.
OUT    = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', 'cvwm-static-test')
PREFIX = ('/' + sys.argv[2].strip('/')) if len(sys.argv) > 2 and sys.argv[2].strip('/') else ''
SITE   = os.path.join(OUT, 'site')
APPDIR = os.path.join(SITE, *PREFIX.strip('/').split('/')) if PREFIX else SITE   # where index.html/cvwm.js/home live
HOME_LOC = PREFIX + '/home/'                                                     # the base URI cvwm mounts

T_CONTAINER = 'application/cdmi-container'
T_OBJECT    = 'application/cdmi-object'
T_CAP       = 'application/cdmi-capability'

_oid = [0x100]
def oid():
    _oid[0] += 1
    return '0000706D%08X' % _oid[0]   # any stable hex id; cvwm does not validate the form for browsing

def wjson(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, indent=2)
        f.write('\n')

def container(fs_dir, object_name, parent_uri, children, meta=None):
    """Write <fs_dir>/index.cdmi for a container with plain-string children."""
    rep = {
        'objectType': T_CONTAINER,
        'objectID': oid(),
        'objectName': object_name,
        'parentURI': parent_uri,
        'capabilitiesURI': '/.well-known/cdmi/cdmi_capabilities/',
        'completionStatus': 'Complete',
        'metadata': meta or {},
        'childrenrange': ('0-%d' % (len(children) - 1)) if children else '0-0',
        'children': children,
    }
    wjson(os.path.join(fs_dir, 'index.cdmi'), rep)

def text_object(fs_path, object_name, parent_uri, mimetype, text, meta=None):
    rep = {
        'objectType': T_OBJECT,
        'objectID': oid(),
        'objectName': object_name,
        'parentURI': parent_uri,
        'capabilitiesURI': '/.well-known/cdmi/cdmi_capabilities/',
        'completionStatus': 'Complete',
        'mimetype': mimetype,
        'metadata': dict({'cdmi_size': str(len(text.encode('utf-8')))}, **(meta or {})),
        'valuetransferencoding': 'utf-8',
        'value': text,
    }
    wjson(fs_path, rep)

def binary_object(fs_path, object_name, parent_uri, mimetype, raw_bytes, meta=None):
    b64 = base64.b64encode(raw_bytes).decode('ascii')
    rep = {
        'objectType': T_OBJECT,
        'objectID': oid(),
        'objectName': object_name,
        'parentURI': parent_uri,
        'capabilitiesURI': '/.well-known/cdmi/cdmi_capabilities/',
        'completionStatus': 'Complete',
        'mimetype': mimetype,
        'metadata': dict({'cdmi_size': str(len(raw_bytes))}, **(meta or {})),
        'valuetransferencoding': 'base64',
        'value': b64,
    }
    wjson(fs_path, rep)

def png(w, h, rgb):
    """Minimal solid-colour PNG, no external libraries."""
    r, g, b = rgb
    row = b'\x00' + bytes([r, g, b]) * w
    raw = row * h
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)   # 8-bit truecolour
    idat = zlib.compress(raw, 9)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

# ---------------------------------------------------------------- build
if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(SITE)

# bootstrap page + a verbatim copy of the desktop (unchanged), under the prefix
os.makedirs(APPDIR, exist_ok=True)
shutil.copy2(os.path.join(PKG, 'cvwm.js'), os.path.join(APPDIR, 'cvwm.js'))
with open(os.path.join(APPDIR, 'index.html'), 'w') as f:
    f.write('<!doctype html>\n<html lang="en">\n<head>\n'
            '<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            '<title>cvwm</title>\n'
            '<style>html,body{margin:0;height:100%;background:#bfbfbf}</style>\n'
            '</head>\n<body>\n'
            # relative src: loads cvwm.js from the same directory as this page,
            # so the bootstrap works at the origin root or under any subdirectory.
            '<script src="cvwm.js"></script>\n</body>\n</html>\n')

# capabilities: advertise anonymous only -> cvwm skips the sign-in window
wjson(os.path.join(SITE, '.well-known', 'cdmi', 'cdmi_capabilities', 'index.cdmi'), {
    'objectType': T_CAP,
    'objectID': oid(),
    'objectName': 'cdmi_capabilities/',
    'parentURI': '/.well-known/cdmi/',
    'capabilities': {
        'cdmi_authentication_methods': ['anonymous'],
        'cdmi_domains': 'false',
        'cdmi_dataobjects': 'true',
        'cdmi_object_copy_from_local': 'false',
        'cdmi_object_move_from_local': 'false',
        'cdmi_list_children': 'true',
        'cdmi_read_value': 'true',
        'cdmi_read_metadata': 'true',
    },
    'childrenrange': '0-0',
    'children': [],
})

# discovery tree: EXTENDED [objectName, location] children so no 307 is needed.
# A reference named "home" auto-mounts as a disk for an anonymous client.
wjson(os.path.join(SITE, '.well-known', 'cdmi', 'cdmi_namespaces', 'index.cdmi'), {
    'objectType': T_CONTAINER,
    'objectID': oid(),
    'objectName': 'cdmi_namespaces/',
    'parentURI': '/.well-known/cdmi/',
    'childrenrange': '0-0',
    'children': [['home/', HOME_LOC]],       # location may point under a subdirectory
})

# ---- the home tree (lives under the url-prefix) -----------------------
home = os.path.join(APPDIR, 'home')
container(home, 'home/', '/',
          ['docs/', 'images/', 'readme.txt', 'welcome.md'])

text_object(os.path.join(home, 'readme.txt'), 'readme.txt', '/home/', 'text/plain',
    "cvwm read-only static demo\n"
    "==========================\n\n"
    "This whole desktop is being served by a plain web server from static\n"
    "JSON files -- no CDMI backend, GET requests only. You can browse the\n"
    "containers, open this text file, read the markdown note, and view the\n"
    "images. Writing, sign-in, and the home provisioning are all skipped,\n"
    "because the server advertises anonymous-only access.\n")

text_object(os.path.join(home, 'welcome.md'), 'welcome.md', '/home/', 'text/markdown',
    "# Welcome to cvwm (static mode)\n\n"
    "Everything here is a static `*.cdmi` / object file on disk. The desktop\n"
    "treats it as a CDMI 3.0 namespace because each file carries a valid\n"
    "representation and the server stamps `application/json` on all of them.\n\n"
    "- **Containers** are directories whose `index.cdmi` lists their children.\n"
    "- **Objects** are files whose JSON holds `value` + `mimetype`.\n"
    "- **Discovery** works through the extended `[name, location]` child form.\n\n"
    "Try opening the `images/` folder.\n")

# docs/
docs = os.path.join(home, 'docs')
container(docs, 'docs/', '/home/', ['cdmi-notes.md', 'layout.txt'])
text_object(os.path.join(docs, 'cdmi-notes.md'), 'cdmi-notes.md', '/home/docs/', 'text/markdown',
    "# How this maps to Apache\n\n"
    "| cvwm GET            | Apache serves                         |\n"
    "|---------------------|---------------------------------------|\n"
    "| `/home/`            | `/home/index.cdmi` (DirectoryIndex)   |\n"
    "| `/home/readme.txt`  | the file, forced to `application/json`|\n"
    "| `?query=ignored`    | the same file; query is dropped       |\n")
text_object(os.path.join(docs, 'layout.txt'), 'layout.txt', '/home/docs/', 'text/plain',
    "site/\n"
    "  index.html            bootstrap page\n"
    "  cvwm.js               the desktop (unchanged)\n"
    "  .well-known/cdmi/\n"
    "    cdmi_capabilities/index.cdmi\n"
    "    cdmi_namespaces/index.cdmi\n"
    "  home/\n"
    "    index.cdmi\n"
    "    readme.txt  welcome.md\n"
    "    docs/   images/\n")

# images/
images = os.path.join(home, 'images')
container(images, 'images/', '/home/', ['blue.png', 'rose.png', 'grey.png'])
binary_object(os.path.join(images, 'blue.png'), 'blue.png', '/home/images/', 'image/png', png(160, 100, (0x60, 0xa0, 0xc0)))
binary_object(os.path.join(images, 'rose.png'), 'rose.png', '/home/images/', 'image/png', png(160, 100, (0xc0, 0x60, 0x77)))
binary_object(os.path.join(images, 'grey.png'), 'grey.png', '/home/images/', 'image/png', png(160, 100, (0xbf, 0xbf, 0xbf)))

print('built site at', SITE)
print('nodes:', sum(len(files) for _, _, files in os.walk(SITE)))
