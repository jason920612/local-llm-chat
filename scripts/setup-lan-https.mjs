import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function detectLanIp() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return "";
}

function randomSerial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^0+/, "");
}

function writeDerCertificate(cert, filePath) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  fs.writeFileSync(filePath, Buffer.from(der, "binary"));
}

const ip = argValue("--ip", argValue("-IpAddress", detectLanIp()));
const certDir = path.resolve(repoRoot, argValue("--cert-dir", "certs"));
const port = Number(argValue("--port", "3443"));
const trustWindows = process.argv.includes("--trust-windows");

if (!ip) {
  console.error("Could not detect a LAN IPv4 address. Pass --ip 192.168.x.x.");
  process.exit(1);
}

fs.mkdirSync(certDir, { recursive: true });

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const rootExpiry = new Date(now);
rootExpiry.setFullYear(rootExpiry.getFullYear() + 5);
const serverExpiry = new Date(now);
serverExpiry.setFullYear(serverExpiry.getFullYear() + 2);

const rootKeys = forge.pki.rsa.generateKeyPair(2048);
const rootCert = forge.pki.createCertificate();
rootCert.publicKey = rootKeys.publicKey;
rootCert.serialNumber = randomSerial();
rootCert.validity.notBefore = yesterday;
rootCert.validity.notAfter = rootExpiry;
rootCert.setSubject([{ name: "commonName", value: "local-llm-chat Dev Root CA" }]);
rootCert.setIssuer(rootCert.subject.attributes);
rootCert.setExtensions([
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
rootCert.sign(rootKeys.privateKey, forge.md.sha256.create());

const serverKeys = forge.pki.rsa.generateKeyPair(2048);
const serverCert = forge.pki.createCertificate();
serverCert.publicKey = serverKeys.publicKey;
serverCert.serialNumber = randomSerial();
serverCert.validity.notBefore = yesterday;
serverCert.validity.notAfter = serverExpiry;
serverCert.setSubject([{ name: "commonName", value: "local-llm-chat LAN" }]);
serverCert.setIssuer(rootCert.subject.attributes);
serverCert.setExtensions([
  {
    name: "subjectAltName",
    altNames: [
      { type: 2, value: "localhost" },
      { type: 2, value: os.hostname() },
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip },
    ],
  },
  { name: "basicConstraints", cA: false, critical: true },
  {
    name: "keyUsage",
    digitalSignature: true,
    keyEncipherment: true,
    critical: true,
  },
  { name: "extKeyUsage", serverAuth: true },
  { name: "authorityKeyIdentifier", keyIdentifier: true },
]);
serverCert.sign(rootKeys.privateKey, forge.md.sha256.create());

const rootCerPath = path.join(certDir, "local-llm-chat-root-ca.cer");
const rootPemPath = path.join(certDir, "local-llm-chat-root-ca.pem");
const serverCertPath = path.join(certDir, "local-llm-chat-lan.crt");
const serverKeyPath = path.join(certDir, "local-llm-chat-lan.key");
const configPath = path.join(certDir, "lan-https.json");

writeDerCertificate(rootCert, rootCerPath);
fs.writeFileSync(rootPemPath, forge.pki.certificateToPem(rootCert));
fs.writeFileSync(serverCertPath, forge.pki.certificateToPem(serverCert));
fs.writeFileSync(serverKeyPath, forge.pki.privateKeyToPem(serverKeys.privateKey));
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      ip,
      port,
      target: "http://127.0.0.1:3000",
      cert: serverCertPath,
      key: serverKeyPath,
      rootCertificate: rootCerPath,
    },
    null,
    2,
  ),
);

if (process.platform === "win32" && trustWindows) {
  const command = [
    "Import-Certificate",
    "-FilePath",
    `'${rootCerPath.replaceAll("'", "''")}'`,
    "-CertStoreLocation",
    "Cert:\\CurrentUser\\Root",
  ].join(" ");
  childProcess.execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: "ignore",
  });
}

console.log(`Created LAN HTTPS certificate for ${ip}`);
console.log(`HTTPS URL: https://${ip}:${port}`);
console.log(`Install this CA on phones: ${rootCerPath}`);
if (process.platform === "win32") {
  console.log(
    "Optional Windows trust: rerun with --trust-windows and confirm the Windows security prompt.",
  );
}
