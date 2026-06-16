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

function randomSerial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^0+/, "");
}

const certDir = path.resolve(repoRoot, argValue("--cert-dir", "certs"));
const commonName = argValue("--name", "jason-phone");
const password =
  argValue("--password") || crypto.randomBytes(12).toString("base64url");

fs.mkdirSync(certDir, { recursive: true });

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const caExpiry = new Date(now);
caExpiry.setFullYear(caExpiry.getFullYear() + 10);
const clientExpiry = new Date(now);
clientExpiry.setFullYear(clientExpiry.getFullYear() + 3);

const caKeys = forge.pki.rsa.generateKeyPair(2048);
const caCert = forge.pki.createCertificate();
caCert.publicKey = caKeys.publicKey;
caCert.serialNumber = randomSerial();
caCert.validity.notBefore = yesterday;
caCert.validity.notAfter = caExpiry;
caCert.setSubject([
  { name: "commonName", value: "local-llm-chat Cloudflare mTLS Client CA" },
]);
caCert.setIssuer(caCert.subject.attributes);
caCert.setExtensions([
  { name: "basicConstraints", cA: true, critical: true },
  {
    name: "keyUsage",
    keyCertSign: true,
    cRLSign: true,
    digitalSignature: true,
    critical: true,
  },
  { name: "subjectKeyIdentifier" },
]);
caCert.sign(caKeys.privateKey, forge.md.sha256.create());

const clientKeys = forge.pki.rsa.generateKeyPair(2048);
const clientCert = forge.pki.createCertificate();
clientCert.publicKey = clientKeys.publicKey;
clientCert.serialNumber = randomSerial();
clientCert.validity.notBefore = yesterday;
clientCert.validity.notAfter = clientExpiry;
clientCert.setSubject([{ name: "commonName", value: commonName }]);
clientCert.setIssuer(caCert.subject.attributes);
clientCert.setExtensions([
  { name: "basicConstraints", cA: false, critical: true },
  {
    name: "keyUsage",
    digitalSignature: true,
    keyEncipherment: true,
    critical: true,
  },
  { name: "extKeyUsage", clientAuth: true },
  { name: "authorityKeyIdentifier", keyIdentifier: true },
]);
clientCert.sign(caKeys.privateKey, forge.md.sha256.create());

const caPemPath = path.join(certDir, "cloudflare-mtls-client-ca.pem");
const caKeyPath = path.join(certDir, "cloudflare-mtls-client-ca.key");
const clientPemPath = path.join(certDir, `${commonName}.client.crt`);
const clientKeyPath = path.join(certDir, `${commonName}.client.key`);
const clientP12Path = path.join(certDir, `${commonName}.client.p12`);
const readmePath = path.join(certDir, "cloudflare-mtls-client.README.txt");

fs.writeFileSync(caPemPath, forge.pki.certificateToPem(caCert));
fs.writeFileSync(caKeyPath, forge.pki.privateKeyToPem(caKeys.privateKey));
fs.writeFileSync(clientPemPath, forge.pki.certificateToPem(clientCert));
fs.writeFileSync(clientKeyPath, forge.pki.privateKeyToPem(clientKeys.privateKey));

const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
  clientKeys.privateKey,
  [clientCert, caCert],
  password,
  {
    algorithm: "3des",
    friendlyName: `local-llm-chat ${commonName}`,
  },
);
const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
fs.writeFileSync(clientP12Path, Buffer.from(p12Der, "binary"));

fs.writeFileSync(
  readmePath,
  [
    "Cloudflare Access mTLS files",
    "",
    `Upload this CA certificate to Cloudflare Access mTLS: ${caPemPath}`,
    `Install this client certificate on the phone/browser: ${clientP12Path}`,
    `Client certificate password: ${password}`,
    "",
    "Keep the CA private key and client private key secret.",
  ].join("\n"),
);

console.log("Created Cloudflare mTLS client credentials");
console.log(`CA for Cloudflare Access: ${caPemPath}`);
console.log(`Client cert for phone/browser: ${clientP12Path}`);
console.log(`Client cert password: ${password}`);
