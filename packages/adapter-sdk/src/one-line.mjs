// What a reader may take as the end of a line. The protocol refuses C0 controls
// in a one-line field such as a subject, so CR and LF reach a header only from
// data written outside it; NEL (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH
// SEPARATOR (U+2029) pass validation. A peer could otherwise end a header line
// early and write one that imitates `sender:` or `obligation:` (#200).
const BREAKS = /\r\n|[\r\n\u0085\u2028\u2029]/g;

/** The value on one line, each break written as a visible escape. */
export function oneLine(value) {
  return String(value).replace(BREAKS, found => found.length === 2 || found === "\n" || found === "\r"
    ? "\\n" : `\\u${found.codePointAt(0).toString(16).padStart(4, "0")}`);
}
