import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "./build.mjs";
import worker from "./worker.mjs";

const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
};

export function createPreviewServer({ directory = path.join(import.meta.dirname, "dist"), noindex = true } = {}) {
  const root = path.resolve(directory);
  const physicalRoot = realpath(root);
  async function notFound(method) {
    const body = await readFile(path.join(root, "404.html")).catch(() => Buffer.from("Page not found"));
    return new Response(method === "HEAD" ? null : body, { status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  async function assets(request) {
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return notFound(request.method); }
    if (pathname.includes("\0") || pathname.includes("\\")
      || pathname.split("/").some(segment => segment.startsWith("."))) return notFound(request.method);
    let file = path.resolve(root, "." + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) return notFound(request.method);
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        if (!url.pathname.endsWith("/")) {
          return new Response(null, { status: 301, headers: { Location: url.pathname + "/" + url.search } });
        }
        file = path.join(file, "index.html");
        info = await stat(file);
      }
      const physicalFile = await realpath(file);
      if (!physicalFile.startsWith(await physicalRoot + path.sep) || !info.isFile()) return notFound(request.method);
      return new Response(request.method === "HEAD" ? null : await readFile(file), {
        headers: { "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
          "Content-Length": String(info.size), "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff" },
      });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EINVAL"].includes(error.code)) return notFound(request.method);
      throw error;
    }
  }
  return createServer(async (incoming, outgoing) => {
    try {
      if (!["GET", "HEAD"].includes(incoming.method)) {
        outgoing.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
        return;
      }
      const request = new Request("http://" + (incoming.headers.host ?? "localhost") + incoming.url,
        { method: incoming.method });
      const response = await worker.fetch(request, { ASSETS: { fetch: assets } });
      const headers = new Headers(response.headers);
      if (!noindex) headers.delete("x-robots-tag");
      outgoing.writeHead(response.status, Object.fromEntries(headers));
      outgoing.end(incoming.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error("Preview request failed:", error.message);
      outgoing.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Preview request failed");
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = args.length === 2 && args[0] === "--port" ? Number(args[1]) : args.length ? NaN : 4321;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("usage: node website/serve.mjs [--port 0..65535]");
  await buildSite();
  const server = createPreviewServer();
  server.listen(port, "127.0.0.1", () => console.log("ACC website preview: http://127.0.0.1:" + server.address().port));
}
