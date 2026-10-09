// Antigravity consumes ANSI from a command whose stdout is a pipe, not a TTY.
// Foreground and intensity affect only the glyph. Never set a background.
export function renderAntigravityIndicator(report) {
  const rgb = report.health === "ready" ? "44;122;57"
    : report.health === "problem" ? "150;108;30" : "102;102;102";
  return report.label.replace(/^ACC ([●!…])/u,
    (_, glyph) => `ACC \x1b[22;1;38;2;${rgb}m${glyph}\x1b[22;39m`);
}
