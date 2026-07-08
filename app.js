const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const round = value => Number(value || 0).toFixed(1);
const compact = value => Number.isInteger(Number(value)) ? String(Number(value)) : round(value);
const isoDate = date => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, "0"),
  String(date.getDate()).padStart(2, "0"),
].join("-");
const localToday = () => isoDate(new Date());

const state = {
  foods: [],
  goals: { carbs: 180, protein: 120, fat: 50 },
  entries: [],
  weight: null,
  viewDate: localToday(),
  pendingFoodInput: null,
  editingId: null,
};

const seedFoods = [
  ["米饭（生米）", 80, 0, 0], ["米饭（熟米）", 28, 0, 0], ["鸡蛋", 0, 600, 600],
  ["鸡排", 5.9, 1.2, 15.4], ["香蕉", 22, 0, 0],
  ["米糊", 71, 0, 0], ["蓝莓", 14, 0, 0], ["蛋白粉", 5, 1, 78],
  ["老豆腐", 12, 4.8, 2], ["食用油", 0, 100, 0], ["鸡蛋（去黄）", 0, 0, 600],
  ["燕麦", 67, 7.5, 13], ["魔芋蛋糕", 6, 0, 13], ["奶粉", 39, 28, 24],
  ["牛奶", 5, 4.4, 3.6],
];

const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error);
});
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error("保存失败"));
});

async function openDatabase() {
  const open = indexedDB.open("food-log", 2);
  open.onupgradeneeded = () => {
    const database = open.result;
    if (!database.objectStoreNames.contains("foods")) {
      database.createObjectStore("foods", { keyPath: "id", autoIncrement: true });
    }
    if (!database.objectStoreNames.contains("entries")) {
      const entries = database.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
      entries.createIndex("date", "date");
    }
    if (!database.objectStoreNames.contains("settings")) {
      database.createObjectStore("settings", { keyPath: "key" });
    }
    if (!database.objectStoreNames.contains("weights")) {
      database.createObjectStore("weights", { keyPath: "date" });
    }
  };
  const database = await request(open);
  const seedTransaction = database.transaction(["foods", "settings"], "readwrite");
  const foodStore = seedTransaction.objectStore("foods");
  if (await request(foodStore.count()) === 0) {
    for (const [name, carbs, fat, protein] of seedFoods) {
      foodStore.add({ name, carbs, fat, protein, createdAt: new Date().toISOString() });
    }
  }
  const settings = seedTransaction.objectStore("settings");
  for (const [key, value] of [["carbs", 180], ["protein", 120], ["fat", 50]]) {
    if (!await request(settings.get(key))) settings.add({ key, value });
  }
  const dataVersion = Number((await request(settings.get("dataVersion")))?.value || 1);
  if (dataVersion < 2) {
    for (const food of await request(foodStore.getAll())) {
      if (food.name === "鸡蛋") foodStore.put({ ...food, protein: 600, fat: 600 });
      if (food.name === "鸡蛋（去黄）") foodStore.put({ ...food, protein: 600 });
    }
    settings.put({ key: "dataVersion", value: 2 });
  }
  if (dataVersion < 3) {
    for (const food of await request(foodStore.getAll())) {
      if (food.name === "吐司") foodStore.delete(food.id);
    }
    settings.put({ key: "dataVersion", value: 3 });
  }
  await transactionDone(seedTransaction);
  return database;
}

const database = await openDatabase();
const getAll = storeName => request(database.transaction(storeName).objectStore(storeName).getAll());
const getOne = (storeName, id) => request(database.transaction(storeName).objectStore(storeName).get(id));
const parseBody = options => JSON.parse(options?.body || "{}");
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const numeric = (value, label, min = 0, max = 1000) => {
  if (value === "" || value === null || value === undefined) throw new Error(`请填写${label}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${label}必须在${min}–${max}之间`);
  }
  return result;
};

async function currentGoals() {
  return Object.fromEntries((await getAll("settings")).map(({ key, value }) => [key, value]));
}

async function api(path, options = {}) {
  const url = new URL(path, location.href);
  const method = options.method || "GET";

  if (method === "GET" && url.pathname.endsWith("/api/state")) {
    const date = url.searchParams.get("date");
    if (!validDate(date)) throw new Error("日期格式错误");
    return {
      foods: (await getAll("foods")).sort((a, b) => a.id - b.id),
      goals: await currentGoals(),
      weight: await getOne("weights", date),
      entries: (await getAll("entries")).filter(entry => entry.date === date).sort((a, b) => b.id - a.id),
    };
  }

  if (method === "GET" && url.pathname.endsWith("/api/history")) {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!validDate(from) || !validDate(to) || from > to) throw new Error("日期范围错误");
    const summaries = new Map();
    for (const entry of await getAll("entries")) {
      if (entry.date < from || entry.date > to) continue;
      const row = summaries.get(entry.date) || {
        date: entry.date, carbs: 0, protein: 0, fat: 0, count: 0,
      };
      row.carbs += entry.carbs;
      row.protein += entry.protein;
      row.fat += entry.fat;
      row.count++;
      summaries.set(entry.date, row);
    }
    const weights = new Map((await getAll("weights"))
      .filter(weight => weight.date >= from && weight.date <= to)
      .map(weight => [weight.date, weight.kg]));
    for (const date of weights.keys()) {
      if (!summaries.has(date)) summaries.set(date, { date, carbs: 0, protein: 0, fat: 0, count: 0 });
    }
    return [...summaries.values()]
      .map(row => ({ ...row, weight: weights.get(row.date) ?? null }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  if (method === "PUT" && url.pathname.endsWith("/api/weight")) {
    const input = parseBody(options);
    if (!validDate(input.date)) throw new Error("日期格式错误");
    const transaction = database.transaction("weights", "readwrite");
    const store = transaction.objectStore("weights");
    if (input.kg === "" || input.kg === null || input.kg === undefined) {
      store.delete(input.date);
    } else {
      store.put({ date: input.date, kg: numeric(input.kg, "体重", 20, 300), updatedAt: new Date().toISOString() });
    }
    await transactionDone(transaction);
    return { ok: true };
  }

  if (method === "POST" && url.pathname.endsWith("/api/foods")) {
    const input = parseBody(options);
    const name = String(input.name || "").trim();
    if (!name || name.length > 50) throw new Error("食物名称应为1–50个字");
    if ((await getAll("foods")).some(food => food.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) {
      throw new Error("该食物已经存在");
    }
    const food = {
      name,
      carbs: numeric(input.carbs, "碳水"),
      fat: numeric(input.fat, "脂肪"),
      protein: numeric(input.protein, "蛋白质"),
      createdAt: new Date().toISOString(),
    };
    const transaction = database.transaction("foods", "readwrite");
    const id = await request(transaction.objectStore("foods").add(food));
    await transactionDone(transaction);
    return { ...food, id };
  }

  if (method === "POST" && url.pathname.endsWith("/api/entries")) {
    const input = parseBody(options);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) {
      throw new Error("每次请记录1–20种食物");
    }
    const foods = new Map((await getAll("foods")).map(food => [food.id, food]));
    const rows = input.items.map(item => {
      const food = foods.get(Number(item.foodId));
      if (!food) throw new Error("请选择数据库中的食物");
      const grams = numeric(item.grams, "克数", 0.1, 10000);
      if (!validDate(item.date)) throw new Error("日期格式错误");
      return {
        foodId: food.id,
        foodName: food.name,
        grams,
        carbs: food.carbs * grams / 100,
        fat: food.fat * grams / 100,
        protein: food.protein * grams / 100,
        date: item.date,
        createdAt: new Date().toISOString(),
      };
    });
    const transaction = database.transaction("entries", "readwrite");
    const store = transaction.objectStore("entries");
    rows.forEach(row => store.add(row));
    await transactionDone(transaction);
    return { ok: true };
  }

  const entryMatch = url.pathname.match(/\/api\/entries\/(\d+)$/);
  if (method === "PUT" && entryMatch) {
    const id = Number(entryMatch[1]);
    if (!await getOne("entries", id)) throw new Error("记录不存在");
    const input = parseBody(options);
    const food = await getOne("foods", Number(input.foodId));
    if (!food) throw new Error("请选择数据库中的食物");
    const grams = numeric(input.grams, "克数", 0.1, 10000);
    if (!validDate(input.date)) throw new Error("日期格式错误");
    const transaction = database.transaction("entries", "readwrite");
    transaction.objectStore("entries").put({
      id, foodId: food.id, foodName: food.name, grams,
      carbs: food.carbs * grams / 100,
      fat: food.fat * grams / 100,
      protein: food.protein * grams / 100,
      date: input.date,
      createdAt: new Date().toISOString(),
    });
    await transactionDone(transaction);
    return { ok: true };
  }

  if (method === "DELETE" && entryMatch) {
    const id = Number(entryMatch[1]);
    if (!await getOne("entries", id)) throw new Error("记录不存在");
    const transaction = database.transaction("entries", "readwrite");
    transaction.objectStore("entries").delete(id);
    await transactionDone(transaction);
    return { ok: true };
  }

  if (method === "PUT" && url.pathname.endsWith("/api/goals")) {
    const input = parseBody(options);
    const transaction = database.transaction("settings", "readwrite");
    const store = transaction.objectStore("settings");
    for (const key of ["carbs", "protein", "fat"]) {
      store.put({ key, value: numeric(input[key], `${key}目标`, 1, 1000) });
    }
    await transactionDone(transaction);
    return currentGoals();
  }

  throw new Error("操作不存在");
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2200);
}

function exactFood(name) {
  const normalized = name.trim().toLocaleLowerCase("zh-CN");
  return state.foods.find(food => food.name.toLocaleLowerCase("zh-CN") === normalized);
}

function renderFoodOptions() {
  const pickerOptions = `<option value="">选择已有食物</option>${state.foods
    .map(food => `<option value="${food.id}">${esc(food.name)}</option>`).join("")}`;
  $("#food-options").innerHTML = state.foods
    .map(food => `<option value="${esc(food.name)}"></option>`).join("");
  $("#edit-food").innerHTML = state.foods
    .map(food => `<option value="${food.id}">${esc(food.name)}</option>`).join("");
  $$(".food-picker").forEach(picker => {
    picker.innerHTML = pickerOptions;
    picker.value = "";
  });
}

function foodRow(values = {}) {
  const element = document.createElement("div");
  element.className = "food-row";
  element.innerHTML = `
    <label>吃了什么
      <span class="food-input-wrap">
        <input class="food-name" list="food-options" placeholder="选择或输入食物"
          autocomplete="off" autocapitalize="off" value="${esc(values.name || "")}" required>
        <select class="food-picker" aria-label="展开已有食物">
          <option value="">选择已有食物</option>
          ${state.foods.map(food => `<option value="${food.id}">${esc(food.name)}</option>`).join("")}
        </select>
        <span class="food-arrow" aria-hidden="true">⌄</span>
      </span>
    </label>
    <label class="grams-wrap">吃了多少
      <input class="food-grams" type="number" min="0.1" max="10000" step="0.1" inputmode="decimal"
        autocomplete="off" placeholder="0" value="${esc(values.grams || "")}" required>
    </label>
    <button class="remove-row" type="button" aria-label="删除这一行">×</button>
  `;
  element.querySelector(".remove-row").addEventListener("click", () => {
    if ($$("#food-rows .food-row").length === 1) {
      element.querySelectorAll("input").forEach(input => input.value = "");
    } else {
      element.remove();
    }
  });
  element.querySelector(".food-name").addEventListener("change", event => {
    const name = event.target.value.trim();
    if (name && !exactFood(name)) openNewFood(name, event.target);
  });
  element.querySelector(".food-picker").addEventListener("change", event => {
    const food = state.foods.find(item => item.id === Number(event.target.value));
    if (food) element.querySelector(".food-name").value = food.name;
    event.target.value = "";
  });
  return element;
}

function addFoodRow(values) {
  const row = foodRow(values);
  $("#food-rows").append(row);
  const clearBlankFields = () => {
    if (!values?.name) row.querySelector(".food-name").value = "";
    if (!values?.grams) row.querySelector(".food-grams").value = "";
    row.querySelector(".food-picker").value = "";
  };
  clearBlankFields();
  setTimeout(clearBlankFields);
}

function totals() {
  return state.entries.reduce((sum, entry) => ({
    carbs: sum.carbs + entry.carbs,
    protein: sum.protein + entry.protein,
    fat: sum.fat + entry.fat,
  }), { carbs: 0, protein: 0, fat: 0 });
}

function renderSummary() {
  const total = totals();
  const labels = { carbs: "碳水", protein: "蛋白质", fat: "脂肪" };
  $("#goal-grid").innerHTML = Object.keys(labels).map(key => {
    const consumed = total[key];
    const goal = state.goals[key];
    const difference = goal - consumed;
    const note = difference >= 0 ? `还差 ${round(difference)}g` : `超出 ${round(-difference)}g`;
    return `
      <article class="goal-card ${key}">
        <span>${labels[key]}</span>
        <strong>${round(consumed)}g</strong>
        <small>目标 ${compact(goal)}g</small>
        <div class="progress" role="progressbar" aria-label="${labels[key]}进度"
          aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${round(consumed)}">
          <i style="width:${Math.min(100, consumed / goal * 100)}%"></i>
        </div>
        <small class="goal-note">${note}</small>
      </article>
    `;
  }).join("");

  $("#entry-count").textContent = `${state.entries.length} 条`;
  $("#entry-list").innerHTML = state.entries.length ? state.entries.map(entry => `
    <article class="entry">
      <div>
        <div class="entry-title"><strong>${esc(entry.foodName)}</strong><span>${round(entry.grams)}g</span></div>
        <div class="macro-line">碳 ${round(entry.carbs)} · 蛋 ${round(entry.protein)} · 脂 ${round(entry.fat)}</div>
      </div>
      <div class="entry-actions">
        <button class="icon-button edit-entry" data-id="${entry.id}" aria-label="编辑${esc(entry.foodName)}">✎</button>
        <button class="icon-button delete-entry" data-id="${entry.id}" aria-label="删除${esc(entry.foodName)}">⌫</button>
      </div>
    </article>
  `).join("") : `<p class="empty">这一天还没有记录<br>去吃点计划内的东西吧</p>`;
}

function renderWeightForm() {
  $("#weight-date-label").textContent = formatDate(state.viewDate);
  $("#fasting-weight").value = state.weight?.kg ?? "";
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", weekday: "short",
  }).format(date);
}

async function renderHistory() {
  const end = new Date(`${localToday()}T12:00:00`);
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  const rows = await api(`/api/history?from=${isoDate(start)}&to=${isoDate(end)}`);
  const byDate = new Map(rows.map(row => [row.date, row]));
  const days = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    const key = isoDate(date);
    days.push(byDate.get(key) || { date: key, carbs: 0, protein: 0, fat: 0, count: 0, weight: null });
  }
  renderWeightChart(days);
  $("#history-list").innerHTML = days.map(day => `
    <button class="history-card" data-date="${day.date}">
      <div class="history-top">
        <strong>${formatDate(day.date)}</strong>
        <span>${day.count ? `${day.count} 条记录 ›` : "无记录"}</span>
      </div>
      <div class="history-macros">
        <span>碳水<b>${round(day.carbs)}g</b></span>
        <span>蛋白质<b>${round(day.protein)}g</b></span>
        <span>脂肪<b>${round(day.fat)}g</b></span>
      </div>
    </button>
  `).join("");
}

function renderWeightChart(days) {
  const points = days.filter(day => day.weight !== null).reverse();
  if (!points.length) {
    $("#weight-chart").innerHTML = `<p class="empty mini">还没有体重记录<br>在记录页填一次就会出现曲线</p>`;
    return;
  }
  const weights = points.map(point => point.weight);
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const span = max - min || 1;
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? 150 : 18 + index * (264 / (points.length - 1));
    const y = 130 - ((point.weight - min) / span) * 100;
    return { ...point, x, y };
  });
  $("#weight-chart").innerHTML = `
    <svg viewBox="0 0 300 160" role="img" aria-label="最近30天空腹体重曲线">
      <line x1="18" y1="130" x2="282" y2="130"></line>
      <polyline points="${coords.map(point => `${point.x},${point.y}`).join(" ")}"></polyline>
      ${coords.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${formatDate(point.date)} ${round(point.weight)}kg</title></circle>`).join("")}
    </svg>
    <div class="chart-note">
      <span>最新 ${round(points.at(-1).weight)}kg</span>
      <span>区间 ${round(min)}–${round(max)}kg</span>
    </div>
  `;
}

function setGoalInputs() {
  $("#goal-carbs").value = state.goals.carbs;
  $("#goal-protein").value = state.goals.protein;
  $("#goal-fat").value = state.goals.fat;
}

async function refresh(date = state.viewDate) {
  state.viewDate = date;
  const result = await api(`/api/state?date=${date}`);
  state.foods = result.foods;
  state.goals = result.goals;
  state.weight = result.weight;
  state.entries = result.entries;
  $("#summary-date").value = date;
  $("#record-date").value = date;
  renderFoodOptions();
  setGoalInputs();
  renderWeightForm();
  renderSummary();
}

async function showView(name) {
  document.body.dataset.view = name;
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `${name}-view`));
  $$(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  if (name === "today") await refresh($("#summary-date").value || localToday());
  if (name === "history") await renderHistory();
  scrollTo({ top: 0, behavior: "smooth" });
}

function openNewFood(name, input) {
  state.pendingFoodInput = input;
  $("#new-food-name").value = name;
  $("#new-food-carbs").value = "";
  $("#new-food-protein").value = "";
  $("#new-food-fat").value = "";
  $("#new-food-dialog").showModal();
  $("#new-food-carbs").focus();
}

$("#add-row").addEventListener("click", () => addFoodRow({ name: "", grams: "" }));

$("#record-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const date = $("#record-date").value;
    const items = $$("#food-rows .food-row").map(row => {
      const input = row.querySelector(".food-name");
      const food = exactFood(input.value);
      if (!food) {
        openNewFood(input.value.trim(), input);
        throw new Error("");
      }
      return { foodId: food.id, grams: row.querySelector(".food-grams").value, date };
    });
    await api("/api/entries", { method: "POST", body: JSON.stringify({ items }) });
    $("#food-rows").innerHTML = "";
    addFoodRow();
    await refresh(date);
    toast("记录好了，继续稳住");
    await showView("today");
  } catch (error) {
    if (error.message) toast(error.message);
  }
});

$("#weight-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await api("/api/weight", {
      method: "PUT",
      body: JSON.stringify({ date: $("#record-date").value, kg: $("#fasting-weight").value }),
    });
    await refresh($("#record-date").value);
    toast("体重已保存");
  } catch (error) {
    toast(error.message);
  }
});

$("#new-food-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    $("#new-food-dialog").close();
    return;
  }
  try {
    const food = await api("/api/foods", {
      method: "POST",
      body: JSON.stringify({
        name: $("#new-food-name").value,
        carbs: $("#new-food-carbs").value,
        protein: $("#new-food-protein").value,
        fat: $("#new-food-fat").value,
      }),
    });
    state.foods.push(food);
    renderFoodOptions();
    if (state.pendingFoodInput) state.pendingFoodInput.value = food.name;
    $("#new-food-dialog").close();
    toast("新食物已加入数据库");
  } catch (error) {
    toast(error.message);
  }
});

$("#summary-date").addEventListener("change", event => refresh(event.target.value));

$("#entry-list").addEventListener("click", async event => {
  const edit = event.target.closest(".edit-entry");
  const remove = event.target.closest(".delete-entry");
  if (edit) {
    const entry = state.entries.find(item => item.id === Number(edit.dataset.id));
    state.editingId = entry.id;
    $("#edit-food").value = entry.foodId;
    $("#edit-grams").value = entry.grams;
    $("#edit-date").value = entry.date;
    $("#edit-dialog").showModal();
  }
  if (remove) {
    const entry = state.entries.find(item => item.id === Number(remove.dataset.id));
    if (!confirm(`删除“${entry.foodName} ${round(entry.grams)}g”吗？`)) return;
    try {
      await api(`/api/entries/${entry.id}`, { method: "DELETE" });
      await refresh(state.viewDate);
      toast("已删除");
    } catch (error) {
      toast(error.message);
    }
  }
});

$("#edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    $("#edit-dialog").close();
    return;
  }
  try {
    await api(`/api/entries/${state.editingId}`, {
      method: "PUT",
      body: JSON.stringify({
        foodId: $("#edit-food").value,
        grams: $("#edit-grams").value,
        date: $("#edit-date").value,
      }),
    });
    $("#edit-dialog").close();
    await refresh(state.viewDate);
    toast("修改已保存");
  } catch (error) {
    toast(error.message);
  }
});

$("#history-list").addEventListener("click", async event => {
  const card = event.target.closest(".history-card");
  if (!card) return;
  await refresh(card.dataset.date);
  await showView("today");
});

$("#goals-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    state.goals = await api("/api/goals", {
      method: "PUT",
      body: JSON.stringify({
        carbs: $("#goal-carbs").value,
        protein: $("#goal-protein").value,
        fat: $("#goal-fat").value,
      }),
    });
    renderSummary();
    toast("目标已更新");
  } catch (error) {
    toast(error.message);
  }
});

$("#export-data").addEventListener("click", async () => {
  try {
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      foods: await getAll("foods"),
      goals: await currentGoals(),
      entries: await getAll("entries"),
      weights: await getAll("weights"),
    };
    const url = URL.createObjectURL(new Blob(
      [JSON.stringify(backup, null, 2)],
      { type: "application/json" },
    ));
    const link = document.createElement("a");
    link.href = url;
    link.download = `饮食记录备份-${localToday()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("备份文件已导出");
  } catch (error) {
    toast(error.message);
  }
});

$("#restore-data").addEventListener("click", () => $("#restore-file").click());

$("#restore-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const input = JSON.parse(await file.text());
    if (!Array.isArray(input.foods) || !Array.isArray(input.entries) || !input.goals) {
      throw new Error("这不是有效的饮食记录备份");
    }
    const foodIds = new Set();
    const restoredFoods = input.foods.map(food => {
      const id = Number(food.id);
      const name = String(food.name || "").trim();
      if (!Number.isInteger(id) || id < 1 || foodIds.has(id) || !name || name.length > 50) {
        throw new Error("备份中的食物数据无效");
      }
      foodIds.add(id);
      return {
        id, name,
        carbs: numeric(food.carbs, "碳水"),
        fat: numeric(food.fat, "脂肪"),
        protein: numeric(food.protein, "蛋白质"),
        createdAt: food.createdAt || food.created_at || new Date().toISOString(),
      };
    });
    const restoredEntries = input.entries.map(entry => {
      const id = Number(entry.id);
      const foodId = Number(entry.foodId ?? entry.food_id);
      const date = entry.date ?? entry.eaten_on;
      const foodName = String(entry.foodName ?? entry.food_name ?? "").trim();
      if (!Number.isInteger(id) || id < 1 || !foodIds.has(foodId) || !foodName || !validDate(date)) {
        throw new Error("备份中的历史记录无效");
      }
      return {
        id, foodId, foodName,
        grams: numeric(entry.grams, "克数", 0.1, 10000),
        carbs: numeric(entry.carbs, "碳水记录", 0, 1_000_000),
        fat: numeric(entry.fat, "脂肪记录", 0, 1_000_000),
        protein: numeric(entry.protein, "蛋白质记录", 0, 1_000_000),
        date,
        createdAt: entry.createdAt || entry.created_at || new Date().toISOString(),
      };
    });
    const restoredGoals = Object.fromEntries(["carbs", "protein", "fat"].map(key => [
      key, numeric(input.goals[key], `${key}目标`, 1, 1000),
    ]));
    const restoredWeights = (input.weights || []).map(weight => {
      if (!validDate(weight.date)) throw new Error("备份中的体重记录无效");
      return {
        date: weight.date,
        kg: numeric(weight.kg, "体重", 20, 300),
        updatedAt: weight.updatedAt || new Date().toISOString(),
      };
    });
    if (!confirm(`将用备份中的 ${restoredEntries.length} 条记录覆盖当前数据，确定继续吗？`)) return;

    const transaction = database.transaction(["foods", "entries", "settings", "weights"], "readwrite");
    const foodStore = transaction.objectStore("foods");
    const entryStore = transaction.objectStore("entries");
    const settingStore = transaction.objectStore("settings");
    const weightStore = transaction.objectStore("weights");
    foodStore.clear();
    entryStore.clear();
    settingStore.clear();
    weightStore.clear();
    restoredFoods.forEach(food => foodStore.put(food));
    restoredEntries.forEach(entry => entryStore.put(entry));
    Object.entries(restoredGoals).forEach(([key, value]) => settingStore.put({ key, value }));
    restoredWeights.forEach(weight => weightStore.put(weight));
    await transactionDone(transaction);
    await refresh(localToday());
    toast("备份恢复完成");
    await showView("today");
  } catch (error) {
    toast(error.message || "备份恢复失败");
  }
});

$("#discipline").addEventListener("click", () => toast("牛逼！继续努力！"));
$("#confess").addEventListener("click", async () => {
  toast("承认得挺快，回去如实记录");
  await showView("record");
});
$$(".bottom-nav button").forEach(button => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

let calendarDay = localToday();
setInterval(async () => {
  const nextDay = localToday();
  if (nextDay === calendarDay) return;
  calendarDay = nextDay;
  $("#record-date").value = nextDay;
  $("#today-label").textContent = formatDate(nextDay);
  await refresh(nextDay);
}, 60_000);

$("#record-date").value = calendarDay;
$("#summary-date").value = calendarDay;
$("#today-label").textContent = formatDate(calendarDay);
addFoodRow();

try {
  await refresh(calendarDay);
} catch {
  toast("本地数据库打开失败，请重新打开页面");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
