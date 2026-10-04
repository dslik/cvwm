// kms-make-dac-keys.mjs -- create the two key pairs of seedmi's delegated-access-control identity at seedmi-kms.
//
// setup-cvwm.py runs this once, when --with-dac is given, after seedmi-kms is up. It uses seedmi's own KMIP client
// (KmipKms in seedmi/src/kms.ts), so it stays correct with the release it is run against rather than re-implementing
// KMIP here. It creates an RSA-2048 signing pair and an RSA-2048 encryption pair, names each with the id seedmi's
// [dac] refers to, and activates the private keys. Idempotency is the caller's concern: it is run on a fresh KMS store.
//
// Usage:
//   node kms-make-dac-keys.mjs --seedmi <dir> --host 127.0.0.1 --port 5696 \
//        --ca <pem> --cert <pem> --key <pem> --label primary \
//        --sign-id cdmi/root/dac-sign --enc-id cdmi/root/dac-enc
//
// It prints one line per key created ("created <id>") and exits non-zero on failure, with the reason on stderr.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const seedmiDir = arg("seedmi");
if (!seedmiDir) { process.stderr.write("kms-make-dac-keys: --seedmi <dir> is required\n"); process.exit(2); }
const host = arg("host", "127.0.0.1");
const port = parseInt(arg("port", "5696"), 10);
const label = arg("label", "primary");
const signId = arg("sign-id", "cdmi/root/dac-sign");
const encId = arg("enc-id", "cdmi/root/dac-enc");
const caFile = arg("ca"), certFile = arg("cert"), keyFile = arg("key");
const outSignPub = arg("out-sign-pub");   // where to write the signing key's public half (PEM SPKI), for the DAC [[server]]
if (!caFile || !certFile || !keyFile) { process.stderr.write("kms-make-dac-keys: --ca, --cert and --key are required\n"); process.exit(2); }

// Import seedmi's KMIP client and attribute builders from the release tree.
const src = path.join(seedmiDir, "src");
const { KmipKms } = await import(pathToFileURL(path.join(src, "kms.ts")).href);
const { attribute } = await import(pathToFileURL(path.join(src, "kmip-message.ts")).href);
const { k, child } = await import(pathToFileURL(path.join(src, "kmip-ttlv.ts")).href);

const kms = new KmipKms({
  label, host, port,
  ca: readFileSync(caFile, "utf8"),
  certificate: readFileSync(certFile, "utf8"),
  key: readFileSync(keyFile, "utf8"),
  timeoutMs: 5000,
});

// Cryptographic Usage Mask values (KMIP): 0x01 Sign, 0x02 Verify, 0x04 Encrypt, 0x08 Decrypt.
async function makePair(name, privUsage, pubUsage) {
  const made = await kms.createKeyPair({
    common: [
      attribute(k.enum("Cryptographic Algorithm", "Cryptographic Algorithm", "RSA")),
      attribute(k.int("Cryptographic Length", 2048)),
    ],
    privateKey: [
      attribute(k.struct("Name", [
        k.text("Name Value", name),
        k.enum("Name Type", "Name Type", "Uninterpreted Text String"),
      ])),
      attribute(k.int("Cryptographic Usage Mask", privUsage)),
      attribute(k.bool("Sensitive", true)),
      attribute(k.bool("Extractable", false)),
    ],
    publicKey: [attribute(k.int("Cryptographic Usage Mask", pubUsage))],
  });
  await kms.activate(made.privateKey);
  process.stdout.write("created " + name + "\n");
  return made;
}

// Export a public key held at the KMS as a PEM SPKI string -- what the DAC provider registers to authenticate seedmi.
async function exportPublicPem(publicKeyId) {
  const got = await kms.get(publicKeyId);
  const block = child(got.object, "Key Block");
  const material = child(child(block, "Key Value"), "Key Material").value;
  const format = child(block, "Key Format Type").value;
  const pub = createPublicKey({ key: material, format: "der", type: format === 3 ? "pkcs1" : "spki" });
  return pub.export({ format: "pem", type: "spki" });
}

try {
  const signing = await makePair(signId, 0x01, 0x02);   // signing: private Sign, public Verify
  await makePair(encId, 0x08, 0x04);    // unwrapping: private Decrypt, public Encrypt (RSA, per ECR-113A)
  if (outSignPub) { const pem = await exportPublicPem(signing.publicKey); writeFileSync(outSignPub, pem); process.stdout.write("wrote signing public key to " + outSignPub + "\n"); }
  process.exit(0);
} catch (e) {
  process.stderr.write("kms-make-dac-keys: " + (e && e.message ? e.message : String(e)) + "\n");
  process.exit(1);
}
