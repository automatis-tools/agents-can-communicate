import { Marked, Renderer } from "marked";
import { escapeHtml, plainText } from "./config.mjs";

export function safeLink(href) {
  if (typeof href !== "string" || /[\u0000-\u0020\u007f\\]/.test(href)
    || href.startsWith("//")) throw new Error("unsafe link: " + href);
  const url = new URL(href, "https://getacc.dev/");
  if (!["https:", "mailto:"].includes(url.protocol)) throw new Error("unsafe link: " + href);
  return escapeHtml(href);
}

export function renderMarkdown(markdown) {
  const headings = [];
  const slugs = new Map();
  const parser = new Marked({
    gfm: true,
    renderer: {
      html({ text }) { return escapeHtml(text); },
      heading({ tokens, depth }) {
        if (depth === 1) return "";
        const inline = this.parser.parseInline(tokens);
        const text = plainText(inline);
        const base = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-") || "section";
        const count = slugs.get(base) ?? 0;
        slugs.set(base, count + 1);
        const id = base + (count ? "-" + (count + 1) : "");
        headings.push({ id, text, depth });
        return '<h' + depth + ' id="' + id + '">' + inline
          + '<a class="heading-anchor" href="#' + id + '" aria-label="Link to '
          + escapeHtml(text) + '">#</a></h' + depth + '>\n';
      },
      link({ href, title, tokens }) {
        return '<a href="' + safeLink(href) + '"'
          + (title ? ' title="' + escapeHtml(title) + '"' : "") + ">"
          + this.parser.parseInline(tokens) + "</a>";
      },
      image({ href, text, title }) {
        return '<img src="' + safeLink(href) + '" alt="' + escapeHtml(text)
          + '"' + (title ? ' title="' + escapeHtml(title) + '"' : "")
          + ' loading="lazy" decoding="async">';
      },
      table(token) {
        return '<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table">'
          + Renderer.prototype.table.call(this, token) + "</div>";
      },
    },
  });
  const tokens = parser.lexer(markdown);
  // Keep the complete single-pass rendering as an independent content baseline.
  // Typed layouts use the top-level blocks; preservation checks compare both.
  const html = parser.parser(tokens);
  const allHeadings = [...headings];
  headings.length = 0;
  slugs.clear();
  const introduction = [];
  const groups = [];
  let current = introduction;
  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 2) {
      current = [];
      groups.push(current);
    }
    current.push(token);
  }
  const introHtml = parser.parser(introduction);
  const sections = groups.map(([heading, ...body]) => {
    const position = headings.length;
    const headingHtml = parser.parser([heading]);
    const bodyHtml = parser.parser(body);
    return { ...headings[position], headingHtml, bodyHtml,
      html: headingHtml + bodyHtml, hasTable: bodyHtml.includes("<table>") };
  });
  return { html, introHtml, sections, headings: allHeadings };
}
