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
  const button = recording.querySelector("[data-exchange-play]");
  const controls = recording.querySelector("[data-exchange-controls]");
  const status = recording.querySelector("[data-exchange-status]");
  const steps = [...recording.querySelectorAll("[data-exchange-step]")];
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const phases = ["question-focus", "question-type", "question-done", "question-send", "reply-focus", "reply-type", "reply-done", "reply-send", "complete"];
  const durations = [700, 3000, 600, 1800, 700, 3000, 600, 1800, 3000];
  const stages = ["question", "question", "question", "question", "reply", "reply", "reply", "reply", "complete"];
  let actors = ["Codex", "Antigravity"], examples = [], selected = -1, deck = [], previousPlatforms = [], previousColors = [];
  const source = recording.querySelector("[data-exchange-scenarios]");
  try { examples = JSON.parse(source?.textContent ?? "[]"); } catch { /* Static example remains available. */ }
  const field = key => recording.querySelector('[data-exchange-field="' + key + '"]');
  let messages = { question: Array.from(field("question").textContent), answer: Array.from(field("answer").textContent) };
  const rememberMessages = () => {
    for (const key of ["question", "answer"]) {
      const element = field(key); messages[key] = Array.from(element.textContent);
      element.style.minHeight = "";
      element.style.minHeight = (element.scrollHeight || element.getBoundingClientRect().height) + "px";
    }
    durations[1] = Math.max(3000, Math.min(7200, messages.question.length * 32));
    durations[5] = Math.max(3000, Math.min(7200, messages.answer.length * 32));
    recording.style.setProperty("--question-duration", durations.slice(0,4).reduce((a,b) => a+b,0) + "ms");
    recording.style.setProperty("--reply-duration", durations.slice(4,8).reduce((a,b) => a+b,0) + "ms");
  };
  const platforms = ["macos", "windows", "linux"], palettes = ["ice", "cream", "mint", "rose"];
  const shells = { macos: ["Terminal — zsh", "~/project %"], windows: ["PowerShell", "PS C:\\work\\project>"], linux: ["Terminal — bash", "dev@local:~/project$"] };
  const agents = { "Codex": ["codex", "›_"], "Claude Code": ["claude", "✳"], "Antigravity": ["agy", "∧", "antigravity"], "Kimi Code": ["kimi", "K"], "Grok Build": ["grok", "G"], "Gemini CLI": ["gemini", "✦"] };
  const pair = (values, previous) => {
    const options = values.flatMap(left => values.filter(right => left !== right && left !== previous[0] && right !== previous[1]).map(right => [left, right]));
    return options[Math.floor(Math.random() * options.length)];
  };
  const showExample = choice => {
    selected = choice;
    const example = examples[choice]; actors = [example.from, example.to];
    for (const key of ["title", "from", "fromRole", "fromIntent", "to", "toRole", "toIntent", "question", "answer", "contextKey", "contextValue", "outboundCommand", "returnCommand", "outcome", "stepOne", "stepTwo", "stepThree"]) field(key).textContent = example[key];
    rememberMessages();
    field("questionLabel").textContent = example.outboundCommand;
    field("answerLabel").textContent = example.returnCommand;
    field("evidence").textContent = example.evidence === "captured" ? "Real messages. Illustrated demo." : "Workflow example. Illustrated demo.";
    field("guide").href = example.guide;
    recording.dataset.example = example.id; recording.dataset.kind = example.kind;
    recording.setAttribute("aria-label", example.title + ": " + example.from + " and " + example.to);
    const operatingSystems = pair(platforms, previousPlatforms), colors = pair(palettes, previousColors);
    previousPlatforms = operatingSystems; previousColors = colors;
    for (const [index, side] of ["from", "to"].entries()) {
      const terminal = recording.querySelector('[data-exchange-terminal="' + side + '"]');
      terminal.dataset.platform = operatingSystems[index]; terminal.dataset.palette = colors[index];
      const [command, glyph, identity = command] = agents[actors[index]];
      const author = actors[index].replace(/ (Code|CLI|Build)$/, "");
      field(side + "Writing").textContent = author + " writing…";
      field(side + "Author").textContent = author;
      terminal.dataset.agent = identity;
      field(side + "Shell").textContent = shells[operatingSystems[index]][0];
      field(side + "Prompt").textContent = shells[operatingSystems[index]][1];
      field(side + "Command").textContent = command; field(side + "Glyph").textContent = glyph;
    }
  };
  const nextExample = () => {
    if (!deck.length) deck = examples.map((_, index) => index);
    let draw = Math.floor(Math.random() * deck.length);
    if (deck.length > 1 && deck[draw] === selected) draw = (draw + 1 + Math.floor(Math.random() * (deck.length - 1))) % deck.length;
    showExample(deck.splice(draw, 1)[0]);
  };
  let timer, index = 0, remaining = 0, started = 0, running = false, userPaused = false, inView = false;
  const phase = (value, readable = false) => {
    recording.dataset.phase = phases[value]; recording.dataset.stage = stages[value];
    for (const step of steps) {
      if (step.dataset.exchangeStep === stages[value]) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    }
    for (const key of ["question", "answer"]) {
      const side = key === "question" ? "question" : "reply";
      const starting = phases[value] === side + "-focus" || phases[value] === side + "-type";
      const waiting = key === "answer" && stages[value] === "question";
      const empty = !readable && stages[value] !== "complete" && (waiting || starting);
      field(key).textContent = empty ? "" : messages[key].join("");
    }
    const example = examples[selected];
    status.textContent = example ? (stages[value] === "complete" ? example.outcome : actors[stages[value] === "question" ? 0 : 1] + " · " + (stages[value] === "question" ? example.outboundCommand : example.returnCommand)) : "Answer received.";
  };
  const typing = () => phases[index].endsWith("-type");
  const queue = () => {
    started = performance.now();
    timer = setTimeout(() => {
      remaining = Math.max(0, remaining - (performance.now() - started));
      if (typing()) {
        const key = stages[index] === "question" ? "question" : "answer";
        const count = Math.floor(messages[key].length * (1 - remaining / durations[index]));
        field(key).textContent = messages[key].slice(0,count).join("");
      }
      if (!remaining) {
        if (index === phases.length - 1 && examples.length > 1) nextExample();
        index = (index + 1) % phases.length; remaining = durations[index]; phase(index);
      }
      queue();
    }, typing() ? Math.min(50, remaining) : remaining);
  };
  const pause = () => {
    if (!running) return;
    clearTimeout(timer); remaining = Math.max(0, remaining - (performance.now() - started));
    running = false; recording.dataset.playback = "paused"; button.textContent = "Play";
  };
  const play = () => {
    if (motion.matches || document.hidden) return;
    if (recording.dataset.playback !== "paused") { index = 0; remaining = durations[0]; phase(0); }
    running = true; recording.dataset.playback = "playing"; button.textContent = "Pause"; queue();
  };
  if (examples.length) nextExample(); else rememberMessages();
  const another = recording.querySelector("[data-exchange-next]");
  another.hidden = examples.length < 2;
  another.addEventListener("click", () => {
    pause(); nextExample();
    recording.dataset.playback = "step"; userPaused = false;
    if (motion.matches) phase(phases.length - 1); else play();
  });
  recording.dataset.playback = "step";
  controls.hidden = false; button.hidden = motion.matches;
  button.addEventListener("click", () => {
    userPaused = running;
    if (running) pause(); else play();
  });
  for (const step of steps) step.addEventListener("click", () => {
    userPaused = true; pause(); index = { question: 0, reply: 4, complete: 8 }[step.dataset.exchangeStep]; remaining = durations[index];
    phase(index, true); recording.dataset.playback = "step"; button.textContent = "Play";
  });
  motion.addEventListener("change", () => {
    userPaused = true; pause(); phase(phases.length - 1); recording.dataset.playback = "step"; button.hidden = motion.matches;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause(); else if (inView && !userPaused && !running) play();
  });
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver(entries => {
      for (const entry of entries) {
        inView = entry.isIntersecting && entry.intersectionRatio >= .45;
        if (!inView) pause(); else if (!userPaused && !running) play();
      }
    }, { threshold: [0, .45] }).observe(recording);
  }
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
