// Standalone Cloudflare Pages advanced-mode adapter, copied to dist/_worker.js.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const aliases = ["getacc.app", "www.getacc.app", "www.getacc.dev"];
    if (aliases.includes(url.hostname) || (url.hostname === "getacc.dev" && url.protocol !== "https:")) {
      url.protocol = "https:";
      url.host = "getacc.dev";
      return Response.redirect(url.href, 301);
    }
    const response = await env.ASSETS.fetch(request);
    const markdown = url.pathname.endsWith("/index.md") && response.status === 200;
    if (markdown || (url.hostname !== "getacc.dev" && response.headers.get("content-type")?.includes("text/html"))) {
      const headers = new Headers(response.headers);
      headers.set("X-Robots-Tag", "noindex");
      if (markdown) {
        headers.set("Content-Type", "text/markdown; charset=utf-8");
        headers.set("Link", '<https://getacc.dev' + url.pathname.slice(0, -8) + '>; rel="canonical"');
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};
