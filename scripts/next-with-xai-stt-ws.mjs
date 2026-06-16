import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import next from "next";
import { WebSocket, WebSocketServer } from "ws";

const require = createRequire(import.meta.url);

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const root = process.cwd();
loadEnvFile(path.join(root, ".env"));
loadEnvFile(path.join(root, ".env.local"));

function markInterruptedGenerations() {
  try {
    const Database = require("better-sqlite3");
    const dbPath = path.join(root, "data", "app.db");
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath);
    const result = db
      .prepare(
        `UPDATE messages
            SET status = 'error'
          WHERE status = 'streaming'`,
      )
      .run();
    db.close();
    if (result.changes > 0) {
      console.warn(
        `Marked ${result.changes} interrupted generation(s) as error.`,
      );
    }
  } catch (err) {
    console.warn(
      `Could not mark interrupted generations: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

markInterruptedGenerations();

const dev = false;
const host = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();
const wss = new WebSocketServer({ noServer: true });

function boolParam(v, fallback) {
  if (v == null) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function sttTargetUrl(reqUrl) {
  const incoming = new URL(reqUrl, `http://${host}:${port}`);
  const target = new URL("wss://api.x.ai/v1/stt");
  const sampleRate = Number(incoming.searchParams.get("sample_rate") || 16000);
  const smartTurn = Number(
    incoming.searchParams.get("smart_turn") ||
      process.env.XAI_STT_SMART_TURN ||
      0.7,
  );
  const smartTurnTimeout = Number(
    incoming.searchParams.get("smart_turn_timeout") ||
      process.env.XAI_STT_SMART_TURN_TIMEOUT_MS ||
      3000,
  );

  target.searchParams.set("sample_rate", String(sampleRate));
  target.searchParams.set("encoding", "pcm");
  target.searchParams.set(
    "interim_results",
    String(boolParam(incoming.searchParams.get("interim_results"), true)),
  );
  target.searchParams.set("endpointing", incoming.searchParams.get("endpointing") || "250");
  if (smartTurn > 0) {
    target.searchParams.set("smart_turn", String(smartTurn));
    target.searchParams.set("smart_turn_timeout", String(smartTurnTimeout));
  }
  const language = incoming.searchParams.get("language");
  if (language) target.searchParams.set("language", language);
  return target;
}

function writeUpgradeError(socket, status, message) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`,
  );
  socket.destroy();
}

function proxyStt(client, req) {
  if (!boolParam(process.env.XAI_STT_STREAMING, true)) {
    client.send(JSON.stringify({ type: "error", error: "Streaming STT disabled" }));
    client.close(1008, "disabled");
    return;
  }
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    client.send(JSON.stringify({ type: "error", error: "XAI_API_KEY not set" }));
    client.close(1011, "missing api key");
    return;
  }

  const upstream = new WebSocket(sttTargetUrl(req.url), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const queued = [];
  let upstreamOpen = false;

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const data of queued.splice(0)) upstream.send(data);
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code, reason) => {
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
  });
  upstream.on("error", (err) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "error",
          error: err instanceof Error ? err.message : "xAI STT websocket error",
        }),
      );
      client.close(1011, "upstream error");
    }
  });

  client.on("message", (data, isBinary) => {
    const payload = isBinary ? data : data.toString();
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(payload, { binary: isBinary });
    } else {
      queued.push(payload);
    }
  });
  client.on("close", () => {
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close();
    }
  });
}

await app.prepare();

const server = http.createServer((req, res) => handle(req, res));
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/stt/stream") {
    writeUpgradeError(socket, 404, "Not Found");
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => proxyStt(client, req));
});

server.listen(port, host, () => {
  console.log(`Next + xAI STT WS ready on http://${host}:${port}`);
});
