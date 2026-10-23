// Локальный просмотр фронта с настоящим бэкендом: статика из корня проекта + /api/cardinar/* -> бэкенд /api/*.
// Запуск: PORT=48xxx BACKEND_PORT=48yyy node scripts/dev-serve.mjs  (слушает только 127.0.0.1)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const port = +process.env.PORT || 48100;
const backendPort = +process.env.BACKEND_PORT || 48333;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/cardinar/")) {
    const pr = http.request({ host: "127.0.0.1", port: backendPort, path: "/api" + req.url.slice("/api/cardinar".length), method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${backendPort}` } }, (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); });
    pr.on("error", () => { res.writeHead(502); res.end("backend down"); });
    return req.pipe(pr);
  }
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path === "/" ? "index.html" : path);
  if (!file.startsWith(root) || /\/\.(git|notes|deploy)/.test(file)) { res.writeHead(403); return res.end(); }
  try { const body = await readFile(file); res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }); res.end(body); }
  catch { res.writeHead(404); res.end("not found"); }
}).listen(port, "127.0.0.1", () => console.log(`front http://127.0.0.1:${port} -> backend :${backendPort}`));
