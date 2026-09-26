const $ = id => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

let busy = false;
function guarded(fn) {
  return async (...args) => {
    if (busy) return;
    busy = true;
    document.body.classList.add("busy");
    try {
      return await fn(...args);
    } finally {
      busy = false;
      document.body.classList.remove("busy");
    }
  };
}

const PAGE_SIZE = 10;
let rulesCache = [];
let page = 0;
let selected = null;

async function loadRules() {
  rulesCache = await api("GET", "/api/rules");
  renderRules();
}

function pageCount() {
  return Math.max(1, Math.ceil(rulesCache.length / PAGE_SIZE));
}

function splitRule(text) {
  const m = text.match(/^ЕСЛИ\s+(.+?)\s+ТО\s+(.+)$/);
  return m ? [m[1], m[2]] : [text, ""];
}

function renderRules() {
  page = Math.min(page, pageCount() - 1);
  const shown = rulesCache.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  $("rules").innerHTML = shown.map(r => {
    const [cond, concl] = splitRule(r.text);
    return `<tr data-id="${r.id}" class="${r.id === selected ? "selected" : ""}">
      <td class="num">${r.id + 1}</td>
      <td>${esc(cond).replace(/ И /g, ' <span class="kw">И</span> ')}</td>
      <td class="then">${esc(concl)}</td>
    </tr>`;
  }).join("");
  $("rules").querySelectorAll("tr").forEach(tr =>
    tr.onclick = () => selectRule(Number(tr.dataset.id)));

  $("rules-empty").hidden = rulesCache.length > 0;
  $("pager").hidden = pageCount() < 2;
  $("page-info").textContent = `Стр. ${page + 1} из ${pageCount()} · всего правил: ${rulesCache.length}`;
  $("prev-btn").disabled = page === 0;
  $("next-btn").disabled = page >= pageCount() - 1;
}

function selectRule(id) {
  selected = (id === selected) ? null : id;
  $("rule-input").value = selected === null ? "" : rulesCache[selected].text;
  updateEditor();
  renderRules();
}

function updateEditor() {
  const editing = selected !== null;
  $("rule-label").textContent = editing ? `Правило ${selected + 1}` : "Новое правило";
  $("add-btn").hidden = editing;
  $("save-btn").hidden = $("delete-btn").hidden = $("cancel-btn").hidden = !editing;
  $("rules-error").textContent = "";
}

function resetEditor() {
  selected = null;
  $("rule-input").value = "";
  updateEditor();
}

async function changeRules(method, url, body) {
  try {
    await api(method, url, body);
    resetEditor();
    await loadRules();
    await loadState();
    return true;
  } catch (e) {
    $("rules-error").textContent = e.message;
    return false;
  }
}

const addRule = guarded(async () => {
  const text = $("rule-input").value.trim();
  if (!text) return;
  if (await changeRules("POST", "/api/rules", { text })) {
    page = pageCount() - 1;
    renderRules();
  }
});

const saveRule = guarded(async () => {
  const text = $("rule-input").value.trim();
  if (!text) return;
  await changeRules("PUT", `/api/rules/${selected}`, { text });
});

const deleteRule = guarded(async () => {
  if (!confirm(`Удалить правило ${selected + 1}?\n${rulesCache[selected].text}`)) return;
  await changeRules("DELETE", `/api/rules/${selected}`);
});

function parseFacts(text) {
  const wm = {};
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const parts = line.split("=");
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim())
      throw new Error(`Строка ${i + 1}: ожидается «объект=значение»`);
    wm[parts[0].trim()] = parts[1].trim();
  });
  return wm;
}

const startInference = guarded(async () => {
  $("start-error").textContent = "";
  try {
    const wm = parseFacts($("facts").value);
    const goal = $("goal").value.trim();
    render(await api("POST", "/api/start", { wm, goal }));
  } catch (e) {
    $("start-error").textContent = e.message;
  }
});

const sendAnswer = guarded(async value => {
  try {
    render(await api("POST", "/api/answer", { value }));
  } catch (e) {
    $("start-error").textContent = e.message;
  }
});

function sendTypedAnswer(s) {
  const value = $("answer").value.trim();
  if (!value) {
    $("answer-error").textContent = "Введите значение или нажмите «Сведений нет».";
    $("answer").focus();
    return;
  }
  if (s.options.length && !s.options.includes(value) &&
      !confirm(`Значения «${value}» нет в правилах для «${s.question}».\n` +
               `Возможные значения: ${s.options.join(", ")}.\n\nВсё равно использовать?`)) {
    $("answer").focus();
    return;
  }
  sendAnswer(value);
}

async function loadState() {
  render(await api("GET", "/api/state"));
}

function render(s) {
  const box = $("status");
  box.className = s.status;
  box.hidden = s.status === "idle";

  if (s.status === "ask") {
    box.innerHTML = `
      <p>Правила больше не срабатывают. Что известно про «${esc(s.question)}»?</p>
      <div class="row options">
        ${s.options.map(v =>
          `<button class="plain" data-value="${esc(v)}">${esc(v)}</button>`).join("")}
      </div>
      <div class="row">
        <input id="answer" placeholder="или введите своё значение">
        <button id="answer-btn">Ответить</button>
        <button class="plain" id="no-info-btn">Сведений нет</button>
      </div>
      <p class="error" id="answer-error"></p>`;
    box.querySelectorAll("[data-value]").forEach(b =>
      b.onclick = () => sendAnswer(b.dataset.value));
    $("answer-btn").onclick = () => sendTypedAnswer(s);
    $("answer").oninput = () => { $("answer-error").textContent = ""; };
    $("no-info-btn").onclick = () => sendAnswer("");
    $("answer").onkeydown = e => { if (e.key === "Enter") $("answer-btn").click(); };
    $("answer").focus();
  } else if (s.status === "done") {
    box.innerHTML = `<p>Вывод завершён.</p>
      <p class="result">${esc(s.goal)} = ${esc(s.answer)}</p>`;
  } else if (s.status === "stopped") {
    box.innerHTML = s.goal
      ? `<p>Не удалось определить «${esc(s.goal)}»: правила не срабатывают, а новых сведений нет.</p>`
      : `<p>Вывод завершён: правила больше не срабатывают. Результат — в рабочей памяти.</p>`;
  }

  const entries = Object.entries(s.wm);
  $("wm").innerHTML = entries
    .map(([o, v]) => `<tr><td>${esc(o)}</td><td>${esc(v)}</td></tr>`).join("");
  $("wm-empty").hidden = entries.length > 0;

  $("trace").innerHTML = s.trace.map(t => `<li>${esc(t)}</li>`).join("");
  $("trace-empty").hidden = s.trace.length > 0;
}

$("add-btn").onclick = addRule;
$("save-btn").onclick = saveRule;
$("delete-btn").onclick = deleteRule;
$("cancel-btn").onclick = () => { resetEditor(); renderRules(); };
$("rule-input").onkeydown = e => {
  if (e.key === "Enter") selected === null ? addRule() : saveRule();
  if (e.key === "Escape") { resetEditor(); renderRules(); }
};
$("prev-btn").onclick = () => { page--; renderRules(); };
$("next-btn").onclick = () => { page++; renderRules(); };
$("start-btn").onclick = startInference;

loadRules().then(loadState).catch(e => {
  $("rules-error").textContent = "Нет связи с сервером: " + e.message;
});
