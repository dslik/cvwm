# Declaring file types in a cvwm app — developer guide

How an application tells cvwm which documents it can open, and how the icons for
those documents are stored and associated. This is the reference for authoring an
app's `rsrc/filetypes.json` manifest and registering the app so cvwm will route
objects to it.

Applies to cvwm 2.107+ (the Apps control panel and the `~/prefs/apps.json`
registry). Before 2.107 the opener and icon for a type were hard-coded in
`cvwm.js`; that is no longer the case — an app now declares its own types.

---

## 1. The short version

To make an app openable for a document type, do two things:

1. **Add a manifest** at `rsrc/filetypes.json` in the app's source directory,
   listing the media types and extensions it claims and the icon each should use.
2. **Register the app** so it appears in `~/prefs/apps.json`. Built-in apps are
   seeded automatically; any other app is added by the user through the **Apps**
   control panel (*Add app…*).

cvwm reads the manifest of every registered app at sign-in, builds a type→app
registry, and uses it both to decide which app opens a double-clicked object and
which icon that object shows in a container view.

---

## 2. The manifest: `rsrc/filetypes.json`

Create a file named `filetypes.json` inside the app's `rsrc/` fork:

```
apps/myapp/
  index.js
  index.svg
  rsrc/
    filetypes.json      <-- the manifest
    doc.svg             <-- (optional) a custom type icon, see §4
```

Its shape is a single object with a `types` array. Each entry declares one group
of formats that share an icon:

```json
{
  "types": [
    {
      "mimetypes": ["text/markdown"],
      "extensions": ["md", "markdown", "mdown", "mkd"],
      "icon": "object"
    },
    {
      "mimetypes": ["application/json", "application/xml"],
      "extensions": ["js", "json", "xml", "css"],
      "icon": "script"
    }
  ]
}
```

### Fields of a type entry

| Field | Required | Meaning |
|-------|----------|---------|
| `mimetypes` | one of the two | A list of media types the app claims. A trailing `/*` wildcard is allowed, e.g. `"text/*"` or `"font/*"` — it matches any media type whose name starts with that prefix. |
| `extensions` | one of the two | A list of filename extensions, **without the leading dot**, lower-case (`"md"`, not `".md"` or `"MD"`). |
| `icon` | optional | How a document of this type is drawn. See §4. If omitted, the app's own icon (`index.svg`/`index.png`) is used. |

Give each entry at least one of `mimetypes` or `extensions`. Split formats across
several entries only when they need **different icons**; otherwise keep them in
one entry.

> **Important — the slug rule.** On install the resource fork drops a file's
> extension: `rsrc/filetypes.json` is deployed as the object `rsrc/filetypes`
> (media type `application/json`). Author the file as `filetypes.json` in source;
> never reference it with the extension at runtime — cvwm and the Apps panel both
> read `rsrc/filetypes`. This also means you cannot have both `filetypes.json`
> and another `filetypes.*` in the same fork.

---

## 3. Matching: how a type resolves to an app

At sign-in cvwm calls `loadAppRegistry()`, which reads `~/prefs/apps.json`, then
each registered app's `rsrc/filetypes`, and builds three lookup tables:

- `byExt` — extension → app (first claimant wins)
- `byMime` — exact media type → app (first claimant wins)
- `wild` — `prefix/*` media-type rules, checked in order

When an object is opened, `regMatch(path, mimetype)` resolves it in this order:

1. the object's **extension** (`byExt`),
2. its exact **media type** (`byMime`),
3. any **wildcard** media-type rule whose prefix the media type starts with.

The first match provides both the opening app and the icon. If nothing matches,
the object opens with cvwm's default handling and shows the generic `object`
icon.

### First-claimant and overrides

When two apps claim the same type, the **first to claim it wins by default**.
"First" is the order apps appear in `~/prefs/apps.json`, which the Apps panel
keeps alphabetical by app name. A user can override the default per type in the
Apps panel's right-hand column: a type claimed by more than one app shows a menu,
and the choice is written to `apps.json` under `links`:

```json
{
  "version": 1,
  "apps": ["apps/mdviewer/", "apps/textile/"],
  "links": {
    ".md": "apps/textile/",
    "text/markdown": "apps/textile/"
  }
}
```

A `links` key is the identifier itself — `".ext"` for an extension (with the dot)
or the media type for a media type (optionally a `prefix/*` wildcard). Its value
is the app path that should win. Overrides take priority over first-claimant
resolution and also decide the icon.

> Authors don't edit `links` — it is the user's override surface. Authors only
> ship the manifest; contested defaults resolve alphabetically until the user
> says otherwise.

---

## 4. Icons: how they are stored and associated

The `icon` field on a type entry decides what a document of that type looks like
in a container view. It accepts three forms, resolved by `iconSpecFor()`:

### a. A built-in icon name

If `icon` is the name of one of cvwm's built-in icons, that vector icon is used —
no file to ship. The names available (from the `ICONS` table in `cvwm.js`) are:

```
disk  home  container  system  app  object  font  script
image  pdf  queue  reference  reload  icons  list
```

The ones meant for document types are **`object`** (generic document),
**`script`** (code/markup), **`font`**, **`image`**, and **`pdf`**. Example:

```json
{ "mimetypes": ["font/*"], "extensions": ["ttf", "otf", "woff", "woff2", "ttc"], "icon": "font" }
```

Prefer a built-in name wherever one fits — it renders identically in light and
dark mode and costs nothing to deploy.

### b. A resource path (custom icon)

If `icon` is a path, it is resolved **relative to the app's deployed root** and
fetched as the icon image. Store the icon inside the app's `rsrc/` fork and point
at its deployed (slug) path:

```
rsrc/
  filetypes.json
  doc.svg
```

```json
{ "extensions": ["myx"], "icon": "rsrc/doc" }
```

Note the slug rule again: ship `doc.svg`, reference it as `rsrc/doc`. SVG is
preferred (crisp at any size, theme-friendly); PNG also works. The panel and
cvwm fetch the resource's value and render it as a data URL.

### c. Omitted — the app's own icon

If `icon` is absent, the document uses the app's own `index.svg` (or `index.png`)
— the same glyph as the app itself. Use this when a document should visually read
as "a file for this app."

### Resolution summary

| `icon` value | Source used |
|--------------|-------------|
| a built-in name (`"object"`, `"font"`, …) | cvwm's vector icon |
| a path (`"rsrc/doc"`) | that resource in the app, as an image |
| absent | the app's `index.svg` / `index.png` |

The icon a document shows and the app that opens it always come from the **same
matched type entry**, so an overridden opener also changes the icon to that app's
declaration for the type.

---

## 5. Registering the app

A manifest alone does nothing until the app is in `~/prefs/apps.json`.

- **Built-in apps** are listed in `CFG.builtinApps` in `cvwm.js` and seeded into
  `apps.json` on a user's first sign-in. To add a new built-in, add its path
  there (and ship its manifest). Seeding happens once; existing users keep their
  registry, so a newly built-in app is not retro-added for them — they add it via
  the panel, or you migrate `apps.json`.
- **User apps** are added at runtime through the **Apps** control panel
  (*Add app…* → pick the app's container). The panel stores the path
  home-relative where possible and re-reads its manifest immediately.

The registry object:

```json
{
  "version": 1,
  "apps": ["apps/mdviewer/", "apps/fontviewer/", "apps/textile/", "apps/earthworm/"],
  "links": {}
}
```

- `apps` — an ordered list of app paths (home-relative, or absolute for a
  foreign-origin app). Order sets first-claimant priority.
- `links` — the user's per-type opener overrides (§3).

---

## 6. Checklist for adding a type to an app

1. Create `apps/<app>/rsrc/filetypes.json` with a `types` array.
2. For each format group, list `mimetypes` and/or `extensions` (extensions
   bare and lower-case; `prefix/*` allowed for media types).
3. Set `icon` to a built-in name where one fits; otherwise ship an SVG in
   `rsrc/` and reference it by its slug path (no extension); or omit to use the
   app's own icon.
4. If it's a built-in app, add its path to `CFG.builtinApps`; otherwise it's
   registered by the user through the Apps panel.
5. Validate: `python3 -c "import json;json.load(open('apps/<app>/rsrc/filetypes.json'))"`.
6. Verify in the Apps panel — the app shows its claimed types (expand it), and
   each type lists the resolving app in the right column; contested types show a
   menu.

---

## 7. Worked example — textile claiming Markdown

textile is a plain-text/code editor. To let it also open Markdown (alongside
mdviewer, which already claims it), its manifest gained a Markdown entry:

```json
{
  "types": [
    { "mimetypes": ["application/json", "application/xml", "application/javascript"],
      "extensions": ["js", "mjs", "json", "xml", "css", "sh", "py"], "icon": "script" },
    { "mimetypes": ["text/markdown"],
      "extensions": ["md", "markdown", "mdown", "mkd"], "icon": "object" },
    { "mimetypes": ["text/plain", "text/*"],
      "extensions": ["txt", "text", "log", "csv", "tsv", "ini", "conf", "cfg", "yaml", "yml"],
      "icon": "object" }
  ]
}
```

Because both mdviewer and textile now claim `text/markdown` and `.md`, those
types show a menu in the Apps panel. Until the user picks, the alphabetically
first app (mdviewer) opens Markdown; choosing textile writes
`"text/markdown": "apps/textile/"` and `".md": "apps/textile/"` into `links`,
and from then on `.md` files open in textile and show textile's icon for that
type.
