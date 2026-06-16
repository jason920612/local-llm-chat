import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath =
  process.env.LAN_HTTPS_CONFIG ?? path.join(repoRoot, "certs", "lan-https.json");

if (!fs.existsSync(configPath)) {
  console.error(
    `Missing ${configPath}. Run: npm run https:setup -- -IpAddress 192.168.x.x`,
  );
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const target = new URL(process.env.LAN_HTTPS_TARGET ?? config.target);
const listenHost = process.env.LAN_HTTPS_HOST ?? "0.0.0.0";
const listenPort = Number(process.env.LAN_HTTPS_PORT ?? config.port ?? 3443);

const server = https.createServer(
  {
    cert: fs.readFileSync(config.cert),
    key: fs.readFileSync(config.key),
  },
  (req, res) => {
    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: target.host,
          "x-forwarded-proto": "https",
          "x-forwarded-host": req.headers.host ?? "",
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`HTTPS proxy target error: ${err.message}`);
    });

    req.pipe(upstream);
  },
);

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries({
          ...req.headers,
          host: target.host,
          "x-forwarded-proto": "https",
          "x-forwarded-host": req.headers.host ?? "",
        })
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", () => socket.destroy());
});

server.listen(listenPort, listenHost, () => {
  console.log(`LAN HTTPS proxy: https://${config.ip}:${listenPort}`);
  console.log(`Forwarding to: ${target.href}`);
});
