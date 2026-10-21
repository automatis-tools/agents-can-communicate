const menus = [...document.querySelectorAll(".site-header details")];
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    for (const menu of menus) if (menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  }
});
for (const menu of menus) menu.addEventListener("click", event => {
  if (event.target.closest("a")) menu.open = false;
});

for (const pre of document.querySelectorAll("pre")) {
  const code = pre.querySelector("code");
  if (!code) continue;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "code-copy";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code");
  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  pre.after(status);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = "Copied";
      status.textContent = "Code copied to clipboard.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = "Selected";
      status.textContent = "Copy was unavailable. The code is selected; copy it with your keyboard.";
    } finally {
      button.disabled = false;
      setTimeout(() => { button.textContent = "Copy"; }, 2500);
    }
  });
  pre.append(button);
}

for (const table of document.querySelectorAll(".table-scroll")) {
  const hint = document.createElement("p");
  hint.className = "table-scroll-hint";
  hint.textContent = "Scroll sideways to see all columns →";
  table.before(hint);
  const update = () => { hint.hidden = table.scrollWidth <= table.clientWidth + 1; };
  update();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(update).observe(table);
}

const recording = document.querySelector("[data-recorded-exchange]");
if (recording) {
  const button = recording.querySelector("[data-recording-replay]");
  const status = recording.querySelector("[data-recording-status]");
  const outputs = [...recording.querySelectorAll("[data-recording-output]")];
  const steps = [...recording.querySelectorAll("[data-recording-at]")];
  const original = new Map(outputs.map(output => [output.dataset.recordingClient, output.textContent]));
  let timers = [], playing = false;
  const showFull = () => {
    timers.forEach(clearTimeout); timers = []; playing = false;
    outputs.forEach(output => { output.textContent = original.get(output.dataset.recordingClient); output.style.minHeight = ""; });
    steps.forEach(step => step.toggleAttribute("data-current", false));
    button.textContent = "Replay exchange";
    status.textContent = "Full recorded exchange.";
  };
  button.hidden = false;
  button.addEventListener("click", () => {
    if (playing || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { showFull(); return; }
    showFull(); playing = true; button.textContent = "Show full exchange";
    status.textContent = "Replaying captured delivery events.";
    outputs.forEach(output => { output.style.minHeight = output.getBoundingClientRect().height + "px"; output.textContent = ""; });
    steps.forEach((step, index) => timers.push(setTimeout(() => {
      steps.forEach(item => item.toggleAttribute("data-current", item === step));
      if (step.dataset.recordingKind === "recorded") {
        const output = outputs.find(item => item.dataset.recordingClient === step.dataset.recordingClient);
        output.textContent = original.get(step.dataset.recordingClient);
      }
      status.textContent = step.dataset.recordingLabel;
      if (index === steps.length - 1) {
        playing = false; button.textContent = "Replay exchange";
        status.textContent = "Replay complete. Full recorded exchange.";
      }
    }, Number(step.dataset.recordingAt))));
  });
}

function normalizeSearch(value) {
  return String(value).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function rankSearch(records, query) {
  const phrase = normalizeSearch(query);
  const terms = [...new Set(phrase.split(" ").filter(Boolean))];
  if (!terms.length) return records;
  const inField = (words, term) => words.some(word => word.startsWith(term));
  return records.map((article, order) => {
    const title = normalizeSearch(article.title), description = normalizeSearch(article.description);
    const titleWords = title.split(" "), descriptionWords = description.split(" ");
    const bodyWords = normalizeSearch(article.text).split(" ");
    if (!terms.every(term => inField(titleWords, term) || inField(descriptionWords, term) || inField(bodyWords, term))) return null;
    let score = terms.reduce((sum, term) => sum + (inField(titleWords, term) ? 12
      : inField(descriptionWords, term) ? 3 : 1), 0);
    if ((" " + title + " ").includes(" " + phrase + " ")) score += 18;
    // A client-name query should lead to its dedicated integration page.
    const slug = normalizeSearch(article.route.split("/").filter(Boolean).at(-1));
    if (slug === phrase) score += 40;
    return { article, score, order };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.order - b.order).map(item => item.article);
}

const form = document.querySelector("[data-search-form]");
if (form) {
  const field = form.querySelector("input");
  const status = document.querySelector("[data-search-status]");
  const empty = document.querySelector("[data-search-empty]");
  const results = [...document.querySelectorAll("[data-search-result]")];
  const unavailable = "Search is unavailable. All articles are listed below.";
  let index;
  let timer;
  const loaded = fetch("/search-index.json", { signal: AbortSignal.timeout(5000) })
    .then(response => { if (!response.ok) throw new Error("unavailable"); return response.json(); })
    .then(data => {
      if (!Array.isArray(data)) throw new Error("invalid index");
      index = data;
    }).catch(() => {
      status.textContent = unavailable;
    });
  async function search() {
    const query = field.value.trim().slice(0, 200);
    if (query) status.textContent = "Searching…";
    await loaded;
    if (!index) { status.textContent = unavailable; return; }
    const ranked = rankSearch(index, query);
    const matching = new Set(ranked.map(article => article.route));
    const byRoute = new Map(results.map(result => [result.dataset.searchResult, result]));
    for (const result of results) result.hidden = !matching.has(result.dataset.searchResult);
    const container = document.querySelector(".search-results");
    for (const article of ranked) {
      const result = byRoute.get(article.route);
      if (result) container.append(result);
    }
    const count = ranked.length;
    empty.hidden = count !== 0;
    status.textContent = query ? count + (count === 1 ? " article" : " articles") + " found."
      : "Browse all " + results.length + " articles below.";
    history.replaceState(null, "", "/search/" + (query ? "?q=" + encodeURIComponent(query) : ""));
  }
  form.addEventListener("submit", event => { event.preventDefault(); clearTimeout(timer); search(); });
  field.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 140); });
  field.value = (new URLSearchParams(location.search).get("q") ?? "").slice(0, 200);
  if (field.value) search();
}
