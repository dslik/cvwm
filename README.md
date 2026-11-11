# cvwm

The CDMI Virtual Window Manager: an X11/FVWM-style desktop for CDMI 3 servers, in plain JavaScript, with a suite of applications for browsing and managing a server.

```
cvwm.js               the desktop: window manager, CDMI client, container browser
index.html            a handful of lines that load cvwm.js
index.js  index.png   a stub and icon that mark the desktop's own container, so it is never run as an application
favicon.ico
VERSION               the release version
install.py            install the applications and commands into a CDMI server (Python standard library only)
tools/
  setup-cvwm.py       stand up the seedmi reference server for cvwm on a given hostname (TLS, homes, desktop export)
  update-cvwm.py      bring a running instance up to this release, leaving its data, ACLs and exports untouched
  package-app.py      write one application (or the shared resource fork) to a .cdmi file for offline use
  cdmi_serialize.py   the shared directory-to-CDMI serialization used by install.py, update-cvwm.py and package-app.py
  cdmi-rsync          an rsync workalike where a source or destination is a CDMI namespace
  cdmi-scp            an scp workalike where a remote is a CDMI namespace (over HTTPS)
  kms-make-dac-keys.mjs  create seedmi's delegated-access-control keys (used by setup-cvwm.py --with-dac)
rsrc/                 the shared resource fork installed into the desktop container
apps/                 the GUI applications, each a container holding index.js (and an icon, index.svg or index.png) on the server
  earthworm/          a location bar around an iframe (a minimal web browser)
  textile/            a text editor; JSON and JavaScript are coloured; follows the desktop's light/dark theme
  xclock/             an analogue clock, after the X11 one
  mcpinspector/       a native MCP client for the CDMI-over-MCP endpoint
  mdviewer/           opens a Markdown object (or one dropped on it) and renders it, GitHub style
  fontviewer/         opens a font (TTF/OTF/WOFF/WOFF2): a sample and a Unicode character viewer
  utils/              console/  xterm/  capture/  framer/
  cdmi/               capabilities/  domains/  namespaces/  postcdmi/  queues/
                      relationships/  servers/  notifications/  query/
bin/                  the xterm's commands, each a container under /bin/:
                      ls pwd cat head hexdump stat caps tree df echo open which nc ssh zip unzip
control_panels/       control panels, imported into each home like apps and configured under ~/proc/:
                      locale/   language, number, date and time formats
fonts/                a server-wide fonts container, imported into each home like apps; double-click a font to view it
```


## Use it with a server

1. Serve `cvwm.js` and `index.html` from the **https: origin of the CDMI server** (an HTTP export, or the
   web server in front of it). Being same-origin is what lets the browser talk CDMI without CORS.
2. Run `python3 install.py https://your-server/cdmi/3.0.0/ --token ...` to store the applications under `/apps/`
   and the commands under `/bin/`, each a container holding `index.js` (and `index.png`). (Or drag the files into
   container windows.)
3. Load `index.html`.

On start the desktop opens on a sign-in screen. Once a principal has signed in, their home (from
`cdmi_domain_userinfo`, spec 302) is mounted as a Home disk at the top right; the xterm starts there, and `~` and a
bare `cd` go home. The xterm keeps its command history in `~/.history` when a home is available, and loads it at
start. Discovered namespaces are not mounted automatically -- the home, and any base URI mounted by hand, are the
disks. A new home is given an `apps` container whose uppermost layer is the home's own (writable) and whose layer
beneath is a read-only CDMI import of the server's published apps, so every account has the applications without a
copy. Where the server has no discovery tree (404), a dialog asks for a base URI.

### With seedmi, the reference server

seedmi is the reference CDMI 3 server cvwm is developed against: **https://github.com/dslik/cdmi-seedmi**

The quickest way to see cvwm running is `tools/setup-cvwm.py`, which stands up seedmi for a hostname you choose and
installs the desktop into it: TLS certificates, a domain controller with home directories, an anonymous-read grant on
the tree the desktop reads, and an HTTP export that serves the desktop from seedmi's own origin (same-origin with the
CDMI binding, so there is no CORS to arrange).

```sh
# Point a hostname at this machine first -- a DNS record, a resolver that maps *.localhost to loopback,
# or an /etc/hosts line you add. Then, with the seedmi tree beside the script:
python3 tools/setup-cvwm.py cdmi.example.local
# then open https://cdmi.example.local:9443/desktop/index.html
```

It needs `node` and `openssl` on PATH, runs without root, and writes everything under `run-<hostname>/` (config, logs,
certificates, a `stop.sh`). Two users are created with homes, `alice`/`alice` and `bob`/`bob`. Run
`python3 tools/setup-cvwm.py --help` for its options (`--port`, `--realm`, `--seedmi DIR`, and so on). It is a
development setup -- self-signed certificates, plaintext passwords in the generated config -- not for production.

Once it is running, `tools/update-cvwm.py` brings the instance up to a newer release without touching its data, ACLs
or exports:

```sh
python3 tools/update-cvwm.py https://cdmi.example.local:9443/cdmi/3.0.0/ --desktop desktop --basic alice:alice
```

seedmi also advertises its `http:` base URI; a browser will not follow that from an `https:` page, so only the TLS
namespace is mounted.

## TLS only

The desktop and its CDMI applications (xterm, capabilities, textile) connect to `https:` URIs and nothing else. A page loaded over `http:`
shows "TLS required" and reads nothing; `http:` base URIs are refused whether typed, stored, listed by
the discovery tree or reached by a redirect; `install.py` accepts only
`https:` base URIs.

Earthworm is the exception: it is a web browser rather than a CDMI client, and opens `http:` as well as `https:`
addresses. One browser rule still applies: a page loaded over `https:` may not frame an `http:` page (mixed
content), so with the desktop served over TLS the browser itself leaves such a frame blank.

## Applications

A container that holds `index.js` is an application: opening it runs that script in an iframe inside a window,
and `index.png` beside it is its icon. The desktop hands the script `window.CDMI_CONTEXT`:

| member | |
| --- | --- |
| `baseURI`, `diskName`, `containerURI`, `origin` | where the application was opened from |
| `startURI` | an object or container it was asked to open, or `null` |
| `namespaces` | `[{name, baseURI}]` for every mounted disk |
| `headers` | the signed-in user's `Authorization` header, if any |
| `setTitle(t)`, `resize(w, h)`, `open(uri)`, `close()` | calls back into the desktop |
| `setDirty(bool)` | says the window holds unsaved work, so the desktop asks before closing it |
| `desktop` | the desktop's `cvwm` object: `log`, `windows()`, `evalIn(id, code)`, `open(uri)` |
| `dropTarget = () => uri`, `onUpload = (results, uri) => {}` | set these to accept files dropped on the window |

The members above are the whole contract between the desktop and an application. Applications run same-origin with
the desktop, so they act with the user's full access to the server.

## Run as another user

An application's context menu has **Run as…** below **Run**: it signs in as another user (without disturbing your
own session) and launches that application as them. Its window carries that principal's `Authorization`, and an
Open/Save dialog the application raises inherits it too, so the application acts entirely as the other user. Each
window's title bar shows `user@domain` on the right; a window running as a principal with administrator privileges
shows a red/orange hazard bar.

Because every window runs same-origin, this is a **convenience, not an isolation boundary** — one window's
credential is as reachable to other code in the desktop as any application's already is (an application is handed
the user's `Authorization` and runs with their full access). Run-as windows are never serialized or migrated to
another screen, and their credential is dropped when the window closes.

## Scroll bars

The operating system's scroll bars are replaced, in the desktop and inside every application window, by Motif-style
ones: a sunken trough, a raised slider and raised triangular arrows. (FVWM draws none of its own; these are what
the toolkits beside it drew.) The desktop puts the rules into each application's document ahead of the
application's own styles, so an application recolours them with `--sb-face` and `--sb-trough` (Textile and Console
do) or restyles them entirely. Chromium and Safari draw them in full; Firefox only accepts the two colours and
draws its own flat bar. Pages shown by Earthworm, and the PDF viewer, keep their own.

## Light and dark

The root menu (left-click the desktop background) has a **Dark mode** toggle. It is one setting for the whole
desktop: it re-themes the window manager and its windows, and every application that follows it does so at the same
time, in each of their windows. The choice is remembered. Applications that ship with the desktop and follow it
include Textile and the Open/Save dialog.

## Control panels

Control panels are small settings applications. The server holds them under `/control_panels/`, and each home imports
them into `~/control_panels/` exactly as it imports the server's apps into `~/apps/` — a writable layer of the user's
own over a read-only import of the server's — so they appear in the home disk and open with a double-click. A panel
keeps its preferences as JSON in the home, under `~/prefs/`.

The **Locale** panel sets the preferred language and the number, date and time (12- or 24-hour) formats. There are no
buttons: a change applies at once. It writes a shared signal (the same mechanism as the dark-mode toggle), so the
desktop and every open application re-render in the new formats immediately — the file browser's *Last modified* column
and sizes, for one — and it saves the choice to `~/prefs/locale.json` so it returns on the next sign-in.
Applications receive the locale in their context and can follow the same live signal.

The **Apps** panel manages which application opens which kind of object, and the icon each kind shows. An application
declares the file types it handles — media types and extensions, each with an icon — in its own resource fork, in
`rsrc/filetypes.json`; the panel reads those declarations and lists, in one column, every added app (expand one to see
its types) and, in the other, every known file type and the app that opens it. Add or remove apps there. The registry
is `~/prefs/apps.json`, seeded on first sign-in from the built-in apps; the desktop reads it to route a double-click to
the right app and to pick an object's icon. A type no app claims does not auto-open.

## Fonts

The server holds a `/fonts/` container, and each home imports it into `~/fonts/` the same way it imports apps and
control panels — a writable layer of the user's own over a read-only import of the server's. An administrator drops
font files into `/fonts/`, or a user drops their own into `~/fonts/`.

Double-clicking a font object (`.ttf`, `.otf`, `.woff`, `.woff2`) opens **fontviewer**, the app the registry links to
those types. It loads the font with the browser's `FontFace` API and shows, in one fixed-height window, a **sample** — a
large multi-line text box you can type into, rendered in the font at a size you set — and a **Unicode character
viewer**: the font's own repertoire, grouped by Unicode block, with the selected glyph's code point. The family,
style, glyph count and format come from the font's own tables (`name`, `maxp`, `cmap`), parsed for TrueType/OpenType
and WOFF; a WOFF2 font still renders, and its repertoire is found by probing. Launched on its own (rather than on a
font), fontviewer stays hidden and raises the standard Open dialog, filtered to fonts; it appears once you choose one.
The release ships `/fonts/` empty.

## Screens

Each browser window signed in to a home registers itself as a container under `~/proc/screens/`, numbered `1`, `2`,
`3`, … like X11 screens — the number is what the window menu's **Send to desk** shows (`Screen 2: Desk 3`). The
number is only a label; the window's durable identity is a UUID kept in the tab's `sessionStorage` and written into
the container's metadata, alongside a per-browser install id. A reload or crash-restore re-adopts the same container;
signing out or closing the window removes it; and a browser cleans up its own crashed windows at the next sign-in, by
asking which of its windows are still alive over a `BroadcastChannel` and deleting the rest. There is no heartbeat and
no expiry, so a screen left by another browser or device — which can't be told apart from a live one — is left in
place.

## Icon view and list view

Two buttons at the top right of a container window switch between icons and a list with a small icon, name, type,
time of last modification and size; a click selects and a double click opens in both, and dragging works the same.
The list begins with `.` (this container) and `..` (the one above; dropping on it moves things up a level).
Column headings sort. The list needs each child's media type and metadata, which the icon view does not ask
for, so the first switch reads the container once more with `childfields=...;mimetype;metadata`. The choice is
remembered for new windows. Against a server with no extended listing the list shows names and kinds only.

## Exports, imports and snapshots

An object's menu has **Define exports** (a container, a data object or a queue) and **Define imports** (a container
or a queue; a data object has no imports), and a container's has **Create snapshot**; a container window's own menu has them for the container it shows.

*Exports* are named entries, each presenting the object over another protocol. *Imports* are a stack of layers,
uppermost first, each bringing a namespace (or, for a queue, a stream of messages) into the object; the layer of type `self` is what the object itself holds, a name in an upper layer hides the same
name below, and one layer at most takes the writes. The dialog shows the stack, with Up and Down to reorder it; adding
the first layer to a container puts a `self` layer beneath it, so that what the container holds stays in view.

The form for each entry type is built from the field tables of the specification, carried inside `cvwm.js`:
mandatory fields are starred, permitted values are menus, a `protocol` field offers the versions the server's
capabilities list, and what the server populates (`active`, `last_problems`, addresses, counters) is shown as status
and never sent back. Any entry can also be edited as JSON. Types the object's capabilities do not list are still
offered, marked as not offered. Apply replaces the field whole (`PUT ...?exports`, `PUT ...?imports`), or removes
it (`PATCH` with `null`) when the last entry goes; a refusal is shown with the server's words, and the entry and
field its `cdmi_field` pointer names are brought up.

A snapshot is an update of the container carrying a `snapshot` field; it then stands, read only, in
`cdmi_snapshots/` inside the container, which the desktop opens once it is made.

The dialog for `cdmi_objectid/` has **New container**, a create with a server-assigned name addressed to
`cdmi_objectid/` itself, making a container reached by its object ID alone. The draft's capabilities speak only of
data objects and queues made that way, and seedmi 0.45 answers 415.

## Versions

A data object's menu has **Show versions** where the object is version-enabled, and **Enable versioning** where it is
not (that sets `cdmi_versioning` to `value`). Which it is lies in the object's metadata, so the entry settles a moment
after the menu opens.

The window draws the history as a tree, oldest first, read from the object's `cdmi_version_oldest` and each version's
`cdmi_version_children`. A run of versions each made from the last stays in one column; where two updates overlapped
and a version has two children, the one that leads to the current version carries on and the other steps to the
right. Versions are data objects reached by object ID, and immutable: **Open** (or a double click) shows one in the
plain viewer, marked read only, never in the editor. **Revert to this** is an update of the data object carrying a
`copy` field that addresses the version; the present state stays in the history, so a revert can be reverted.

## xclock

The analogue face of the X11 program, filling its window. Click it or press D for the digital form, S for the second
hand, C for a chime on the hour; the choices are kept.

## Moving and copying

Drag an object onto a container - a browser window, a container's icon, a disk, or an xterm (its current
container) - to move it there; hold Ctrl or Alt to copy. Both are CDMI create operations at the new name carrying a
`move` or `copy` field, named by namespace path within a disk and by URI across disks. The name is checked first and
a replacement confirmed, because a server may not honour `If-None-Match` on a copy. Reserved containers (`cdmi_*` at
a root, `cdmi_snapshots`) cannot be picked up, nothing can be dropped into itself, and a copy dropped where it
already is becomes "name copy.ext".

## Download, zip and unzip

A data object's context menu in a container window has **Download…**, which saves the object's value to the
browser's downloads as a file of its own name and media type. It is a plain download (not an OS drag), so it works in
every browser, and it reads the value with the signed-in user's credentials.

To download something compressed, or to bundle several objects, the xterm has `zip` and `unzip`. They read and write
CDMI objects and produce standard PKZIP archives (DEFLATE through the browser's `CompressionStream`, or stored with
`-0`), so an archive made here opens with any unzip tool and vice versa:

```
zip [-0] [-r] archive.zip path...      pack data objects (and, with -r, containers) into a new archive.zip object
unzip [-l] [-d dir] archive.zip [name...]   list, or extract entries into the current container (or -d dir)
```

So `zip -r site.zip www` then Download… on `site.zip` gets a compressed copy onto your machine; `unzip backup.zip`
unpacks an archive dropped or created in the store.

## Textile

A text editor with a File/Edit/View menu bar and a status bar: line numbers, Find (Ctrl+F), Go to Line (Ctrl+G),
Save (Ctrl+S), Save As (Ctrl+Shift+S), Open (Ctrl+O), Tab and Shift+Tab to indent, indentation carried to a new line,
and a Wrap lines toggle (Alt+Z) under which line numbers still line up. JSON and JavaScript are coloured, and JSON is
checked as you type; the status bar carries the file name (with a dot while there are unsaved changes), the cursor
position and the result of that check. It follows the desktop's light/dark setting. Where it is installed, the desktop
opens `.txt`, `.md`, `.json`, `.log` and other text objects with it (and anything with a text media type); "View" in an
object's menu still opens the plain viewer, and a browser window's menu has "New text file". Saving an existing object
replaces its value alone (`PUT ...?value`), leaving metadata and media type as they were.

## xterm, /bin and /apps

The xterm is a terminal (VT100-family: cursor addressing, attributes and colours, scrollback, an alternate screen)
and a shell; `nc host port` is a TCP connection through a WebSocket-to-TCP relay in the server, joined to the
terminal. `cd`, `help`, `history`, `clear`, `exit` and `rehash` are built in; any other name is looked for
as `/bin/<name>/` (a text command, run in a hidden frame and writing to the terminal) or `/apps/<name>/` (a GUI
application, started in a window), on the current disk first and then the others. `textile notes.txt` starts textile on
that object; `xclock &` starts the clock and gives the prompt straight back. Commands take `--help`. Writing a new
command is a matter of creating `/bin/<name>/index.js`.

## Console

The desktop keeps a log from the moment it loads: `console.*` calls, uncaught errors, unhandled rejections, resources
that failed to load, policy violations, and every `fetch()` with status and timing - from the desktop and from each
application window (each is captured before its script runs). Console shows it with filters by level, window and
text, and runs JavaScript in the window you pick. Successful requests are at Debug level, which starts switched off.

It cannot show what the browser keeps to itself: the stated reason for a CORS or mixed-content block or a refused
frame, and anything inside a frame of another origin. A failed request is listed with its likely cause; the browser's
own console has the exact one. Wrapping `console` also means the browser's console attributes those lines to
`cvwm.js` rather than to the caller.

