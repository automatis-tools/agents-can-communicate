const mobileMenu = document.querySelector(".mobile-nav");
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && mobileMenu?.open) {
    mobileMenu.open = false;
    mobileMenu.querySelector("summary").focus();
  }
});
mobileMenu?.addEventListener("click", event => {
  if (event.target.closest("a")) mobileMenu.open = false;
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

const form = document.querySelector("[data-search-form]");
if (form) {
  const field = form.querySelector("input");
  const status = document.querySelector("[data-search-status]");
  const empty = document.querySelector("[data-search-empty]");
  const results = [...document.querySelectorAll("[data-search-result]")];
  const normalize = value => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let index;
  let timer;
  const loaded = fetch("/search-index.json", { signal: AbortSignal.timeout(5000) })
    .then(response => { if (!response.ok) throw new Error("unavailable"); return response.json(); })
    .then(data => {
      if (!Array.isArray(data)) throw new Error("invalid index");
      index = new Map(data.map(article => [article.route,
        normalize(article.title + " " + article.description + " " + article.text)]));
    }).catch(() => {
      status.textContent = "Search is unavailable. All articles are listed below.";
    });
  async function search() {
    const query = field.value.trim().slice(0, 200);
    if (query) status.textContent = "Searching…";
    await loaded;
    if (!index) return;
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    let count = 0;
    for (const result of results) {
      const haystack = index.get(result.dataset.searchResult) ?? "";
      const matches = terms.every(term => haystack.includes(term));
      result.hidden = !matches;
      if (matches) count++;
    }
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
