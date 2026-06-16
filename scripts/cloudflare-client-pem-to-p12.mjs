import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import forge from "node-forge";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function argValue(name, fallback = "") {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const certPath = argValue("--cert");
const keyPath = argValue("--key");
const outPath = path.resolve(
  repoRoot,
  argValue("--out", "certs/cloudflare-client.client.p12"),
);
const password =
  argValue("--password") || crypto.randomBytes(12).toString("base64url");
const friendlyName = argValue("--name", "Cloudflare mTLS client");

if (!certPath || !keyPath) {
  console.error(
    "Usage: node scripts/cloudflare-client-pem-to-p12.mjs --cert cert.pem --key key.pem --out certs/phone.p12 [--password password]",
  );
  process.exit(1);
}

const certPem = fs.readFileSync(path.resolve(repoRoot, certPath), "utf8");
const keyPem = fs.readFileSync(path.resolve(repoRoot, keyPath), "utf8");
const cert = forge.pki.certificateFromPem(certPem);
const key = forge.pki.privateKeyFromPem(keyPem);
const p12Asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, {
  algorithm: "3des",
  friendlyName,
});
const p12Der = forge.asn1.toDer(p12Asn1).getBytes();

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(p12Der, "binary"));

console.log(`Created: ${outPath}`);
console.log(`Password: ${password}`);
