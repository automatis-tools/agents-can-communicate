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
    if (url.hostname !== "getacc.dev" && response.headers.get("content-type")?.includes("text/html")) {
      const headers = new Headers(response.headers);
      headers.set("X-Robots-Tag", "noindex");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};
