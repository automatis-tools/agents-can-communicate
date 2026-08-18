/**
 * One name for one file.
 *
 * A claim is a string, and a file has many spellings: `src/a.mjs`,
 * `./src/a.mjs`, `src//a.mjs`, `src/x/../a.mjs`. All four name the same file and
 * none of them matched the others, so a claim written one way protected nothing
 * against a write spelled another - the claim was taken, `acc status` reported
 * `protection guarded`, and the write went through.
 *
 * Only the path part of a `file:` resource is touched. Other schemes are opaque
 * identifiers, and rewriting one would be inventing meaning ACC does not have.
 * A trailing `/**` is a glob and is preserved: the segments before it are
 * normalised, the marker is put back.
 */
const GLOB = "/**";

function normalisePath(value) {
  const segments = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    // `..` climbing past the start is kept, not swallowed: the result would name
    // something outside the workspace, and a resource that cannot be relativised
    // must stay visibly wrong rather than quietly become a different file.
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function normaliseResource(resource) {
  if (typeof resource !== "string") return resource;
  const colon = resource.indexOf(":");
  if (colon === -1 || resource.slice(0, colon) !== "file") return resource;

  const rest = resource.slice(colon + 1);
  const glob = rest.endsWith(GLOB);
  const body = glob ? rest.slice(0, -GLOB.length) : rest;
  // An absolute path keeps its leading slash: it names a different thing from
  // the relative path with the same spelling, and pretending otherwise would
  // merge two resources that are not the same.
  const absolute = body.startsWith("/");
  const normalised = normalisePath(body);
  if (normalised === "" && !glob) return resource;
  return `file:${absolute ? "/" : ""}${normalised}${glob ? GLOB : ""}`;
}
