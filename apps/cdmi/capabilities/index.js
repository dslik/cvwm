/*!
 * CDMI Capability Board - an application for cvwm. Store this file as "index.js" in a
 * container (for example /capabilities/), with index.png beside it for its icon, and open it.
 */
(function () {
"use strict";

/* Resources: the app's own fork (CTX.rsrc), optional. Absent (a classic install) => every lookup falls back to the
   built-in default below and the app runs exactly as before. S() reads a string; the stylesheet, the Annex B catalogue
   and the class titles are pulled from the fork where present. */
const R = (window.CDMI_CONTEXT || {}).rsrc || null;
function S(id, fb) { const v = R && R.text("strings", id); return v == null ? fb : v; }

/* The page this used to be: its stylesheet and its markup, put into the document the desktop gives us. */
const CSS = `
  :root {
    --bg:#070607; --board:#0b0a0b; --grid:#1a181c;
    --text:#e9e7ea; --dim:#8e8a96;
    --green:#17b64a; --green-lt:#4a9d63;
    --red:#e01b2a; --red-lt:#ff6b6b;
    --yellow:#f5c400; --yellow-lt:#ffe14d;
    --cyan:#1ea7d6; --cyan-lt:#67d9ff;
    --mag:#c93fa8; --mag2:#7b3ca8; --lav:#c9b3e6;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:#000; overflow:clip;
    font-family:'Saira',system-ui,sans-serif; color:var(--text); }
  /* The 1920x1080 stage is laid out at full size and scaled down to fit, so before the transform it overhangs the
     viewport on both sides. "clip" rather than "hidden": a hidden overflow is still scrollable by script and by the
     browser bringing a focused control into view, which shifted the whole board sideways when the filter was focused. */
  #viewport { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; overflow:clip; }
  #stage { width:1920px; height:1080px; flex:0 0 auto; transform-origin:center center;
    background:var(--bg); display:flex; flex-direction:column; position:relative; overflow:hidden; }
  /* the panel is being photographed off a screen, so it gets a little of that */
  #stage::after { content:""; position:absolute; inset:0; pointer-events:none; z-index:50;
    background:repeating-linear-gradient(180deg,rgba(255,255,255,.022) 0 1px,transparent 1px 3px); }

  /* ── status strip ── */
  #strip { height:48px; flex-shrink:0; display:flex; align-items:stretch; gap:3px;
    background:#5f2c85; padding:3px; }
  #state { flex-grow:1; min-width:0; display:flex; align-items:center; justify-content:flex-start;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    font-family:'Saira Condensed',sans-serif; font-weight:600; font-size:24px; letter-spacing:.01em;
    color:#fff; background:#b4359c; padding:0 22px; }
  #state.busy { animation:flick 1.1s steps(2,end) infinite; }
  @keyframes flick { 50% { color:#ffe9fb; } }
  /* the two controls the desktop edition adds sit in the strip, dressed as its other readouts */
  #disk { border:0; background:#c3ace1; color:#1a0f26; cursor:pointer;
    font-family:'Saira Condensed',sans-serif; font-weight:700; font-size:22px; letter-spacing:.01em; padding:0 18px; }
  #disk:disabled { opacity:.55; cursor:default; }
  #disk:focus-visible { outline:2px solid var(--yellow); outline-offset:-4px; }
  .lcd { min-width:250px; display:flex; align-items:center; justify-content:center;
    background:#c3ace1; color:#1a0f26;
    font-family:'Saira Condensed',sans-serif; font-weight:700; font-size:26px; letter-spacing:.01em; }

  /* ── agenda / controls ── */
  #bar { flex-shrink:0; display:flex; align-items:center; gap:8px; padding:8px 22px; background:#100e12;
    border-bottom:1px solid #241f28; }
  .tab { font-family:'Saira Condensed',sans-serif; font-weight:600; font-size:17px; letter-spacing:.04em;
    color:var(--dim); background:#17141a; border:1px solid #2b2630; padding:7px 14px; min-height:34px;
    cursor:pointer; }
  .tab[aria-selected="true"] { color:#0b0a0b; background:var(--lav); border-color:var(--lav); }
  .tab:focus-visible { outline:2px solid var(--yellow); outline-offset:2px; }
  /* The eight tab labels are wider than the strip leaves beside the filter, so the tab list scrolls within its own
     room rather than pushing the filter off the stage (which, the stage clipping its overflow, left the filter
     invisible and typing into it scrolled the whole board sideways). */
  #tabs { flex:1 1 auto; min-width:0; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; }
  .tab { white-space:nowrap; flex:0 0 auto; }
  #bar .spacer { flex:0 0 8px; }
  #filter { width:280px; height:34px; background:#17141a; border:1px solid #2b2630; color:var(--text);
    font-family:'Saira',sans-serif; font-size:15px; padding:0 12px; }
  #filter::placeholder { color:#5f5a68; }

  /* ── the board ── */
  #boardwrap { flex-grow:1; min-height:0; position:relative; padding:12px 22px 6px 22px; }
  #board { height:100%; column-count:8; column-gap:16px; column-fill:auto; }
  .cap { display:flex; align-items:center; gap:8px; width:100%; height:33px; padding:0 4px;
    background:transparent; border:0; border-left:2px solid transparent; text-align:left; cursor:pointer;
    break-inside:avoid; }
  .cap:hover { background:#181520; }
  .cap:focus-visible { outline:2px solid var(--yellow); outline-offset:-2px; }
  .cap.changed { animation:vote 2.4s ease-out 1; }
  @keyframes vote { 0%,40% { background:#2c2416; border-left-color:var(--yellow); } 100% { background:transparent; } }
  .ico { width:19px; height:19px; flex-shrink:0; display:flex; align-items:center; justify-content:center;
    font-family:'Saira',sans-serif; font-weight:700; font-size:15px; line-height:1; color:#fff; }
  .ico.g { background:var(--green); } .ico.r { background:var(--red); }
  .ico.y { background:var(--yellow); color:#2a2100; } .ico.c { background:var(--cyan); font-size:11px; }
  .ico.x { background:transparent; border:1px solid #3a343f; color:#3a343f; }
  .nm { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    font-family:'Saira Condensed',sans-serif; font-weight:600; font-size:20px; letter-spacing:.01em; }
  .cap.s-present .nm { color:var(--green-lt); }
  .cap.s-withheld .nm { color:var(--red-lt); }
  .cap.s-absent .nm { color:#a49ead; }
  .cap.s-reported .nm { color:var(--cyan-lt); }
  .val { flex-shrink:0; font-family:'Saira',sans-serif; font-size:13px; color:var(--cyan-lt); opacity:.9; }
  .ext { flex-shrink:0; width:5px; height:5px; background:var(--lav); border-radius:50%; }

  /* ── tally ── */
  #tally { flex-shrink:0; height:54px; display:flex; gap:4px; padding:0 22px 8px 22px; }
  .tal { flex:1 1 0; min-width:0; display:flex; align-items:center; gap:12px; padding:0 18px;
    font-family:'Saira Condensed',sans-serif; font-weight:700; font-size:27px; color:#0a0a0a;
    letter-spacing:.02em; }
  .tal .box { width:22px; height:22px; display:flex; align-items:center; justify-content:center;
    font-family:'Saira',sans-serif; font-size:17px; font-weight:700; }
  .tal.g { background:var(--green); } .tal.g .box { background:#0a7a30; color:#fff; }
  .tal.r { background:var(--red); color:#fff; } .tal.r .box { background:#8f0d18; color:#fff; }
  .tal.y { background:var(--yellow); } .tal.y .box { background:#8a6e00; color:#fff; }
  .tal.c { background:var(--cyan); color:#04222e; } .tal.c .box { background:#0b5f7d; color:#fff; }
  .tal .n { margin-left:auto; font-size:30px; }

  /* ── detail ── */
  #detail { position:absolute; right:24px; bottom:74px; width:560px; z-index:60;
    background:#121016; border:1px solid #3a3442; box-shadow:0 24px 60px -20px #000;
    padding:20px; display:none; flex-direction:column; gap:12px; }
  #detail.open { display:flex; }
  #detail h3 { margin:0; font-family:'Saira Condensed',sans-serif; font-weight:700; font-size:26px; color:#fff;
    word-break:break-all; }
  #detail .meta { display:flex; flex-wrap:wrap; gap:16px; font-size:13px; color:var(--dim); }
  #detail .verdict { display:flex; align-items:center; gap:10px; font-family:'Saira Condensed',sans-serif;
    font-weight:700; font-size:21px; }
  #detail p { margin:0; font-size:14.5px; line-height:1.55; color:#cfcbd6; }
  #detail .rule { height:1px; background:#2b2630; }
  #detail .close { align-self:flex-end; min-height:44px; padding:0 18px; background:transparent;
    border:1px solid #3a3442; color:var(--text); font-family:'Saira',sans-serif; font-size:14px; cursor:pointer; }
  #foot { position:absolute; left:22px; bottom:66px; font-size:13px; color:#5f5a68; z-index:55; }
  @media (prefers-reduced-motion:reduce) { *,#state.busy { animation:none !important; } }
`;

const MARKUP = `
<div id="viewport"><div id="stage">

  <div id="strip">
    <div id="state">READING CAPABILITIES</div>
    <select id="disk" aria-label="Disk"></select>
    <div class="lcd" id="date">--/--/----</div>
    <div class="lcd" id="time">--:--:--</div>
  </div>

  <div id="bar">
    <div id="tabs" role="tablist" aria-label="Capability objects" style="display:flex;gap:8px"></div>
    <div class="spacer"></div>
    <label for="filter" style="font-size:13px;color:var(--dim)">Filter</label>
    <input id="filter" type="text" placeholder="capability name or keyword" autocomplete="off">
  </div>

  <div id="boardwrap"><div id="board"></div></div>
  <div id="foot">—</div>

  <div id="tally">
    <div class="tal g"><span class="box">+</span>PRESENT<span class="n" id="tPresent">0</span></div>
    <div class="tal c"><span class="box">#</span>REPORTED<span class="n" id="tReported">0</span></div>
    <div class="tal r"><span class="box">−</span>WITHHELD<span class="n" id="tWithheld">0</span></div>
    <div class="tal y"><span class="box">✕</span>NOT IMPLEMENTED<span class="n" id="tAbsent">0</span></div>
  </div>

  <div id="detail" role="dialog" aria-label="Capability detail"></div>
</div></div>
`;

{
  const fonts = document.createElement("link");
  fonts.rel = "stylesheet";
  fonts.href = "https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;600;700&family=Saira:wght@400;500;600;700&display=swap";
  const style = document.createElement("style");
  style.textContent = (R && R.text("styles", "capabilities")) || CSS;
  document.head.appendChild(fonts);
  document.head.appendChild(style);
  document.body.innerHTML = MARKUP;          // a constant of this file, never data from a server
  document.documentElement.lang = "en";
  // Primary UI labels come from the fork where present; the MARKUP above carries the built-in English defaults.
  (function () {
    function setText(sel, id) { const n = document.querySelector(sel); if (n) n.textContent = S(id, n.textContent); }
    setText("#state", "reading");
    setText('label[for="filter"]', "filterLabel");
    const f = document.getElementById("filter"); if (f) f.placeholder = S("filterPlaceholder", f.placeholder);
    const tally = [["#tPresent", "present"], ["#tReported", "reported"], ["#tWithheld", "withheld"], ["#tAbsent", "notImplemented"]];
    tally.forEach(function (pair) {
      const n = document.querySelector(pair[0]); if (!n || !n.parentNode) return;
      // the label is the text node before the count span; replace it in place
      const parent = n.parentNode;
      for (let k = 0; k < parent.childNodes.length; k++) {
        const cn = parent.childNodes[k];
        if (cn.nodeType === 3 && cn.textContent.trim()) { cn.textContent = S(pair[1], cn.textContent.trim()); break; }
      }
    });
  })();
}

/* ═══════════════════════════════════════════════════════════════════════════
   CDMI Capability Board

   Reads the capability hierarchy of a CDMI server and shows it the way a
   voting board shows a roll call. The board is not a metaphor imposed on the
   data: a capability of the boolean form has exactly three states, and the
   specification gives each a distinct meaning.

     listed with "true"   the server implements it and is providing it
                          to the requesting entity            → PRESENT
     listed with "false"  the server implements it and is NOT providing
                          it to the requesting entity         → WITHHELD
     not listed           the server does not implement it    → NOT IMPLEMENTED

   A capability whose value states a limit, or whose value is an array of the
   values supported, is not of the boolean form and carries no verdict; the
   board reports the value instead, as the roll call leaves a non-voting seat
   without a light.

   Because the board must show what is NOT listed, it carries the catalogue of
   every capability Annex B defines. Each entry names the class of capability
   object that publishes it, so a ballot is the catalogue entries for that
   class together with anything the server listed that the catalogue does not
   define — a vendor capability, marked as an extension.

   This is the board as an application of cvwm: stored as "index.js"
   in a container, it runs in an iframe of the desktop, which hands it
   window.CDMI_CONTEXT - the base URI of the disk it was opened from, the other
   disks that are mounted, and the Authorization header of the signed-in user.
   The page it used to be is built here from the CSS and MARKUP strings below.
   ═══════════════════════════════════════════════════════════════════════════ */

const CTX = window.CDMI_CONTEXT || {};
const ORIGIN = CTX.origin || location.origin;
const CONFIG = Object.assign({
  roots: [],                 // base URIs; empty means the disk the desktop opened us from
  pollInterval: 10000,       // capabilities change rarely, so this is slower
  bearerToken: null,
  maxObjects: 16,            // capability objects read per server
}, window.CDMI_CAPABILITY_CONFIG || {});

const MT = { container: "application/cdmi-container", capability: "application/cdmi-capability" };

/* The catalogue of Annex B, generated from CDMI 3.0 spec revision 354, with the export capability scheme of seedmi 0.101 (ECR-223A). Each entry:
   n name, t form (bool | value | list), d meaning, s classes of capability
   object that publish it, g the annex table it comes from. */
const CATALOGUE = (R && R.json("data", "catalogue")) || [{"n":"cdmi_domains","t":"bool","d":"Supports domains. If not present, the domainURI field shall not be present in response bodies and the \"cdmi_domains\" URI shall not be present.","s":["root"],"g":"System-wide"},{"n":"cdmi_dataobjects","t":"bool","d":"Supports data objects.","s":["root"],"g":"System-wide"},{"n":"cdmi_metadata_maxitems","t":"value","d":"Reports the maximum number of user-defined metadata items supported per object. If not present, there is no limit placed on the number of user-defined metadata items.","s":["root"],"g":"System-wide"},{"n":"cdmi_metadata_maxsize","t":"value","d":"Reports the maximum size, in bytes, of each user-defined metadata item supported per object.","s":["root"],"g":"System-wide"},{"n":"cdmi_metadata_maxtotalsize","t":"value","d":"Reports the maximum size, in bytes, of user-defined metadata supported by the CDMI server.","s":["root"],"g":"System-wide"},{"n":"cdmi_notification","t":"bool","d":"Supports notification queues.","s":["root"],"g":"System-wide"},{"n":"cdmi_query","t":"bool","d":"Supports query queues.","s":["root"],"g":"System-wide"},{"n":"cdmi_query_regex","t":"bool","d":"Supports query with regular expressions.","s":["root"],"g":"System-wide"},{"n":"cdmi_query_contains","t":"bool","d":"Supports query with \"contains\" expressions.","s":["root"],"g":"System-wide"},{"n":"cdmi_query_tags","t":"bool","d":"Supports query with tag-matching expressions.","s":["root"],"g":"System-wide"},{"n":"cdmi_query_value","t":"bool","d":"Supports query of value fields.","s":["root"],"g":"System-wide"},{"n":"cdmi_queues","t":"bool","d":"Supports queue objects, including the appending of values to a queue object and the removal of values from it, which a CDMI server supports either both or neither, as the specification requires.","s":["root"],"g":"System-wide"},{"n":"cdmi_graph_rels","t":"bool","d":"Validates and interprets the \"rel\" field of a representation, as defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_queue_maxvalues","t":"value","d":"Reports the maximum number of enqueued values supported per queue object. If not present, there is no limit placed on the number of values a queue object holds.","s":["root"],"g":"System-wide"},{"n":"cdmi_queue_maxsize","t":"value","d":"Reports the maximum size, in bytes, of each enqueued value supported per queue object. If not present, there is no limit placed on the size of an individual enqueued value.","s":["root"],"g":"System-wide"},{"n":"cdmi_queue_maxtotalsize","t":"value","d":"Reports the maximum size, in bytes, of all of the enqueued values of a queue object taken together.","s":["root"],"g":"System-wide"},{"n":"cdmi_security_access_control","t":"bool","d":"Supports ACLs. See the specification for additional information.","s":["root"],"g":"System-wide"},{"n":"cdmi_security_data_integrity","t":"bool","d":"Supports data integrity/authenticity. See the specification for additional information.","s":["root"],"g":"System-wide"},{"n":"cdmi_security_encryption","t":"bool","d":"Supports data at-rest encryption. See the specification for additional information.","s":["root"],"g":"System-wide"},{"n":"cdmi_security_immutability","t":"bool","d":"Supports data immutability/retentions. See the specification for additional information.","s":["root"],"g":"System-wide"},{"n":"cdmi_security_sanitization","t":"bool","d":"Supports data/media sanitization. See the specification for additional information.","s":["root"],"g":"System-wide"},{"n":"cdmi_serialization_json","t":"bool","d":"Supports JSON as a serialization format.","s":["root"],"g":"System-wide"},{"n":"cdmi_snapshots","t":"bool","d":"Implements snapshots, as defined in the specification. Whether they are supported for a given container object is reported by the capability of the same name published by the capability object of that container object.","s":["root"],"g":"System-wide"},{"n":"cdmi_references","t":"bool","d":"Supports references.","s":["root"],"g":"System-wide"},{"n":"cdmi_object_move_from_local","t":"bool","d":"Supports moving CDMI objects from URIs within the same storage system.","s":["root"],"g":"System-wide"},{"n":"cdmi_object_move_from_remote","t":"bool","d":"Supports moving CDMI objects from URIs within other CDMI storage systems.","s":["root"],"g":"System-wide"},{"n":"cdmi_object_move_from_ID","t":"bool","d":"Supports moving CDMI objects without a path from a \"/cdmi_objectid/\" URI within the same storage system.","s":["root"],"g":"System-wide"},{"n":"cdmi_object_move_to_ID","t":"bool","d":"Supports moving CDMI objects with a path to a \"/cdmi_objectid/\" URI within the same storage system.","s":["root"],"g":"System-wide"},{"n":"cdmi_object_copy_from_local","t":"bool","d":"Supports copying CDMI objects from URIs within the same storage system.","s":["root"],"g":"System-wide"},{"n":"cdmi_object_copy_from_remote","t":"bool","d":"Supports copying CDMI objects from URIs within other CDMI storage systems.","s":["root"],"g":"System-wide"},{"n":"cdmi_object_access_by_ID","t":"bool","d":"Supports accessing, updating, and deleting objects through \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_post_dataobject_by_ID","t":"bool","d":"Supports adding a new data object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_post_queue_by_ID","t":"bool","d":"Supports adding a new queue object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_deserialize_dataobject_by_ID","t":"bool","d":"Supports deserializating serialized data objects when creating a new data object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_deserialize_queue_by_ID","t":"bool","d":"Supports deserializating serialized queue objects when creating a new queue object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_serialize_dataobject_to_ID","t":"bool","d":"Supports serializing data objects when creating a new data object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_serialize_domain_to_ID","t":"bool","d":"Supports serializing domain objects when creating a new data object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_serialize_container_to_ID","t":"bool","d":"Supports serializing container objects when creating a new data object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_serialize_queue_to_ID","t":"bool","d":"Supports serializing queue objects when creating a new data object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_copy_dataobject_by_ID","t":"bool","d":"Supports copying an existing data object when creating a new data object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_copy_queue_by_ID","t":"bool","d":"Supports copying an existing queue object when creating a new queue object by ID via POST to \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_copy_dataobject_from_queue","t":"bool","d":"Supports the ability to copy to a data object from a queue object.","s":["root"],"g":"System-wide"},{"n":"cdmi_multipart_mime","t":"bool","d":"Supports storing and retrieving the value of data and queue objects using multi-part MIME, and creating a data object from a form-based file upload received through an HTTP export, as described in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_create_value_range_by_ID","t":"bool","d":"Supports a new data object’s value to be created with byte ranges through \"/cdmi_objectid/\".","s":["root"],"g":"System-wide"},{"n":"cdmi_dac","t":"bool","d":"Supports delegated access control.","s":["root"],"g":"System-wide"},{"n":"cdmi_dac_methods","t":"list","d":"This capability contains a list of URI schemes supported for DAC URIs, as specified in the IANA URI Schemes registry.","s":["root"],"g":"System-wide"},{"n":"cdmi_dac_response_window","t":"value","d":"The number of seconds, as a decimal integer, for which the CDMI server accepts a delegated access control response after issuing the challenge.","s":["root"],"g":"System-wide"},{"n":"cdmi_enc_cms","t":"bool","d":"Supports operations against the contents of CMS encrypted objects.","s":["root"],"g":"System-wide"},{"n":"cdmi_enc_jwe","t":"bool","d":"Supports operations against the contents of JWE encrypted objects.","s":["root"],"g":"System-wide"},{"n":"cdmi_enc_inplace","t":"bool","d":"Supports operations to encrypt and decrypt objects in place, including updates.","s":["root"],"g":"System-wide"},{"n":"cdmi_enc_access","t":"bool","d":"Supports operations to decrypt objects on access.","s":["root"],"g":"System-wide"},{"n":"cdmi_enc_digest","t":"list","d":"This capability lists which digest algorithms are enabled for the digest of a value carried in an object signature, as described in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_cms_encryption","t":"list","d":"This capability lists which CMS \"ContentEncryptionAlgorithmIdentifier\" encryption algorithms are enabled, for every use this document makes of the Cryptographic Message Syntax, as specified in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_cms_digest","t":"list","d":"This capability lists which CMS \"DigestAlgorithmIdentifier\" digest algorithms are enabled, for every use this document makes of the Cryptographic Message Syntax, as specified in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_cms_signature","t":"list","d":"This capability lists which CMS \"SignatureAlgorithmIdentifier\" signature algorithms are enabled, for every use this document makes of the Cryptographic Message Syntax, as specified in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_jwe_enc","t":"list","d":"This capability lists which JOSE \"enc\" content encryption algorithms are enabled, for every use this document makes of JSON Web Encryption, including the delegated access control exchange defined in the specification, as define…","s":["root"],"g":"System-wide"},{"n":"cdmi_jwe_alg","t":"list","d":"This capability lists which JOSE \"alg\" key management algorithms are enabled, for every use this document makes of JSON Web Encryption, including the delegated access control exchange defined in the specification, as defined in…","s":["root"],"g":"System-wide"},{"n":"cdmi_jws_alg","t":"list","d":"This capability lists which JOSE \"alg\" signature algorithms are enabled, for every use this document makes of JSON Web Signature, including the delegated access control exchange defined in the specification, as defined in RFC 7…","s":["root"],"g":"System-wide"},{"n":"cdmi_valuetransferencoding_json","t":"bool","d":"Supports JSON value transfer encodings.","s":["root"],"g":"System-wide"},{"n":"cdmi_mcp_uri","t":"value","d":"The address of the endpoint of the protocol binding defined in the specification. The presence of this capability indicates that the CDMI server supports that binding, and its value is the address of the endpoint and is not of…","s":["root"],"g":"System-wide"},{"n":"cdmi_profiles","t":"list","d":"Lists the identifiers of the profiles of the specification that the CDMI server claims to conform to.","s":["root"],"g":"System-wide"},{"n":"cdmi_mcp_subscriptions","t":"bool","d":"Accepts a subscription to a notification queue through the MCP protocol binding.","s":["root"],"g":"System-wide"},{"n":"cdmi_domain_auth","t":"bool","d":"Authenticates the principals of a domain against the directory its \"cdmi_domain_auth\" metadata names.","s":["root"],"g":"System-wide"},{"n":"cdmi_domain_userinfo","t":"bool","d":"Each domain object has a reserved child data object named \"cdmi_domain_userinfo\" reporting the requesting principal.","s":["root"],"g":"System-wide"},{"n":"cdmi_kms","t":"bool","d":"Resolves a credential reference against a key management server, as defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_kms_kmip","t":"bool","d":"Holds credentials at a key management server external to it, reached using the Key Management Interoperability Protocol, as defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_kms_client_registration","t":"bool","d":"A CDMI client registers a managed object at a key management server itself and supplies a credential reference addressing it, as defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_partial_upload","t":"bool","d":"Supports the creation or update of an object by a series of requests of the HTTP protocol binding, as defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_cors","t":"bool","d":"Supports cross-origin requests, as defined in the specification. If not present, the \"cdmi_cors_origins\", \"cdmi_cors_methods\", and \"cdmi_cors_headers\" data system metadata items shall not be used.","s":["root"],"g":"System-wide"},{"n":"cdmi_authentication_methods","t":"list","d":"Contains the authentication methods the CDMI server accepts, as described in the specification and in the subclause defining each protocol binding.","s":["root"],"g":"System-wide"},{"n":"cdmi_list_children_extended","t":"bool","d":"Implements the extended child listing defined in the specification. Whether it is supported for a given container object is reported by the capability of the same name published by the capability object of that container object.","s":["root"],"g":"System-wide"},{"n":"cdmi_list_children_recursive","t":"bool","d":"Implements the recursive child listing defined in the specification. Whether it is supported for a given container object is reported by the capability of the same name published by the capability object of that container object.","s":["root"],"g":"System-wide"},{"n":"cdmi_exports_provided","t":"bool","d":"Supports the \"exportsProvided\" field defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_imports","t":"bool","d":"Supports protocol imports, as defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_imports_copy_up","t":"bool","d":"Copies an object into the write target of a stack of layers in order to change it, as defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_imports_provided","t":"bool","d":"Supports the \"importsProvided\" field defined in the specification.","s":["root"],"g":"System-wide"},{"n":"cdmi_acl","t":"bool","d":"Supports ACLs. When a CDMI server supports ACLs for the purpose of access control, the system-wide capability of \"cdmi_security_access_control\" specified in the specification shall also be set to \"true\".","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_acl_mask_bits","t":"list","d":"The mask bits of the specification that the CDMI server both stores and enforces for the object, each given in its string form, together with \"TRAVERSE_CONTAINER\" where the CDMI server stores that bit, which no CDMI server enfo…","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_acl_flags","t":"list","d":"The access control entry flags of the specification that the CDMI server both stores and enforces for the object, each given in its string form.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_size","t":"bool","d":"Shall generate a \"cdmi_size\" storage system metadata for each stored object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_ctime","t":"bool","d":"Shall generate a \"cdmi_ctime\" storage system metadata for each stored object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_atime","t":"bool","d":"Shall generate a \"cdmi_atime\" storage system metadata for each stored object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_mtime","t":"bool","d":"Shall generate a \"cdmi_mtime\" storage system metadata for each stored object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_acount","t":"bool","d":"Shall generate a \"cdmi_acount\" storage system metadata for each stored object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_mcount","t":"bool","d":"Shall generate a \"cdmi_mcount\" storage system metadata for each stored object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_dac_uri","t":"bool","d":"Supports delegated access control metadata.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_dac_certificate","t":"bool","d":"Supports delegated access control metadata.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_enc_signature","t":"bool","d":"Shall generate a \"cdmi_signature\" storage system metadata for each stored object when a corresponding \"sign_id\" data system metadata item is present.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_version_object","t":"bool","d":"Shall generate a \"cdmi_version_object\" storage system metadata for each version-enabled data object and data object version.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_version_current","t":"bool","d":"Shall generate a \"cdmi_version_current\" storage system metadata for each version-enabled data object and data object version.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_version_oldest","t":"list","d":"Shall generate a \"cdmi_version_oldest\" storage system metadata for each version-enabled data object and data object version.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_version_parent","t":"bool","d":"Shall generate a \"cdmi_version_parent\" storage system metadata for each data object version that has a previous version.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_hash","t":"bool","d":"Generates the \"cdmi_hash\" storage system metadata item for each object, as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_owner","t":"bool","d":"Generates the \"cdmi_owner\" storage system metadata item for each object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_group","t":"bool","d":"Generates the \"cdmi_group\" storage system metadata item for each object, which associates the object with a group for the evaluation of the \"GROUP@\" special identifier in an access control entry, as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_representations","t":"bool","d":"Generates the \"cdmi_representations\" storage system metadata item for each object.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_version_children","t":"list","d":"Shall generate a \"cdmi_version_children\" storage system metadata for each data object version.","s":["container","dataobject","queue","domain"],"g":"Storage system metadata"},{"n":"cdmi_assignedsize","t":"bool","d":"Supports the \"cdmi_assignedsize\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_data_redundancy","t":"value","d":"The CDMI server supports the \"cdmi_data_redundancy\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_data_dispersion","t":"bool","d":"Supports the \"cdmi_data_dispersion\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_data_retention","t":"bool","d":"Supports both the \"cdmi_retention_id\" and \"cdmi_retention_period\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_data_autodelete","t":"bool","d":"Supports the \"cdmi_data_autodelete\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_data_holds","t":"bool","d":"Supports the \"cdmi_hold_id\" data system metadata as defined in the specification. When a CDMI server supports holds for the purpose of making data immutable, the system-wide capability of \"cdmi_security_immutability\" specified…","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_encryption","t":"list","d":"The CDMI server supports the \"cdmi_encryption\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_geographic_placement","t":"bool","d":"Supports the \"cdmi_geographic_placement\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_immediate_redundancy","t":"value","d":"The CDMI server supports the \"cdmi_immediate_redundancy\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_infrastructure_redundancy","t":"value","d":"The CDMI server supports the \"cdmi_infrastructure_redundancy\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_latency","t":"bool","d":"Supports the \"cdmi_latency\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_RPO","t":"bool","d":"Supports the cdmi_RPO data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_RTO","t":"bool","d":"Supports the \"cdmi_RTO\" data system metadata as defined in the specification","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_sanitization_method","t":"list","d":"The CDMI server supports the \"cdmi_sanitization_method\" data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_throughput","t":"bool","d":"Supports the cdmi_throughput data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_value_hash","t":"list","d":"The CDMI server supports the cdmi_value_hash data system metadata as defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_enc_key_id","t":"bool","d":"When the CDMI server supports the \"cdmi_enc_key_id\" data system metadata as defined in the specification, the \"cdmi_enc_key_id\" capability shall be present and set to the string value \"true\".","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_enc_value_sign_id","t":"bool","d":"When the CDMI server supports the \"cdmi_enc_value_sign_id\" data system metadata as defined in the specification, the \"cdmi_enc_value_sign_id\" capability shall be present and set to the string value \"true\".","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_enc_value_verify_id","t":"bool","d":"When the CDMI server supports the \"cdmi_enc_value_verify_id\" data system metadata as defined in the specification, the \"cdmi_enc_value_verify_id\" capability shall be present and set to the string value \"true\".","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_enc_object_sign_id","t":"bool","d":"When the CDMI server supports the \"cdmi_enc_object_sign_id\" data system metadata as defined in the specification, the \"cdmi_enc_object_sign_id\" capability shall be present and set to the string value \"true\".","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_enc_object_verify_id","t":"bool","d":"When the CDMI server supports the \"cdmi_enc_object_verify_id\" data system metadata as defined in the specification, the \"cdmi_enc_object_verify_id\" capability shall be present and set to the string value \"true\".","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_versioning","t":"list","d":"Reports that the CDMI server shall support versioning of data objects and contains a list of which versioning behaviours are supported.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_lock","t":"list","d":"Supports locking of objects through the \"cdmi_lock\" data system metadata; the list gives the lock behaviours supported.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_versions_count","t":"value","d":"This capability specifies the maximum number of historical versions that may be specified.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_versions_age","t":"value","d":"This capability specifies the maximum age of historical versions that may be specified. If absent, restrictions on the age of historical versions specified shall be ignored.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_version_age","t":"value","d":"Deprecated. This capability has the same meaning as the \"cdmi_versions_age\" capability, under the name the previous edition of this document used.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_versions_size","t":"value","d":"This capability specifies the maximum total size of historical versions that may be specified.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_cors_origins","t":"bool","d":"Supports the \"cdmi_cors_origins\" data system metadata item defined in the specification. Where this capability is present, the \"cdmi_cors\" system-wide capability shall be present and set to \"true\".","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_cors_methods","t":"list","d":"Where the CDMI server supports the \"cdmi_cors_methods\" data system metadata item, this capability shall be present and shall contain the HTTP method names the CDMI server accepts in that item.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_cors_headers","t":"bool","d":"Supports the \"cdmi_cors_headers\" data system metadata item defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_retention_id","t":"bool","d":"Supports the \"cdmi_retention_id\" data system metadata item defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_retention_period","t":"bool","d":"Supports the \"cdmi_retention_period\" data system metadata item, and can place an object under retention as described in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_retention_autodelete","t":"bool","d":"Supports the \"cdmi_retention_autodelete\" data system metadata item, and can delete an object when its retention period expires.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_hold_id","t":"bool","d":"Supports the \"cdmi_hold_id\" data system metadata item, and can place an object under hold as described in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_representation_default","t":"bool","d":"Supports the \"cdmi_representation_default\" data system metadata item defined in the specification.","s":["container","dataobject","queue","domain"],"g":"Data system metadata"},{"n":"cdmi_value_sparse","t":"bool","d":"Records where the gaps in the value of a data object are, and reports in the \"valuerange\" field of a read that requests no range the range up to the first gap, as described in the specification.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_read_value","t":"bool","d":"Support the ability to read the object’s value.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_read_value_range","t":"bool","d":"Support the ability to read the object’s value with byte ranges.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_read_metadata","t":"bool","d":"Support the ability to read the object’s metadata.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_modify_value","t":"bool","d":"Support the ability to modify the object’s value.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_modify_value_range","t":"bool","d":"Support the ability to modify the object’s value with byte ranges.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_modify_metadata","t":"bool","d":"Support the ability to modify the object’s metadata.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_modify_deserialize_dataobject","t":"bool","d":"Support the ability of the data object to deserialize a serialized data object into the data object as an update.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_delete_dataobject","t":"bool","d":"Support the ability to delete the object.","s":["dataobject"],"g":"Data object"},{"n":"cdmi_list_children","t":"bool","d":"Support the ability to list the container’s children.","s":["container"],"g":"Container object"},{"n":"cdmi_list_children_range","t":"bool","d":"Support the ability to list the container’s children with ranges.","s":["container"],"g":"Container object"},{"n":"cdmi_read_metadata","t":"bool","d":"Support the ability to read the container’s metadata.","s":["container"],"g":"Container object"},{"n":"cdmi_modify_metadata","t":"bool","d":"Support the ability to modify the container’s metadata.","s":["container"],"g":"Container object"},{"n":"cdmi_modify_deserialize_container","t":"bool","d":"Support the ability of the container object to deserialize a serialized container object into the container object as an update.","s":["container"],"g":"Container object"},{"n":"cdmi_snapshots","t":"bool","d":"The container object supports snapshots, and the \"snapshots\" field shall be returned in its representation, as required by the specification.","s":["container"],"g":"Container object"},{"n":"cdmi_create_snapshot","t":"bool","d":"A snapshot of the container object may be created, as defined in the specification. This capability is named distinctly from the \"cdmi_snapshots\" capability, which reports that snapshots are supported.","s":["container"],"g":"Container object"},{"n":"cdmi_snapshot","t":"value","d":"Deprecated. This capability has the same meaning as the \"cdmi_create_snapshot\" capability, under the name the previous edition of this document used.","s":["container"],"g":"Container object"},{"n":"cdmi_serialize_dataobject","t":"bool","d":"Support the ability to serialize a data object.","s":["container"],"g":"Container object"},{"n":"cdmi_serialize_container","t":"bool","d":"Support the ability to serialize the container and all children’s contents.","s":["container"],"g":"Container object"},{"n":"cdmi_serialize_queue","t":"bool","d":"Support the ability to serialize a queue object.","s":["container"],"g":"Container object"},{"n":"cdmi_serialize_domain","t":"bool","d":"Support the ability to serialize the domain and all child domains.","s":["container"],"g":"Container object"},{"n":"cdmi_deserialize_container","t":"bool","d":"Support the ability of the container to deserialize the serialized containers and associated serialized children into the container.","s":["container"],"g":"Container object"},{"n":"cdmi_deserialize_queue","t":"bool","d":"Support the ability of the container to deserialize the serialized queue objects into the container.","s":["container"],"g":"Container object"},{"n":"cdmi_deserialize_dataobject","t":"bool","d":"Support the ability of the container to deserialize the serialized data objects into the container.","s":["container"],"g":"Container object"},{"n":"cdmi_create_dataobject","t":"bool","d":"Support the ability of the container to add a new data object.","s":["container"],"g":"Container object"},{"n":"cdmi_post_dataobject","t":"bool","d":"Support the ability of the container to add a new data object via POST.","s":["container"],"g":"Container object"},{"n":"cdmi_post_queue","t":"bool","d":"Support the ability of the container to add a new queue object via POST.","s":["container"],"g":"Container object"},{"n":"cdmi_post_container","t":"bool","d":"Supports adding a new container object to this container via POST.","s":["container"],"g":"Container object"},{"n":"cdmi_create_container","t":"bool","d":"Support the ability to create a new container object via PUT.","s":["container"],"g":"Container object"},{"n":"cdmi_copy_queue","t":"bool","d":"Supports the creation of a queue object within this container object by a copy operation.","s":["container"],"g":"Container object"},{"n":"cdmi_move_queue","t":"bool","d":"Supports the creation of a queue object within this container object by a move operation.","s":["container"],"g":"Container object"},{"n":"cdmi_reference_queue","t":"bool","d":"Supports the creation within this container object of a reference whose destination is a queue object.","s":["container"],"g":"Container object"},{"n":"cdmi_reference_dataobject","t":"bool","d":"Supports the creation within this container object of a reference whose destination is a data object.","s":["container"],"g":"Container object"},{"n":"cdmi_copy_dataobject_from_queue","t":"bool","d":"Supports the creation of a data object within this container object by a copy operation whose source is a queue object, as described in the specification.","s":["container"],"g":"Container object"},{"n":"cdmi_create_queue","t":"bool","d":"Support the ability to create new queue objects..","s":["container"],"g":"Container object"},{"n":"cdmi_create_reference","t":"bool","d":"Support the ability to create a new child reference via PUT.","s":["container"],"g":"Container object"},{"n":"cdmi_delete_reference","t":"bool","d":"Support the ability to delete a child reference of the container object, as defined in the specification.","s":["container"],"g":"Container object"},{"n":"cdmi_delete_container","t":"bool","d":"Support the ability to delete a container.","s":["container"],"g":"Container object"},{"n":"cdmi_move_container","t":"bool","d":"Support the ability to move a container object into a container.","s":["container"],"g":"Container object"},{"n":"cdmi_copy_container","t":"bool","d":"Support the ability to copy a container object into a container.","s":["container"],"g":"Container object"},{"n":"cdmi_move_dataobject","t":"bool","d":"Support the ability to move a data object into a container.","s":["container"],"g":"Container object"},{"n":"cdmi_copy_dataobject","t":"bool","d":"Support the ability to copy a data object into a container.","s":["container"],"g":"Container object"},{"n":"cdmi_create_value_range","t":"bool","d":"This capability indicates that the container allows a new data object’s value to be created with byte ranges.","s":["container"],"g":"Container object"},{"n":"cdmi_list_children_extended","t":"bool","d":"Supports the extended child listing of the children of this container object, as defined in the specification.","s":["container"],"g":"Container object"},{"n":"cdmi_list_children_recursive","t":"bool","d":"Supports the recursive child listing of the children of this container object, as defined in the specification.","s":["container"],"g":"Container object"},{"n":"cdmi_create_domain","t":"bool","d":"Support the ability to add a new subdomain.","s":["domain"],"g":"Domain object"},{"n":"cdmi_delete_domain","t":"bool","d":"Support the ability to delete a domain.","s":["domain"],"g":"Domain object"},{"n":"cdmi_move_domain","t":"bool","d":"Support the ability to move a domain.","s":["domain"],"g":"Domain object"},{"n":"cdmi_domain_summary","t":"value","d":"Not defined by this edition. The name is listed here so that it is not reused.","s":["domain"],"g":"Domain object"},{"n":"cdmi_domain_members","t":"value","d":"Not defined by this edition. The name is listed here so that it is not reused.","s":["domain"],"g":"Domain object"},{"n":"cdmi_list_children","t":"bool","d":"Support the ability to list the domain's children.","s":["domain"],"g":"Domain object"},{"n":"cdmi_read_metadata","t":"bool","d":"Support the ability to read the domain's metadata.","s":["domain"],"g":"Domain object"},{"n":"cdmi_modify_metadata","t":"bool","d":"Support the ability to modify the domain's metadata.","s":["domain"],"g":"Domain object"},{"n":"cdmi_modify_deserialize_domain","t":"bool","d":"Support the ability to deserialize a serialized domain object into the domain object as an update.","s":["domain"],"g":"Domain object"},{"n":"cdmi_copy_domain","t":"bool","d":"Support the ability to copy the domain (via PUT) to another URI.","s":["domain"],"g":"Domain object"},{"n":"cdmi_deserialize_domain","t":"bool","d":"Support the ability to deserialize serialized domains and associated serialized children into the domain.","s":["domain"],"g":"Domain object"},{"n":"cdmi_authentication_methods","t":"list","d":"The CDMI server supports authentication methods that are supported by a domain. When present, this capability shall contain one or more of the following JSON strings: * \"anonymous\" - Absence of authentication supported * \"basic…","s":["domain"],"g":"Domain object"},{"n":"cdmi_read_value","t":"bool","d":"Support the ability to read a queue's value.","s":["queue"],"g":"Queue object"},{"n":"cdmi_read_metadata","t":"bool","d":"Support the ability to read the queue's metadata.","s":["queue"],"g":"Queue object"},{"n":"cdmi_modify_value","t":"bool","d":"Supports the appending of one or more values to the queue object and the removal of one or more values from it, as described in the specification and the specification.","s":["queue"],"g":"Queue object"},{"n":"cdmi_modify_metadata","t":"bool","d":"Support the ability to modify the queue's metadata.","s":["queue"],"g":"Queue object"},{"n":"cdmi_modify_deserialize_queue","t":"bool","d":"Support the ability to deserialize a serialized queue into the queue as an update.","s":["queue"],"g":"Queue object"},{"n":"cdmi_delete_queue","t":"bool","d":"Support the ability to delete a queue.","s":["queue"],"g":"Queue object"},{"n":"cdmi_list_children","t":"bool","d":"Support the ability to list the children of the capability object.","s":["capability"],"g":"Capability object"},{"n":"cdmi_list_children_range","t":"bool","d":"Support the ability to list a range of the children of the capability object, as described in the specification.","s":["capability"],"g":"Capability object"},{"n":"cdmi_export_http_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an HTTP export, each a value of an export entry's \"auth_methods\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_anonymous_read","t":"bool","d":"Supports an S3 export that permits unauthenticated read requests, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_http_anonymous_read","t":"bool","d":"Supports an HTTP export that permits read requests that present no credentials, whether through the \"anonymous_read\" field or through an \"auth_method\" field of \"anonymous\", as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_http_certificates","t":"bool","d":"Presents the certificates an HTTP export entry references for its TLS endpoint.","s":["root"],"g":"Exports"},{"n":"cdmi_export_iscsi_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an iSCSI export, each a value of an export entry's \"auth_methods\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an NVMe export, each a value of an export entry's \"auth_methods\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an S3 export, each a value of an export entry's \"auth_methods\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an SMB export, each a value of an export entry's \"auth_methods\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an NFS export, each a value of an export entry's \"security_flavors\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_versions","t":"list","d":"The versions of the NFS protocol the NFS server offers for an export, each spelled as the \"protocol\" or \"protocol_version\" field of an export entry of that type spells it.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_versions","t":"list","d":"The versions of the SMB protocol the SMB server offers for a share, each spelled as the \"protocol\" or \"protocol_version\" field of an export entry of that type spells it.","s":["root"],"g":"Exports"},{"n":"cdmi_export_mqtt_versions","t":"list","d":"The versions of the MQTT protocol the CDMI server negotiates with the broker, each spelled as the \"protocol\" or \"protocol_version\" field of an export entry of that type spells it.","s":["root"],"g":"Exports"},{"n":"cdmi_export_http_versions","t":"list","d":"The versions of the HTTP protocol the CDMI server offers, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Exports"},{"n":"cdmi_export_iscsi_versions","t":"list","d":"The versions of the iSCSI protocol the CDMI server offers, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_versions","t":"list","d":"The versions of the NVMe protocol the CDMI server offers, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_versions","t":"list","d":"The versions of the S3 protocol the CDMI server offers, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb","t":"bool","d":"Supports SMB exports, as defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs","t":"bool","d":"Supports NFS exports, as defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_cdmi","t":"bool","d":"Supports CDMI exports, which serve a container object as its own CDMI namespace.","s":["root"],"g":"Exports"},{"n":"cdmi_export_cdmi_versions","t":"list","d":"The versions of this document the CDMI server serves through a CDMI export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_http_origins","t":"list","d":"The origins at which the CDMI server serves an HTTP export. An HTTP export entry may name only origins that appear here or match a wildcard among them; where the capability is unavailable or empty, no HTTP export may be placed.","s":["root"],"g":"Exports"},{"n":"cdmi_export_cdmi_origins","t":"list","d":"The origins at which the CDMI server serves a CDMI export. A CDMI export entry may name only origins that appear here or match a wildcard among them; where the capability is unavailable or empty, no CDMI export may be placed.","s":["root"],"g":"Exports"},{"n":"cdmi_export_image","t":"bool","d":"Supports image exports, which materialize a container object as a file system image in a data object.","s":["root"],"g":"Exports"},{"n":"cdmi_export_image_versions","t":"list","d":"The file system formats the CDMI server materializes through an image export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_http","t":"bool","d":"Supports HTTP exports, as defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3","t":"bool","d":"Supports S3 exports, as defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_iscsi","t":"bool","d":"Supports iSCSI exports, as defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme","t":"bool","d":"Supports NVMe exports, as defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_mqtt","t":"bool","d":"Supports MQTT exports, as defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_container_smb","t":"bool","d":"An SMB export entry may be placed on the container object.","s":["container"],"g":"Exports"},{"n":"cdmi_export_container_nfs","t":"bool","d":"An NFS export entry may be placed on the container object.","s":["container"],"g":"Exports"},{"n":"cdmi_export_container_http","t":"bool","d":"An HTTP export entry may be placed on the container object.","s":["container"],"g":"Exports"},{"n":"cdmi_export_container_cdmi","t":"bool","d":"A CDMI export entry may be placed on the container object.","s":["container"],"g":"Exports"},{"n":"cdmi_export_container_s3","t":"bool","d":"An S3 export entry may be placed on the container object.","s":["container"],"g":"Exports"},{"n":"cdmi_export_dataobject_iscsi","t":"bool","d":"An iSCSI export entry may be placed on the data object.","s":["dataobject"],"g":"Exports"},{"n":"cdmi_export_dataobject_nvme","t":"bool","d":"An NVMe export entry may be placed on the data object.","s":["dataobject"],"g":"Exports"},{"n":"cdmi_export_queue_mqtt","t":"bool","d":"An MQTT export entry may be placed on the queue object.","s":["queue"],"g":"Exports"},{"n":"cdmi_header_metadata","t":"bool","d":"Transfers user metadata in header fields for a request served through an HTTP export, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_header_metadata_maxitems","t":"value","d":"Contains the maximum number of metadata items that may be contained in header fields.","s":["root"],"g":"Exports"},{"n":"cdmi_header_metadata_maxsize","t":"value","d":"Contains the maximum size, in bytes, of one metadata item contained in a header field.","s":["root"],"g":"Exports"},{"n":"cdmi_header_metadata_maxtotalsize","t":"value","d":"Contains the maximum total size, in bytes, of the metadata items contained in header fields.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_ca","t":"bool","d":"Supports continuous availability for an SMB export, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_dfs","t":"bool","d":"Supports DFS integration for an SMB export, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_shadow_copies","t":"bool","d":"Presents the snapshots of an exported container object as SMB shadow copies, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_xattr","t":"bool","d":"Presents the user metadata of an object reached through an NFS export as extended attributes of the \"user\" namespace, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_xattr_maxname","t":"value","d":"The length in octets of the longest user metadata item name that an NFS export can present as an extended attribute, taking account of the \"user.\" prefix that name carries.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_xattr_maxsize","t":"value","d":"The size in octets of the largest user metadata item value that an NFS export can present as an extended attribute.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_krb5","t":"bool","d":"An SMB export entry may name \"kerberos\" in its \"auth_methods\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_ntlmv2","t":"bool","d":"An SMB export entry may name \"ntlmv2\" in its \"auth_methods\" field.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_ea_maxname","t":"value","d":"The length in octets of the longest user metadata item name that an SMB export can present as an extended attribute.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_ea_maxsize","t":"value","d":"The size in octets of the largest user metadata item value that an SMB export can present as an extended attribute.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_ea","t":"bool","d":"Presents the user metadata of an object reached through an SMB export as extended attributes, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_rdma","t":"bool","d":"Supports NFS over RDMA for an NFS export, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_http_write","t":"bool","d":"Supports an HTTP export that permits requests that modify an object, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_http_form_upload","t":"bool","d":"Creates a data object from a form-based file upload received through an HTTP export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_versioning","t":"bool","d":"Supports S3 versioning for an S3 export, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_virtual_hosted","t":"bool","d":"Supports the virtual hosted addressing style for an S3 export, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_multipart_default_expiry","t":"value","d":"The period the CDMI server applies to the \"multipart_expiry\" field of an S3 export entry that does not specify one, as an ISO 8601 duration.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_multipart_copy","t":"bool","d":"Serves the UploadPartCopy operation for S3 exports.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_multipart_maxparts","t":"value","d":"The largest part number the CDMI server accepts in a multipart upload, as a decimal integer.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_multipart_minpartsize","t":"value","d":"The smallest size in bytes of a part other than the last that the CDMI server accepts when completing a multipart upload, as a decimal integer.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_multipart_maxpartsize","t":"value","d":"The largest size in bytes of a part the CDMI server accepts, as a decimal integer. Where this capability is absent, the value is 5368709120 (5 GiB), which is the limit the S3 API Reference gives.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_metadata_maxtotalsize","t":"value","d":"The aggregate size in bytes of the metadata an S3 export presents for an object, measured as the specification describes, as a decimal integer.","s":["root"],"g":"Exports"},{"n":"cdmi_export_s3_checksums","t":"list","d":"The checksum algorithms the CDMI server verifies on UploadPart and CompleteMultipartUpload requests, using the algorithm names of the S3 API Reference (\"CRC32\", \"CRC32C\", \"CRC64NVME\", \"SHA1\", \"SHA256\").","s":["root"],"g":"Exports"},{"n":"cdmi_export_iscsi_digests","t":"bool","d":"Supports header and data digests for an iSCSI export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_iscsi_ipsec","t":"bool","d":"Supports IPsec protection of an iSCSI export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_iscsi_isns","t":"bool","d":"Supports iSNS registration of an iSCSI export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_iscsi_reservations","t":"bool","d":"Supports SCSI persistent reservations for an iSCSI export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_tcp","t":"bool","d":"Supports the TCP transport for an NVMe export, as described in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_rdma","t":"bool","d":"Supports the RDMA transport for an NVMe export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_tls","t":"bool","d":"Supports TLS protection of an NVMe export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_digests","t":"bool","d":"Supports header and data digests for an NVMe export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_discovery","t":"bool","d":"Supports registration of an NVMe export with a discovery controller.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nvme_reservations","t":"bool","d":"Supports NVMe reservations for an NVMe export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_smb_encryption","t":"bool","d":"Supports SMB transport encryption for an SMB export, as required by the \"encryption\" field defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_krb5","t":"bool","d":"Supports the Kerberos security flavors \"krb5\", \"krb5i\" and \"krb5p\" for an NFS export, as required by the \"security_flavors\" field defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_export_nfs_tls","t":"bool","d":"Supports NFS over TLS for an NFS export.","s":["root"],"g":"Exports"},{"n":"cdmi_export_mqtt_tls","t":"bool","d":"Supports a TLS protected connection to an MQTT broker, as required by the \"tls\" field defined in the specification.","s":["root"],"g":"Exports"},{"n":"cdmi_import_iscsi_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an iSCSI import, each a value of an import entry's \"auth_methods\" field.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nvme_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an NVMe import, each a value of an import entry's \"auth_methods\" field.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nfs_auth_methods","t":"list","d":"The authentication methods the CDMI server accepts for an NFS import, each a value of an import entry's \"security_flavors\" field.","s":["root"],"g":"Imports"},{"n":"cdmi_import_cdmi","t":"bool","d":"Supports the import of a namespace held by a CDMI server, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_cdmi_local","t":"bool","d":"Supports a CDMI import whose import source is a container object it holds itself. If not present, the CDMI server shall report the capability not present condition for such an import entry.","s":["root"],"g":"Imports"},{"n":"cdmi_import_cdmi_remote","t":"bool","d":"Supports a CDMI import whose import source is held by another CDMI server. If not present, the CDMI server shall report the capability not present condition for such an import entry.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nfs","t":"bool","d":"Supports the import of a namespace held by an NFS server, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_smb","t":"bool","d":"Supports the import of a namespace held by an SMB server, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_s3","t":"bool","d":"Supports the import of a namespace held by an S3 server, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_http","t":"bool","d":"Supports the import of a namespace served by an HTTP origin server.","s":["root"],"g":"Imports"},{"n":"cdmi_import_http_versions","t":"list","d":"The versions of HTTP the CDMI server negotiates with the origin server of an HTTP import.","s":["root"],"g":"Imports"},{"n":"cdmi_import_iscsi","t":"bool","d":"Supports the import of a SCSI logical unit, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nvme","t":"bool","d":"Supports the import of an NVMe namespace, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_image","t":"bool","d":"Supports the import of a file system held in the value of a data object, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_mqtt","t":"bool","d":"Supports the import of the messages published to an MQTT topic, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nfs_versions","t":"list","d":"The versions of the NFS protocol the CDMI server negotiates with an import source, each spelled as the \"protocol\" or \"protocol_version\" field of an import entry of that type spells it.","s":["root"],"g":"Imports"},{"n":"cdmi_import_smb_versions","t":"list","d":"The versions of the SMB protocol the CDMI server negotiates with an import source, each spelled as the \"protocol\" or \"protocol_version\" field of an import entry of that type spells it.","s":["root"],"g":"Imports"},{"n":"cdmi_import_mqtt_versions","t":"list","d":"The versions of the MQTT protocol the CDMI server negotiates with an import source, each spelled as the \"protocol\" or \"protocol_version\" field of an import entry of that type spells it.","s":["root"],"g":"Imports"},{"n":"cdmi_import_iscsi_versions","t":"list","d":"The versions of the iSCSI protocol the CDMI server negotiates with an import source, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nvme_versions","t":"list","d":"The versions of the NVMe protocol the CDMI server negotiates with an import source, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Imports"},{"n":"cdmi_import_s3_versions","t":"list","d":"The versions of the S3 protocol the CDMI server negotiates with an import source, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Imports"},{"n":"cdmi_import_cdmi_versions","t":"list","d":"The versions of the CDMI protocol the CDMI server negotiates with an import source, each spelled as the \"protocol\" field of an entry of that type spells it.","s":["root"],"g":"Imports"},{"n":"cdmi_import_cdmi_delegation","t":"bool","d":"Supports delegated identity mode for a CDMI import, as defined in the specification. A CDMI server that implements an import type might be unable to delegate for a remote import of that type, because delegation depends on the t…","s":["root"],"g":"Imports"},{"n":"cdmi_import_nfs_delegation","t":"bool","d":"Supports delegated identity mode for an NFS import, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_smb_delegation","t":"bool","d":"Supports delegated identity mode for an SMB import, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_s3_delegation","t":"bool","d":"Supports delegated identity mode for an S3 import, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_container_cdmi","t":"bool","d":"A CDMI import entry may be placed on this container object.","s":["container"],"g":"Imports"},{"n":"cdmi_import_container_nfs","t":"bool","d":"An NFS import entry may be placed on this container object.","s":["container"],"g":"Imports"},{"n":"cdmi_import_container_smb","t":"bool","d":"An SMB import entry may be placed on this container object.","s":["container"],"g":"Imports"},{"n":"cdmi_import_container_s3","t":"bool","d":"An S3 import entry may be placed on this container object, as defined in the specification.","s":["container"],"g":"Imports"},{"n":"cdmi_import_filesystems","t":"list","d":"Contains the file systems the CDMI server can interpret for a filesystem import, as required by the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_iscsi_digests","t":"bool","d":"Supports iSCSI header and data digests on its connections to the target of an iSCSI import.","s":["root"],"g":"Imports"},{"n":"cdmi_import_iscsi_ipsec","t":"bool","d":"Supports IPsec protection of its connections to the target of an iSCSI import.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nvme_tcp","t":"bool","d":"Supports the NVMe/TCP transport for an NVMe import, as defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nvme_rdma","t":"bool","d":"Supports the NVMe over RDMA transport for an NVMe import.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nvme_tls","t":"bool","d":"Supports TLS protection of its connections to the subsystem of an NVMe import.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nvme_digests","t":"bool","d":"Supports NVMe/TCP header and data digests for an NVMe import.","s":["root"],"g":"Imports"},{"n":"cdmi_import_image_partitions","t":"bool","d":"Can interpret a partition table held in the value of the import source of an image import, as required by the \"partition\" field defined in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_mqtt_tls","t":"bool","d":"Supports a TLS protected connection to the broker of an MQTT import.","s":["root"],"g":"Imports"},{"n":"cdmi_import_container_iscsi","t":"bool","d":"An iSCSI import entry may be placed on this container object.","s":["container"],"g":"Imports"},{"n":"cdmi_import_dataobject_iscsi","t":"bool","d":"An iSCSI import entry may be placed on this data object.","s":["dataobject"],"g":"Imports"},{"n":"cdmi_import_container_nvme","t":"bool","d":"An NVMe import entry may be placed on this container object.","s":["container"],"g":"Imports"},{"n":"cdmi_import_dataobject_nvme","t":"bool","d":"An NVMe import entry may be placed on this data object.","s":["dataobject"],"g":"Imports"},{"n":"cdmi_import_container_image","t":"bool","d":"An image import entry may be placed on this container object.","s":["container"],"g":"Imports"},{"n":"cdmi_import_queue_mqtt","t":"bool","d":"An MQTT import entry may be placed on this queue object.","s":["queue"],"g":"Imports"},{"n":"cdmi_import_cdmi_objectid","t":"bool","d":"An object presented through a CDMI import is addressable by object ID at this CDMI server, as described in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_s3_object_lock","t":"bool","d":"Presents the Object Lock configuration of a key reached through an S3 import as the \"cdmi_retention_id\", \"cdmi_retention_period\", and \"cdmi_hold_id\" provided items, as described in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_s3_listing_cache","t":"bool","d":"An S3 import entry may specify a \"listing_max_age\" field greater than zero, and the CDMI server may enumerate the children of a container object from a listing of the import source no older than that value.","s":["root"],"g":"Imports"},{"n":"cdmi_import_s3_rename","t":"bool","d":"Performs a move of an object presented through an S3 import as a copy of each key affected followed by a delete of each.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nfs_rdma","t":"bool","d":"An NFS import entry may specify a transport of \"rdma\".","s":["root"],"g":"Imports"},{"n":"cdmi_import_smb_krb5","t":"bool","d":"An SMB import entry may specify an authentication method of \"kerberos\". A CDMI server that does not publish this capability shall report the capability not present condition for an import entry that specifies that method, and f…","s":["root"],"g":"Imports"},{"n":"cdmi_import_smb_ntlmv2","t":"bool","d":"An SMB import entry may specify an authentication method of \"ntlmv2\", which shall be used only in service identity mode, as described in the specification.","s":["root"],"g":"Imports"},{"n":"cdmi_import_nfs_xattr","t":"bool","d":"Where the \"cdmi_import_nfs_versions\" capability contains \"NFSv4.2\", the CDMI server presents the extended attributes of the \"user\" namespace of a file reached through an NFS import as user metadata, as described in the specific…","s":["root"],"g":"Imports"},{"n":"cdmi_import_smb_ea","t":"bool","d":"Presents the extended attributes of a file reached through an SMB import as user metadata, as described in the specification.","s":["root"],"g":"Imports"}];

const CLASS_TITLES = (R && R.json("data", "classtitles")) || {
  root:       "Capabilities of the CDMI server as a whole",
  container:  "Operations and features supported for container objects",
  dataobject: "Operations and features supported for data objects",
  queue:      "Operations and features supported for queue objects",
  domain:     "Operations and features supported for domain objects",
  capability: "Operations supported for capability objects"
};

/* ── transport ──────────────────────────────────────────────────────────── */

function authHeaders(extra) {
  const h = Object.assign({}, CTX.headers || {}, extra);      // the desktop passes on the user's Authorization header
  if (CONFIG.bearerToken) h["Authorization"] = "Bearer " + CONFIG.bearerToken;
  return h;
}

async function readJson(transport, url, accept) {
  if (!/^https:/i.test(url)) throw new Error("refused: only https: URIs are read (TLS only)");
  const res = await transport(url, {
    headers: authHeaders({ "Accept": accept }), credentials: "include", redirect: "follow"
  });
  if (res.url && !/^https:/i.test(res.url)) throw new Error("refused: redirected to a URI that is not https:");
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (_) {} }
  if (!res.ok) {
    const err = new Error((json && (json.title || json.detail)) || ("HTTP " + res.status));
    err.status = res.status; throw err;
  }
  return { body: json, url: res.url || url };
}

/* Opened from the desktop, the board reports the disk it was opened from, and the
   context names that base URI. Without a context the base URI is resolved
   from this origin rather than chosen. The discovery tree describes the
   origin that serves it, and a server shall not report a base URI at another
   origin, so the first base URI whose root container object the principal may
   read is the server this page came from. A page served through an HTTP
   export sits within that same origin, which is why asking the origin is
   enough and nothing has to be configured. ?roots= overrides it for the case
   where the page is opened from somewhere else. */
/* The first readable https base URI the discovery tree at treeUrl lists, or null. One extended listing gives every
   reference's destination in its `location` field (revision 297), so the bases are read without a request per
   reference -- and a non-https base is skipped before any fetch, since a page served from an https origin cannot use
   an http base, and following that reference's 307 to it only logs a mixed-content NetworkError. Falls back, for a
   server without the extended listing, to reading the names and following each reference once, still skipping a
   landing that is not https. */
async function firstHttpsBase(transport, treeUrl) {
  try {
    const { body } = await readJson(transport, treeUrl + "?childfields=objectName;location", MT.container);
    const kids = body && body.children;
    if (Array.isArray(kids) && kids.length && Array.isArray(kids[0])) {
      for (const c of kids) {
        const loc = typeof c[1] === "string" ? c[1] : null;
        if (!loc) continue;
        let abs; try { abs = new URL(loc, treeUrl).href; } catch (_) { continue; }
        if (!/^https:/i.test(abs)) continue;                       // skip a non-https base before fetching it
        try {
          const r = await readJson(transport, abs, MT.container);
          if (r.url && /^https:/i.test(r.url)) return r.url.endsWith("/") ? r.url : r.url + "/";
        } catch (_) {}
      }
      return null;                                                 // extended listing worked; no readable https base
    }
  } catch (_) { /* older server: fall through to the plain listing */ }
  const { body } = await readJson(transport, treeUrl, MT.container);
  for (const name of (body.children || [])) {
    try {
      // the name is a path segment as the server listed it, trailing solidus included, so it is not re-encoded;
      // following the reference lands on the root container object and the URL we land on is the base URI
      const r = await readJson(transport, treeUrl + name, MT.container);
      if (r.url && /^https:/i.test(r.url)) return r.url.endsWith("/") ? r.url : r.url + "/";
    } catch (_) {}
  }
  return null;
}

async function resolveBaseUri(transport) {
  if (CONFIG.roots.length) return CONFIG.roots[0];
  if (CTX.baseURI) return CTX.baseURI;
  const base = await firstHttpsBase(transport, ORIGIN + "/.well-known/cdmi/cdmi_namespaces/");
  if (base) return base;
  throw new Error("the discovery tree lists no readable base URI");
}

/* Where a namespace's capability tree actually lives. The tree is the server's, rooted at its CDMI binding base's
   "cdmi_capabilities/"; a sub-namespace -- a home most of all -- holds none of its own, and reading
   "<home>/cdmi_capabilities/" would 404. capabilitiesURI does not help here: a server states it relative to its
   binding base (seedmi returns "/cdmi_capabilities/container/"), so resolving it against the home would drop the
   binding path. Instead recover the binding base straight from the disk's origin discovery tree -- the first base
   URI it lists whose root object is readable -- and walk the capabilities from there. For a disk that already is a
   binding base this returns that same base. */
async function resolveCapabilityBase(transport, base) {
  try {
    const origin = new URL(base).origin;
    const found = await firstHttpsBase(transport, origin + "/.well-known/cdmi/cdmi_namespaces/");
    if (found) return found;
  } catch (_) { /* fall back to the base itself */ }
  return base;
}

/* Walk the capability hierarchy. It is a hierarchy rather than a list, and
   the capability object that describes capability objects addresses itself
   in its capabilitiesURI field, so the walk is bounded by a visited set. */
async function readCapabilityTree(transport, base) {
  const objects = [];
  const seen = new Set();
  const queue = ["cdmi_capabilities/"];
  while (queue.length && objects.length < CONFIG.maxObjects) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const { body } = await readJson(transport, base + path, MT.capability);
    if (!body) continue;
    objects.push({
      path: "/" + path,
      name: body.objectName || path,
      objectID: body.objectID || null,
      capabilities: body.capabilities || {},
      cls: classOf(path, body.objectName)
    });
    for (const child of (body.children || [])) queue.push(path + child);
  }
  return objects;
}

function classOf(path, objectName) {
  if (path === "cdmi_capabilities/") return "root";
  const leaf = String(objectName || path).replace(/\/$/, "").split("/").pop().toLowerCase();
  if (["container", "dataobject", "queue", "domain", "capability"].includes(leaf)) return leaf;
  // a server may publish more than one capability object per class, named as
  // it chooses, so the class is taken from the name where it is recognisable
  for (const k of ["container", "dataobject", "queue", "domain"]) if (leaf.includes(k)) return k;
  return "";
}

/* ── the ballot ─────────────────────────────────────────────────────────── */

function verdictOf(listed, value) {
  if (!listed) return "absent";
  if (value === "true" || value === true) return "present";
  if (value === "false" || value === false) return "withheld";
  return "reported";
}

function displayValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value === null || value === undefined) return "";
  return String(value);
}

function buildBallot(object) {
  const listed = object.capabilities || {};
  const defined = CATALOGUE.filter(c => object.cls && c.s.includes(object.cls));
  const rows = defined.map(c => {
    const has = Object.prototype.hasOwnProperty.call(listed, c.n);
    return {
      name: c.n, form: c.t, meaning: c.d, group: c.g, extension: false,
      listed: has, value: has ? listed[c.n] : undefined,
      verdict: c.t === "bool" ? verdictOf(has, listed[c.n])
                              : (has ? "reported" : "absent")
    };
  });
  const known = new Set(defined.map(c => c.n));
  for (const [name, value] of Object.entries(listed)) {
    if (known.has(name)) continue;
    rows.push({
      name, form: Array.isArray(value) ? "list" : (value === "true" || value === "false") ? "bool" : "value",
      meaning: name.startsWith("cdmi_")
        ? "Not defined by this edition for this class of capability object. The server publishes it here, so it is reported as the server states it."
        : "A capability defined by another organization. Its name carries that organization's reverse domain name, as the specification requires of a capability it does not define.",
      group: "Extension", extension: true,
      listed: true, value, verdict: verdictOf(true, value)
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function tallyOf(rows) {
  const t = { present: 0, withheld: 0, absent: 0, reported: 0 };
  for (const r of rows) t[r.verdict]++;
  return t;
}

/* ── rendering ──────────────────────────────────────────────────────────── */

const ICON = { present: ["g", "+"], withheld: ["r", "−"], absent: ["y", "✕"], reported: ["c", "#"] };
const VERDICT_TEXT = {
  present:  "Present — implemented and provided to you",
  withheld: "Withheld — implemented, not provided to you",
  absent:   "Not implemented by this server",
  reported: "Reported"
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const label = (name) => name.replace(/^cdmi_/, "").replace(/_/g, " ").toUpperCase();

class Board {
  constructor() {
    this.objects = [];
    this.current = 0;
    this.filter = "";
    this.prev = new Map();     // capability name -> verdict, to flash a change
    this.selected = null;
    document.getElementById("filter").addEventListener("input", (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      this.drawBoard();
    });
    document.getElementById("detail").addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeDetail();
    });
  }

  setObjects(objects) {
    const sameItem = this.objects[this.current] && objects[this.current] &&
                     this.objects[this.current].path === objects[this.current].path;
    this.objects = objects;
    if (!sameItem) this.current = Math.min(this.current, Math.max(0, objects.length - 1));
    this.drawTabs();
    this.drawBoard();
  }

  object() { return this.objects[this.current] || null; }

  drawTabs() {
    const tabs = document.getElementById("tabs");
    tabs.textContent = "";
    this.objects.forEach((o, i) => {
      const b = el("button", "tab", o.path);
      b.title = CLASS_TITLES[o.cls] || ("Capabilities published by " + o.path);
      b.type = "button"; b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(i === this.current));
      b.addEventListener("click", () => {
        this.current = i; this.prev.clear(); this.closeDetail();
        this.drawTabs(); this.drawBoard();
      });
      tabs.appendChild(b);
    });
  }

  drawBoard() {
    const board = document.getElementById("board");
    board.textContent = "";
    const o = this.object();
    if (!o) return;

    const rows = buildBallot(o);
    const shown = this.filter
      ? rows.filter(r => r.name.toLowerCase().includes(this.filter) ||
                         r.meaning.toLowerCase().includes(this.filter))
      : rows;

    for (const r of shown) {
      const key = o.path + "|" + r.name;
      const changed = this.prev.has(key) && this.prev.get(key) !== r.verdict;
      this.prev.set(key, r.verdict);

      const b = el("button", "cap s-" + r.verdict + (changed ? " changed" : ""));
      b.type = "button";
      b.setAttribute("aria-label", label(r.name) + ". " + VERDICT_TEXT[r.verdict]);
      const [cls, glyph] = ICON[r.verdict];
      b.appendChild(el("span", "ico " + cls, glyph));
      b.appendChild(el("span", "nm", label(r.name)));
      if (r.verdict === "reported") {
        b.appendChild(el("span", "val", clip(displayValue(r.value), 14)));
      }
      if (r.extension) b.appendChild(el("span", "ext"));
      b.addEventListener("click", () => this.openDetail(r, o));
      board.appendChild(b);
    }

    const t = tallyOf(rows);
    document.getElementById("tPresent").textContent = t.present;
    document.getElementById("tWithheld").textContent = t.withheld;
    document.getElementById("tAbsent").textContent = t.absent;
    document.getElementById("tReported").textContent = t.reported;

    const ext = rows.filter(r => r.extension).length;
    document.getElementById("foot").textContent =
      (CLASS_TITLES[o.cls] || o.path) + " · " + rows.length + " on this ballot" +
      (this.filter ? " · " + shown.length + " shown" : "") +
      (ext ? " · " + ext + " published beyond the annex" : "") +
      (o.objectID ? " · objectID " + o.objectID : "");
  }

  openDetail(row, object) {
    const d = document.getElementById("detail");
    d.textContent = ""; d.classList.add("open"); d.tabIndex = -1;

    d.appendChild(el("h3", null, row.name));
    const meta = el("div", "meta");
    meta.appendChild(el("span", null, row.group));
    meta.appendChild(el("span", null, row.form === "bool" ? "boolean form"
      : row.form === "list" ? "array of supported values" : "stated value"));
    meta.appendChild(el("span", null, "published in " + object.path));
    d.appendChild(meta);
    d.appendChild(el("div", "rule"));

    const v = el("div", "verdict");
    const [cls, glyph] = ICON[row.verdict];
    v.appendChild(el("span", "ico " + cls, glyph));
    v.appendChild(el("span", null, VERDICT_TEXT[row.verdict]));
    v.style.color = { present: "var(--green-lt)", withheld: "var(--red-lt)",
                      absent: "var(--yellow-lt)", reported: "var(--cyan-lt)" }[row.verdict];
    d.appendChild(v);

    if (row.listed) {
      const val = el("p", null, "Listed as: " + displayValue(row.value));
      val.style.color = "var(--cyan-lt)";
      d.appendChild(val);
    }
    d.appendChild(el("p", null, row.meaning));

    const close = el("button", "close", "Close");
    close.type = "button";
    close.addEventListener("click", () => this.closeDetail());
    d.appendChild(close);
    d.focus();
  }

  closeDetail() {
    document.getElementById("detail").classList.remove("open");
  }
}

function clip(s, max) { s = String(s || ""); return s.length > max ? s.slice(0, max - 1) + "…" : s; }

/* ── application ────────────────────────────────────────────────────────── */

class App {
  constructor() {
    this.board = new Board();
    this.live = (u, i) => fetch(u, i);
    this.transport = this.live;
    this.base = null;
    this.reading = false;
    this.lastRead = 0;
    this.error = null;
  }

  async start() {
    setInterval(() => this.clock(), 200);
    this.clock();
    setState("Origin Capabilities: resolving…", false, true);
    this.controls();
    setInterval(() => this.read(), CONFIG.pollInterval);

    try {
      this.home = await resolveBaseUri(this.transport);
    } catch (e) {
      this.error = e.message;
      setState("Origin Capabilities: " + ORIGIN + " — not a CDMI server", true);
      document.getElementById("foot").textContent =
        "The capability hierarchy of this origin could not be read: " + this.error + ".";
      return;
    }
    await this.setBase(this.home);
  }

  /* The disks the desktop has mounted. */
  controls() {
    const disk = document.getElementById("disk");
    const spaces = CTX.namespaces || [];
    for (const n of spaces) {
      const o = el("option", null, n.name + ":");
      o.value = n.baseURI; o.selected = n.baseURI === CTX.baseURI;
      disk.appendChild(o);
    }
    if (spaces.length < 2) disk.style.display = "none";
    disk.addEventListener("change", () => { this.home = disk.value; this.setBase(disk.value); });
  }

  async setBase(base) {
    this.base = base;
    this.board.prev.clear(); this.board.current = 0; this.board.closeDetail();
    const d = (CTX.namespaces || []).find(n => n.baseURI === base);
    if (CTX.setTitle) CTX.setTitle("Capabilities — " + (d ? d.name + ":" : base));
    // The capability tree is the server's, not the selected namespace's: resolve where it lives (a home holds none
    // of its own) once per selection, then read from there.
    try { this.capBase = await resolveCapabilityBase(this.transport, base); } catch (_) { this.capBase = base; }
    await this.read();
  }

  async read() {
    if (this.reading || !this.base) return;
    this.reading = true;
    const base = this.base, capBase = this.capBase || this.base, transport = this.transport;
    setState("Origin Capabilities: " + capBase, false, true);
    try {
      const objects = await readCapabilityTree(transport, capBase);
      if (base !== this.base || transport !== this.transport) { this.reading = false; return this.read(); }
      this.board.setObjects(objects);
      this.lastRead = Date.now();
      this.error = null;
      setState("Origin Capabilities: " + capBase);
    } catch (e) {
      this.error = e.message;
      setState("Origin Capabilities: " + capBase, true);
      document.getElementById("foot").textContent = "Read failed: " + e.message;
    } finally {
      this.reading = false;
    }
  }

  clock() {
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    document.getElementById("date").textContent =
      now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" + p(now.getDate());
    document.getElementById("time").textContent =
      p(now.getHours()) + ":" + p(now.getMinutes()) + ":" + p(now.getSeconds());
  }
}

function setState(text, bad, busy) {
  const s = document.getElementById("state");
  s.textContent = text;
  s.classList.toggle("busy", !!busy);
  s.style.color = bad ? "#ffd9d9" : "#fff";
}

function fitStage() {
  // The window is locked to 16:9, so the board fills it; scale the fixed 1920x1080 design to whatever the client area is.
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.getElementById("stage").style.transform = "scale(" + s + ")";
}
window.addEventListener("resize", fitStage);
fitStage();

if (CTX.aspect) CTX.aspect(1920 / 1080);   // lock the window to the board's 16:9, so it never letterboxes
if (CTX.resize) CTX.resize(1240, 1240 * 1080 / 1920);     // 16:9, the height cvwm will settle to anyway
fitStage();
const app = new App();
app.start();
})();
