/**
 * LaundryPro — app.js
 * Complete production app for hotel laundry management.
 * Architecture: Module pattern with clear separation of concerns.
 * No frameworks, no build tools. Pure ES modules.
 */
"use strict";

// ============================================================
// MODULE: CONFIG — Central configuration
// ============================================================
const CONFIG = {
  version: "1.0.0",
  dbName: "laundrypro_db",
  dbVersion: 1,
  syncEndpoint: "https://hooks.zapier.com/hooks/catch/PLACEHOLDER/",
  defaultTara: 42,
  vibration: true,

  categoriasSucio: [
    { id: "sabanas",     label: "Sábanas",     emoji: "", color: "#e0e7ff" },
    { id: "servilletas", label: "Servilletas", emoji: "", color: "#fca5a5" },
    { id: "caminos",     label: "Caminos",     emoji: "", color: "#fde68a" },
    { id: "manteles",    label: "Manteles",    emoji: "", color: "#7dd3fc" },
  ],

  productosLimpio: [
    { id: "sabanas_90",    label: "Sábanas 90",    emoji: "", color: "#e0e7ff" },
    { id: "sabanas_135",   label: "Sábanas 135",   emoji: "", color: "#c7d2fe" },
    { id: "sabanas_180",   label: "Sábanas 180",   emoji: "", color: "#a5b4fc" },
    { id: "fundas",        label: "Fundas",        emoji: "", color: "#fca5a5" },
    { id: "toallas_mano",  label: "T. Mano",       emoji: "", color: "#86efac" },
    { id: "toallas_bano",  label: "T. Baño",       emoji: "", color: "#6ee7b7" },
    { id: "toallas_gran",  label: "T. Grande",     emoji: "", color: "#7dd3fc" },
    { id: "alfombras",     label: "Alfombras",     emoji: "", color: "#fde68a" },
    { id: "batines",       label: "Batines",       emoji: "", color: "#d8b4fe" },
    { id: "manteleria",    label: "Mantelería",    emoji: "", color: "#fcd34d" },
    { id: "uniformes",     label: "Uniformes",     emoji: "", color: "#f0abfc" },
    { id: "otros",         label: "Otros",         emoji: "", color: "#94a3b8" },
  ],

  tiposHotel: [
    { id: "blanca",  label: "Blanca",  color: "#e0e7ff", dot: "#818cf8" },
    { id: "piscina", label: "Piscina", color: "#7dd3fc", dot: "#38bdf8" },
    { id: "varios",  label: "Varios",  color: "#d8b4fe", dot: "#c084fc" },
  ],

  capacidadesHotel: [55, 24, 13, 8],
};

// ============================================================
// MODULE: DB — IndexedDB wrapper (offline-first)
// ============================================================
const DB = (() => {
  let db = null;

  const STORES = {
    sucio:   "sucio_records",
    limpio:  "limpio_records",
    hotel:   "hotel_state",
    queue:   "sync_queue",
    config:  "app_config",
  };

  async function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);

      req.onupgradeneeded = (e) => {
        const d = e.target.result;

        // Sucio records
        if (!d.objectStoreNames.contains(STORES.sucio)) {
          const s = d.createObjectStore(STORES.sucio, { keyPath: "id", autoIncrement: true });
          s.createIndex("ts", "ts");
        }

        // Limpio records
        if (!d.objectStoreNames.contains(STORES.limpio)) {
          const s = d.createObjectStore(STORES.limpio, { keyPath: "id", autoIncrement: true });
          s.createIndex("ts", "ts");
          s.createIndex("producto", "producto");
        }

        // Hotel state (key/value)
        if (!d.objectStoreNames.contains(STORES.hotel)) {
          d.createObjectStore(STORES.hotel, { keyPath: "key" });
        }

        // Sync queue
        if (!d.objectStoreNames.contains(STORES.queue)) {
          const s = d.createObjectStore(STORES.queue, { keyPath: "id", autoIncrement: true });
          s.createIndex("status", "status");
        }

        // App config
        if (!d.objectStoreNames.contains(STORES.config)) {
          d.createObjectStore(STORES.config, { keyPath: "key" });
        }
      };

      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  function tx(store, mode = "readonly") {
    return db.transaction(store, mode).objectStore(store);
  }

  function all(storeName) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  function get(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  function put(storeName, value) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, "readwrite").put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  function add(storeName, value) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, "readwrite").add(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  function del(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, "readwrite").delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  function clear(storeName) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, "readwrite").clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  return { open, all, get, put, add, del, clear, STORES };
})();

// ============================================================
// MODULE: SYNC — Queue management and Google Sheets sync
// ============================================================
const Sync = (() => {
  let queueCount = 0;

  async function enqueue(type, data) {
    const entry = { type, data, status: "pending", ts: Date.now(), attempts: 0 };
    await DB.add(DB.STORES.queue, entry);
    queueCount++;
    updateQueueUI();
  }

  async function loadQueueCount() {
    const items = await DB.all(DB.STORES.queue);
    queueCount = items.filter(i => i.status === "pending").length;
    updateQueueUI();
    return queueCount;
  }

  function updateQueueUI() {
    const queuePill   = document.getElementById("header-queue-pill");
    const queueCount2 = document.getElementById("header-queue-count");
    const splashRow   = document.getElementById("splash-queue-row");
    const splashCount = document.getElementById("splash-queue-count");

    if (queuePill && queueCount2) {
      queuePill.style.display = queueCount > 0 ? "flex" : "none";
      queueCount2.textContent = queueCount;
    }
    if (splashRow && splashCount) {
      splashRow.style.display = queueCount > 0 ? "flex" : "none";
      splashCount.textContent = queueCount;
    }
  }

  async function flush() {
    if (!navigator.onLine) return;
    const items = await DB.all(DB.STORES.queue);
    const pending = items.filter(i => i.status === "pending");

    for (const item of pending) {
      try {
        const response = await fetch(CONFIG.syncEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: item.type, data: item.data, ts: item.ts }),
        });
        if (response.ok) {
          item.status = "synced";
          await DB.put(DB.STORES.queue, item);
          queueCount = Math.max(0, queueCount - 1);
          updateQueueUI();
        }
      } catch (err) {
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts >= 5) item.status = "failed";
        await DB.put(DB.STORES.queue, item);
      }
    }
  }

  async function clearSynced() {
    const items = await DB.all(DB.STORES.queue);
    for (const item of items) {
      if (item.status === "synced") await DB.del(DB.STORES.queue, item.id);
    }
  }

  return {
    enqueue,
    flush,
    loadQueueCount,
    clearSynced,
    get count() { return queueCount; }
  };
})();

// ============================================================
// MODULE: HAPTIC — Vibration feedback
// ============================================================
const Haptic = {
  light:   () => CONFIG.vibration && navigator.vibrate && navigator.vibrate(10),
  medium:  () => CONFIG.vibration && navigator.vibrate && navigator.vibrate(20),
  heavy:   () => CONFIG.vibration && navigator.vibrate && navigator.vibrate([20, 10, 20]),
  success: () => CONFIG.vibration && navigator.vibrate && navigator.vibrate([10, 5, 10, 5, 30]),
  error:   () => CONFIG.vibration && navigator.vibrate && navigator.vibrate([50, 20, 50]),
};

// ============================================================
// MODULE: TOAST — Notification system
// ============================================================
const Toast = (() => {
  const ICONS = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  };

  function show(message, type = "info", duration = 2800) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    el.innerHTML = `
      <div class="toast__icon">${ICONS[type] || ICONS.info}</div>
      <span class="toast__message">${message}</span>
    `;

    container.appendChild(el);

    const hide = () => {
      el.classList.add("hiding");
      setTimeout(() => el.remove(), 250);
    };

    const timer = setTimeout(hide, duration);
    el.addEventListener("click", () => {
      clearTimeout(timer);
      hide();
    });
  }

  return {
    show,
    success: (m) => show(m, "success"),
    error:   (m) => show(m, "error"),
    info:    (m) => show(m, "info"),
    warning: (m) => show(m, "warning"),
  };
})();

// ============================================================
// MODULE: CONFIRM — Confirmation dialog
// ============================================================
const Confirm = (() => {
  function ask(message) {
    const overlay   = document.getElementById("confirm-overlay");
    const msgEl     = document.getElementById("confirm-message");
    const okBtn     = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");

    msgEl.textContent = message;
    overlay.style.display = "flex";

    return new Promise((resolve) => {
      const cleanup = (val) => {
        overlay.style.display = "none";
        resolve(val);
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
      };

      const onOk = () => { Haptic.medium(); cleanup(true); };
      const onCancel = () => { cleanup(false); };

      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  return { ask };
})();

// ============================================================
// MODULE: MODAL — Bottom sheet
// ============================================================
const Modal = (() => {
  const overlay = () => document.getElementById("modal-overlay");
  const body    = () => document.getElementById("modal-body");

  function open(content) {
    const o = overlay();
    const b = body();
    b.innerHTML = content;
    o.style.display = "flex";

    const onOverlayClick = (e) => {
      if (e.target === o) {
        close();
        o.removeEventListener("click", onOverlayClick);
      }
    };
    o.addEventListener("click", onOverlayClick);
  }

  function close() {
    const o = overlay();
    const sheet = document.getElementById("modal-sheet");
    if (sheet) {
      sheet.style.animation = "sheetDown 0.25s ease forwards";
    }
    setTimeout(() => {
      o.style.display = "none";
      if (sheet) sheet.style.animation = "";
    }, 250);
  }

  function getBody() {
    return body();
  }

  return { open, close, getBody };
})();

// ============================================================
// MODULE: STEPPER COMPONENT — Reusable +/- stepper
// ============================================================
function createStepper({ id, label, value = 0, min = 0, max = 9999, step = 1, unit = "", onchange }) {
  const wrap = document.createElement("div");
  wrap.className = "stepper-wrap";

  if (label) {
    const lbl = document.createElement("div");
    lbl.className = "stepper-label";
    lbl.textContent = label;
    wrap.appendChild(lbl);
  }

  const stepper = document.createElement("div");
  stepper.className = "stepper";
  stepper.id = id;

  let current = value;

  const minusBtn = document.createElement("button");
  minusBtn.className = "stepper__btn stepper__btn--minus";
  minusBtn.setAttribute("aria-label", "Disminuir");
  minusBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  const valueWrap = document.createElement("div");
  valueWrap.className = "stepper__value";
  valueWrap.setAttribute("role", "spinbutton");
  valueWrap.setAttribute("aria-valuemin", min);
  valueWrap.setAttribute("aria-valuemax", max);

  const input = document.createElement("input");
  input.type = "number";
  input.inputMode = step % 1 === 0 ? "numeric" : "decimal";
  input.step = String(step);
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.className = "stepper__input";
  input.setAttribute("aria-label", label || "Valor");

  const unitSpan = document.createElement("span");
  unitSpan.className = "stepper__unit";
  unitSpan.textContent = unit || "";

  const plusBtn = document.createElement("button");
  plusBtn.className = "stepper__btn stepper__btn--plus";
  plusBtn.setAttribute("aria-label", "Aumentar");
  plusBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  function roundToStep(v) {
    const decimals = String(step).includes(".") ? String(step).split(".")[1].length : 0;
    return Number(v.toFixed(decimals));
  }

  function normalize(v) {
    let n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    if (!Number.isFinite(n)) n = min;
    n = Math.max(min, Math.min(max, n));
    return roundToStep(n);
  }

  function render() {
    input.value = Number.isInteger(current) ? String(current) : String(current);
    valueWrap.setAttribute("aria-valuenow", current);
    unitSpan.style.display = unit ? "inline-block" : "none";
  }

  function setValue(v, silent = false) {
    current = normalize(v);
    render();
    if (!silent && onchange) onchange(current);
  }

  function getValue() {
    return current;
  }

  input.addEventListener("focus", () => {
    input.select();
  });

  input.addEventListener("input", () => {
    const raw = input.value.trim();
    if (raw === "" || raw === "-" || raw === "." || raw === ",") return;
    const parsed = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(parsed)) return;
    current = parsed;
    valueWrap.setAttribute("aria-valuenow", current);
    if (onchange) onchange(normalize(parsed));
  });

  input.addEventListener("blur", () => {
    setValue(input.value);
  });

  let pressTimer = null;
  let pressInterval = null;
  let pressCount = 0;

  function startPress(delta) {
    Haptic.light();
    setValue(current + delta);
    pressTimer = setTimeout(() => {
      pressInterval = setInterval(() => {
        pressCount++;
        const acc = pressCount > 20 ? step * 5 : step;
        setValue(current + (delta > 0 ? acc : -acc));
        Haptic.light();
      }, 80);
    }, 400);
  }

  function stopPress() {
    clearTimeout(pressTimer);
    clearInterval(pressInterval);
    pressTimer = null;
    pressInterval = null;
    pressCount = 0;
  }

  ["touchstart", "mousedown"].forEach((evt) => {
    minusBtn.addEventListener(evt, (e) => {
      e.preventDefault();
      minusBtn.classList.add("pressing");
      startPress(-step);
    });
    plusBtn.addEventListener(evt, (e) => {
      e.preventDefault();
      plusBtn.classList.add("pressing");
      startPress(+step);
    });
  });

  ["touchend", "touchcancel", "mouseup", "mouseleave"].forEach((evt) => {
    minusBtn.addEventListener(evt, () => {
      minusBtn.classList.remove("pressing");
      stopPress();
    });
    plusBtn.addEventListener(evt, () => {
      plusBtn.classList.remove("pressing");
      stopPress();
    });
  });

  valueWrap.appendChild(input);
  if (unit) valueWrap.appendChild(unitSpan);

  stepper.appendChild(minusBtn);
  stepper.appendChild(valueWrap);
  stepper.appendChild(plusBtn);
  wrap.appendChild(stepper);

  render();

  return { el: wrap, getValue, setValue };
}
// ============================================================
// MODULE: CHIP SELECTOR — Category/product picker
// ============================================================
function createChipSelector({ id, items, onselect, multiSelect = false }) {
  const group = document.createElement("div");
  group.className = "chip-group";
  group.id = id;
  group.setAttribute("role", "group");

  let selected = new Set();

  items.forEach(item => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.dataset.id = item.id;
    chip.setAttribute("aria-pressed", "false");
    chip.style.setProperty("--chip-color", item.color);

    chip.innerHTML = `
      <span class="chip__dot" style="background:${item.color}"></span>
      <span>${item.emoji || ""} ${item.label}</span>
    `;

    chip.addEventListener("click", () => {
      Haptic.light();

      if (!multiSelect) {
        group.querySelectorAll(".chip").forEach(c => {
          c.classList.remove("selected");
          c.setAttribute("aria-pressed", "false");
        });
        selected.clear();
      }

      const wasSelected = selected.has(item.id);
      if (wasSelected) {
        selected.delete(item.id);
        chip.classList.remove("selected");
        chip.setAttribute("aria-pressed", "false");
      } else {
        selected.add(item.id);
        chip.classList.add("selected");
        chip.setAttribute("aria-pressed", "true");
      }

      if (onselect) onselect(multiSelect ? [...selected] : item.id);
    });

    group.appendChild(chip);
  });

  function getSelected() {
    return multiSelect ? [...selected] : (selected.size ? [...selected][0] : null);
  }

  function reset() {
    selected.clear();
    group.querySelectorAll(".chip").forEach(c => {
      c.classList.remove("selected");
      c.setAttribute("aria-pressed", "false");
    });
  }

  return { el: group, getSelected, reset };
}

// ============================================================
// MODULE: SUCIO — Dirty laundry management
// ============================================================
const SucioModule = (() => {
  let records = [];
  let tara = CONFIG.defaultTara;

  let categoriaSeleccionada = null;
  let brutoPesador = null;

  function calcNeto(bruto) {
    return Math.round((bruto - tara) * 10) / 10;
  }

  async function load() {
    records = await DB.all(DB.STORES.sucio);
    records.sort((a, b) => a.ts - b.ts);
    const cfg = await DB.get(DB.STORES.config, "tara");
    if (cfg) tara = cfg.value;
  }

  function renderSummary() {
    const el = document.getElementById("sucio-summary");
    if (!el) return;

    const totalBruto = records.reduce((s, r) => s + r.bruto, 0);
    const totalNeto  = records.reduce((s, r) => s + r.neto, 0);
    const totalJaulas = records.length;

    const cats = {};
    records.forEach(r => {
      cats[r.categoria] = (cats[r.categoria] || 0) + r.neto;
    });

    const catsCfg = CONFIG.categoriasSucio;

    el.innerHTML = `
      <div class="summary-grid">
        <div class="summary-stat">
          <div class="summary-stat__value">${totalJaulas}</div>
          <div class="summary-stat__label">Jaulas</div>
        </div>
        <div class="summary-stat summary-stat--green">
          <div class="summary-stat__value">${totalNeto.toFixed(1)}</div>
          <div class="summary-stat__label">Kg Neto</div>
        </div>
        <div class="summary-stat">
          <div class="summary-stat__value">${totalBruto.toFixed(1)}</div>
          <div class="summary-stat__label">Kg Bruto</div>
        </div>
      </div>
      ${Object.keys(cats).length > 0 ? `
        <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:8px;">
          ${catsCfg.filter(c => cats[c.id]).map(c => `
            <div style="display:flex;align-items:center;gap:5px;padding:4px 10px;background:color-mix(in srgb,${c.color} 10%,transparent);border:1px solid color-mix(in srgb,${c.color} 25%,transparent);border-radius:100px;font-size:0.72rem;font-weight:700;color:${c.color}">
              <span style="width:6px;height:6px;border-radius:50%;background:${c.color};flex-shrink:0"></span>
              ${c.label}: ${cats[c.id].toFixed(1)} kg
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;
  }

  function renderForm() {
    const card = document.getElementById("sucio-form-card");
    if (!card) return;
    card.innerHTML = "";

    const catSection = document.createElement("div");
    const catTitle = document.createElement("div");
    catTitle.className = "form-section-title";
    catTitle.textContent = "Categoría";
    catSection.appendChild(catTitle);

    const chipSelector = createChipSelector({
      id: "sucio-cats",
      items: CONFIG.categoriasSucio,
      onselect: (id) => { categoriaSeleccionada = id; },
    });
    catSection.appendChild(chipSelector.el);
    card.appendChild(catSection);

    const jaulaSection = document.createElement("div");
    const jaulaTitle = document.createElement("div");
    jaulaTitle.className = "form-section-title";
    jaulaTitle.textContent = "Nº Jaula";
    jaulaSection.appendChild(jaulaTitle);

    const jaulaWrap = document.createElement("div");
    jaulaWrap.className = "jaula-input-wrap";
    const jaulaInput = document.createElement("input");
    jaulaInput.type = "number";
    jaulaInput.className = "jaula-input";
    jaulaInput.placeholder = "Número de jaula";
    jaulaInput.min = 1;
    jaulaInput.max = 999;
    jaulaInput.id = "sucio-jaula-input";
    jaulaInput.inputMode = "numeric";
    jaulaWrap.appendChild(jaulaInput);
    jaulaSection.appendChild(jaulaWrap);
    card.appendChild(jaulaSection);

    const pesoSection = document.createElement("div");

    brutoPesador = createStepper({
      id: "sucio-bruto-stepper",
      label: "Peso Bruto",
      value: tara + 10,
      min: 0,
      max: 500,
      step: 0.5,
      unit: "kg",
      onchange: updateNeto,
    });

    pesoSection.appendChild(brutoPesador.el);
    card.appendChild(pesoSection);

    const metaSection = document.createElement("div");
    metaSection.style.display = "flex";
    metaSection.style.flexDirection = "column";
    metaSection.style.gap = "10px";

    const taraWrap = document.createElement("div");
    taraWrap.innerHTML = `
      <div class="form-section-title">Tara</div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div class="settings-stepper" id="sucio-tara-stepper">
          <button class="settings-stepper__btn" id="sucio-tara-minus" aria-label="Reducir tara">−</button>
          <div class="settings-stepper__val" id="sucio-tara-val">${tara}</div>
          <button class="settings-stepper__btn" id="sucio-tara-plus" aria-label="Aumentar tara">+</button>
        </div>
        <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-muted)">kg</div>
      </div>
    `;
    metaSection.appendChild(taraWrap);

    const netoEl = document.createElement("div");
    netoEl.className = "neto-display";
    netoEl.innerHTML = `
      <div>
        <div class="neto-display__label">Peso Neto</div>
        <div class="neto-display__meta" id="sucio-neto-meta">${brutoPesador.getValue().toFixed(1)} − ${tara} kg</div>
      </div>
      <div class="neto-display__value" id="sucio-neto-value">${calcNeto(brutoPesador.getValue()).toFixed(1)} kg</div>
    `;
    metaSection.appendChild(netoEl);
    card.appendChild(metaSection);

    const addBtn = document.createElement("button");
    addBtn.className = "btn-primary btn-primary--full";
    addBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Añadir Jaula
    `;
    addBtn.id = "sucio-add-btn";
    addBtn.addEventListener("click", addRecord);
    card.appendChild(addBtn);

    const taraMinusBtn = document.getElementById("sucio-tara-minus");
    const taraPlusBtn  = document.getElementById("sucio-tara-plus");
    const taraVal      = document.getElementById("sucio-tara-val");

    taraMinusBtn.addEventListener("click", () => {
      tara = Math.max(0, tara - 1);
      taraVal.textContent = tara;
      updateNeto(brutoPesador.getValue());
      Haptic.light();
    });
    taraPlusBtn.addEventListener("click", () => {
      tara = Math.min(200, tara + 1);
      taraVal.textContent = tara;
      updateNeto(brutoPesador.getValue());
      Haptic.light();
    });

    card._chipSelector = chipSelector;
  }

  function updateNeto(bruto) {
    const neto = calcNeto(bruto);
    const netoBruto = document.getElementById("sucio-neto-value");
    const netoMeta  = document.getElementById("sucio-neto-meta");

    if (netoBruto) {
      netoBruto.textContent = `${neto.toFixed(1)} kg`;
      netoBruto.className = `neto-display__value${neto < 0 ? " negative" : ""}`;
    }
    if (netoMeta) netoMeta.textContent = `${bruto.toFixed(1)} − ${tara} kg`;
  }

  async function addRecord() {
    const jaulaInput = document.getElementById("sucio-jaula-input");
    const bruto = brutoPesador.getValue();
    const neto  = calcNeto(bruto);
    const jaula = jaulaInput.value.trim() || "—";

    if (!categoriaSeleccionada) {
      Toast.warning("Selecciona una categoría");
      Haptic.error();
      return;
    }

    const cat = CONFIG.categoriasSucio.find(c => c.id === categoriaSeleccionada);
    const record = {
      categoria: categoriaSeleccionada,
      categoriaLabel: cat.label,
      categoriaColor: cat.color,
      categoriaEmoji: cat.emoji,
      jaula,
      bruto,
      tara,
      neto,
      ts: Date.now(),
    };

    await DB.add(DB.STORES.sucio, record);
    records = await DB.all(DB.STORES.sucio);

    await Sync.enqueue("sucio", record);

    Haptic.success();
    Toast.success(`Jaula ${jaula} añadida — ${neto.toFixed(1)} kg neto`);

    const card = document.getElementById("sucio-form-card");
    if (card && card._chipSelector) card._chipSelector.reset();
    categoriaSeleccionada = null;
    jaulaInput.value = "";
    brutoPesador.setValue(tara + 10, true);
    updateNeto(tara + 10);

    renderSummary();
    renderList();
    updateBadge();
  }

  async function deleteRecord(id) {
    await DB.del(DB.STORES.sucio, id);
    records = records.filter(r => r.id !== id);
    renderSummary();
    renderList();
    updateBadge();
    Toast.info("Registro eliminado");
    Haptic.medium();
  }

  function renderList() {
    const list  = document.getElementById("sucio-list");
    const empty = document.getElementById("sucio-empty");
    if (!list) return;

    list.innerHTML = "";

    if (records.length === 0) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    const sorted = [...records].reverse();
    sorted.forEach(r => {
      const item = document.createElement("div");
      item.className = "record-item";
      item.style.setProperty("--record-color", r.categoriaColor);
      item.setAttribute("role", "listitem");
      item.innerHTML = `
        <div class="record-item__icon">${r.categoriaEmoji}</div>
        <div class="record-item__body">
          <div class="record-item__title">${r.categoriaLabel} · Jaula ${r.jaula}</div>
          <div class="record-item__subtitle">${r.bruto}kg − ${r.tara}kg tara · ${new Date(r.ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="record-item__value">${r.neto.toFixed(1)}</div>
          <div class="record-item__unit">kg neto</div>
        </div>
        <button class="record-item__delete" aria-label="Eliminar registro">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      `;
      item.querySelector(".record-item__delete").addEventListener("click", async () => {
        const ok = await Confirm.ask("¿Eliminar este registro?");
        if (ok) deleteRecord(r.id);
      });
      list.appendChild(item);
    });
  }

  function updateBadge() {
    const badge = document.getElementById("nav-sucio-badge");
    if (badge) badge.style.display = records.length > 0 ? "block" : "none";
  }

  async function clearAll() {
    const ok = await Confirm.ask("¿Borrar todos los registros de ropa sucia?");
    if (!ok) return;
    await DB.clear(DB.STORES.sucio);
    records = [];
    renderSummary();
    renderList();
    updateBadge();
    Toast.info("Registros borrados");
  }

  async function init() {
    await load();
    renderSummary();
    renderForm();
    renderList();
    updateBadge();

    const btn = document.getElementById("sucio-clear-btn");
    if (btn) btn.addEventListener("click", clearAll);
  }

  return { init, reload: init };
})();

// ============================================================
// MODULE: LIMPIO — Clean laundry (ticket) management
// ============================================================
const LimpioModule = (() => {
  let records = [];
  let productoSeleccionado = null;
  let unidadesStepper = null;

  async function load() {
    records = await DB.all(DB.STORES.limpio);
    records.sort((a, b) => a.ts - b.ts);
  }

  function renderSummary() {
    const el = document.getElementById("limpio-summary");
    if (!el) return;

    const totalUnidades = records.reduce((s, r) => s + r.unidades, 0);
    const totalProductos = records.length;

    el.innerHTML = `
      <div class="summary-grid">
        <div class="summary-stat">
          <div class="summary-stat__value">${totalProductos}</div>
          <div class="summary-stat__label">Productos</div>
        </div>
        <div class="summary-stat summary-stat--accent">
          <div class="summary-stat__value">${totalUnidades}</div>
          <div class="summary-stat__label">Unidades</div>
        </div>
      </div>
    `;
  }

  function renderForm() {
    const card = document.getElementById("limpio-form-card");
    if (!card) return;
    card.innerHTML = "";

    const prodSection = document.createElement("div");
    const prodTitle = document.createElement("div");
    prodTitle.className = "form-section-title";
    prodTitle.textContent = "Producto";
    prodSection.appendChild(prodTitle);

    const chipSelector = createChipSelector({
      id: "limpio-prods",
      items: CONFIG.productosLimpio,
      onselect: (id) => { productoSeleccionado = id; },
    });
    prodSection.appendChild(chipSelector.el);
    card.appendChild(prodSection);

    const unitsSection = document.createElement("div");
    unidadesStepper = createStepper({
      id: "limpio-units-stepper",
      label: "Unidades",
      value: 1,
      min: 1,
      max: 9999,
      step: 1,
      unit: "ud",
    });
    unitsSection.appendChild(unidadesStepper.el);
    card.appendChild(unitsSection);

    const addBtn = document.createElement("button");
    addBtn.className = "btn-primary btn-primary--full btn-primary--green";
    addBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Añadir Ticket
    `;
    addBtn.addEventListener("click", addRecord);
    card.appendChild(addBtn);

    card._chipSelector = chipSelector;
  }

  async function addRecord() {
    if (!productoSeleccionado) {
      Toast.warning("Selecciona un producto");
      Haptic.error();
      return;
    }

    const prod = CONFIG.productosLimpio.find(p => p.id === productoSeleccionado);
    const unidades = unidadesStepper.getValue();

    const allRecords = await DB.all(DB.STORES.limpio);
    const existing = allRecords.find(r => r.producto === productoSeleccionado);

    if (existing) {
      existing.unidades += unidades;
      existing.ts = Date.now();
      await DB.put(DB.STORES.limpio, existing);
      Haptic.medium();
      Toast.info(`${prod.label}: ${existing.unidades} ud. (sumado)`);
    } else {
      const record = {
        producto: productoSeleccionado,
        productoLabel: prod.label,
        productoEmoji: prod.emoji,
        productoColor: prod.color,
        unidades,
        ts: Date.now(),
      };
      await DB.add(DB.STORES.limpio, record);
      Haptic.success();
      Toast.success(`${prod.label} × ${unidades} añadido`);
    }

    records = await DB.all(DB.STORES.limpio);
    records.sort((a, b) => a.ts - b.ts);

    await Sync.enqueue("limpio", { producto: productoSeleccionado, unidades });

    const card = document.getElementById("limpio-form-card");
    if (card && card._chipSelector) card._chipSelector.reset();
    productoSeleccionado = null;
    unidadesStepper.setValue(1, true);

    renderSummary();
    renderList();
    updateBadge();
  }

  async function deleteRecord(id) {
    await DB.del(DB.STORES.limpio, id);
    records = records.filter(r => r.id !== id);
    renderSummary();
    renderList();
    updateBadge();
    Toast.info("Ticket eliminado");
    Haptic.medium();
  }

  function renderList() {
    const list  = document.getElementById("limpio-list");
    const empty = document.getElementById("limpio-empty");
    if (!list) return;

    list.innerHTML = "";

    if (records.length === 0) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    const sorted = [...records].sort((a, b) => b.unidades - a.unidades);
    sorted.forEach(r => {
      const item = document.createElement("div");
      item.className = "record-item";
      item.style.setProperty("--record-color", r.productoColor);
      item.setAttribute("role", "listitem");
      item.innerHTML = `
        <div class="record-item__icon">${r.productoEmoji}</div>
        <div class="record-item__body">
          <div class="record-item__title">${r.productoLabel}</div>
          <div class="record-item__subtitle">${new Date(r.ts).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="record-item__value">${r.unidades}</div>
          <div class="record-item__unit">unid.</div>
        </div>
        <button class="record-item__delete" aria-label="Eliminar ticket">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      `;
      item.querySelector(".record-item__delete").addEventListener("click", async () => {
        const ok = await Confirm.ask("¿Eliminar este ticket?");
        if (ok) deleteRecord(r.id);
      });
      list.appendChild(item);
    });
  }

  function updateBadge() {
    const badge = document.getElementById("nav-limpio-badge");
    if (badge) badge.style.display = records.length > 0 ? "block" : "none";
  }

  async function clearAll() {
    const ok = await Confirm.ask("¿Borrar todos los tickets?");
    if (!ok) return;
    await DB.clear(DB.STORES.limpio);
    records = [];
    renderSummary();
    renderList();
    updateBadge();
    Toast.info("Tickets borrados");
  }

  async function init() {
    await load();
    renderSummary();
    renderForm();
    renderList();
    updateBadge();

    const btn = document.getElementById("limpio-clear-btn");
    if (btn) btn.addEventListener("click", clearAll);
  }

  return { init, reload: init };
})();

// ============================================================
// MODULE: HOTEL — Washing machine cycle management
// ============================================================
const HotelModule = (() => {
  let state = {};

  function stateKey(type, capacity) {
    return `${type}_${capacity}`;
  }

  async function load() {
    const entries = await DB.all(DB.STORES.hotel);
    state = {};
    entries.forEach(e => { state[e.key] = e.value; });
  }

  async function saveState() {
    for (const [key, value] of Object.entries(state)) {
      await DB.put(DB.STORES.hotel, { key, value });
    }
    await Sync.enqueue("hotel", state);
  }

  function getCount(type, capacity) {
    return state[stateKey(type, capacity)] || 0;
  }

  function getTotalKg() {
    let total = 0;
    CONFIG.tiposHotel.forEach(t => {
      CONFIG.capacidadesHotel.forEach(cap => {
        total += getCount(t.id, cap) * cap;
      });
    });
    return total;
  }

  function getTotalCycles() {
    let total = 0;
    Object.values(state).forEach(v => total += v);
    return total;
  }

  function getTypeKg(typeId) {
    let total = 0;
    CONFIG.capacidadesHotel.forEach(cap => {
      total += getCount(typeId, cap) * cap;
    });
    return total;
  }

  function renderSummary() {
    const el = document.getElementById("hotel-summary");
    if (!el) return;

    const totalKg     = getTotalKg();
    const totalCycles = getTotalCycles();

    el.innerHTML = `
      <div class="hotel-totals-grid">
        <div class="hotel-total-card">
          <div class="hotel-total-card__value">${totalCycles}</div>
          <div class="hotel-total-card__label">Ciclos</div>
        </div>
        <div class="hotel-total-card">
          <div class="hotel-total-card__value">${totalKg}</div>
          <div class="hotel-total-card__label">Kg Total</div>
        </div>
        <div class="hotel-total-card">
          <div class="hotel-total-card__value">${CONFIG.tiposHotel.length}</div>
          <div class="hotel-total-card__label">Tipos</div>
        </div>
      </div>
    `;
  }

  function renderMachines() {
    const container = document.getElementById("hotel-machines");
    if (!container) return;
    container.innerHTML = "";

    CONFIG.tiposHotel.forEach(type => {
      const group = document.createElement("div");
      group.className = "hotel-type-group";

      const header = document.createElement("div");
      header.className = "hotel-type-header";
      header.innerHTML = `
        <div class="hotel-type-name">
          <div class="hotel-type-dot" style="background:${type.dot}"></div>
          ${type.label}
        </div>
        <div class="hotel-type-total" id="hotel-type-total-${type.id}">
          ${getTypeKg(type.id)} kg
        </div>
      `;
      group.appendChild(header);

      const machineList = document.createElement("div");
      machineList.className = "hotel-machine-list";

      CONFIG.capacidadesHotel.forEach(cap => {
        const row = document.createElement("div");
        row.className = "machine-row";

        const capLabel = document.createElement("div");
        capLabel.className = "machine-row__capacity";
        capLabel.textContent = `${cap} kg`;

        const controls = document.createElement("div");
        controls.className = "machine-row__controls";

        const minusBtn = document.createElement("button");
        minusBtn.className = "machine-btn machine-btn--minus";
        minusBtn.setAttribute("aria-label", `Reducir ciclos ${type.label} ${cap}kg`);
        minusBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

        const countEl = document.createElement("div");
        countEl.className = "machine-count";
        countEl.id = `hotel-count-${type.id}-${cap}`;
        countEl.textContent = getCount(type.id, cap);
        countEl.setAttribute("role", "button");
        countEl.setAttribute("aria-label", `Ajustar ciclos ${type.label} ${cap}kg con slider`);

        let countPressTimer = null;
        const startCountPress = () => {
          countPressTimer = setTimeout(() => {
            openSliderModal(type, cap, countEl);
          }, 500);
        };
        const stopCountPress = () => clearTimeout(countPressTimer);

        countEl.addEventListener("touchstart", startCountPress, { passive: true });
        countEl.addEventListener("touchend", stopCountPress);
        countEl.addEventListener("mousedown", startCountPress);
        countEl.addEventListener("mouseup", stopCountPress);
        countEl.addEventListener("click", () => openSliderModal(type, cap, countEl));

        const plusBtn = document.createElement("button");
        plusBtn.className = "machine-btn machine-btn--plus";
        plusBtn.setAttribute("aria-label", `Añadir ciclo ${type.label} ${cap}kg`);
        plusBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

        const kgEl = document.createElement("div");
        kgEl.className = "machine-row__kg";
        kgEl.id = `hotel-kg-${type.id}-${cap}`;
        kgEl.textContent = `${getCount(type.id, cap) * cap} kg`;

        let pressTimer = null;
        let pressInterval = null;

        const startPress = (delta) => {
          Haptic.light();
          changeCount(type, cap, delta, countEl, kgEl);
          pressTimer = setTimeout(() => {
            pressInterval = setInterval(() => {
              changeCount(type, cap, delta, countEl, kgEl);
              Haptic.light();
            }, 100);
          }, 400);
        };
        const stopPress = () => {
          clearTimeout(pressTimer);
          clearInterval(pressInterval);
          pressTimer = null;
          pressInterval = null;
        };

        ["touchstart", "mousedown"].forEach(e => {
          minusBtn.addEventListener(e, (ev) => {
            ev.preventDefault();
            minusBtn.classList.add("pressing");
            startPress(-1);
          });
          plusBtn.addEventListener(e, (ev) => {
            ev.preventDefault();
            plusBtn.classList.add("pressing");
            startPress(+1);
          });
        });

        ["touchend", "touchcancel", "mouseup", "mouseleave"].forEach(e => {
          minusBtn.addEventListener(e, () => {
            minusBtn.classList.remove("pressing");
            stopPress();
          });
          plusBtn.addEventListener(e, () => {
            plusBtn.classList.remove("pressing");
            stopPress();
          });
        });

        controls.appendChild(minusBtn);
        controls.appendChild(countEl);
        controls.appendChild(plusBtn);

        row.appendChild(capLabel);
        row.appendChild(controls);
        row.appendChild(kgEl);
        machineList.appendChild(row);
      });

      group.appendChild(machineList);
      container.appendChild(group);
    });
  }

  function changeCount(type, cap, delta, countEl, kgEl) {
    const key = stateKey(type.id, cap);
    state[key] = Math.max(0, (state[key] || 0) + delta);
    countEl.textContent = state[key];
    kgEl.textContent = `${state[key] * cap} kg`;

    const typeTotal = document.getElementById(`hotel-type-total-${type.id}`);
    if (typeTotal) typeTotal.textContent = `${getTypeKg(type.id)} kg`;

    renderSummary();
    debouncedSave();
  }

  let saveDebounce = null;
  function debouncedSave() {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => saveState(), 800);
  }

  function openSliderModal(type, cap, countEl) {
    Haptic.medium();
    const current = getCount(type.id, cap);

    Modal.open(`
      <div class="slider-modal-title">${type.label} · ${cap} kg</div>
      <div class="slider-modal-value" id="slider-modal-val">${current}</div>
      <div class="slider-wrap">
        <input type="range" class="slider-input" id="hotel-slider"
          min="0" max="15" value="${current}" step="1" />
        <div class="slider-labels">
          <span>0</span>
          <span>5</span>
          <span>10</span>
          <span>15</span>
        </div>
      </div>
      <button class="btn-primary btn-primary--full" id="slider-confirm-btn">Confirmar</button>
    `);

    const slider  = document.getElementById("hotel-slider");
    const valDisp = document.getElementById("slider-modal-val");

    slider.addEventListener("input", () => {
      valDisp.textContent = slider.value;
      Haptic.light();
    });

    document.getElementById("slider-confirm-btn").addEventListener("click", () => {
      const newVal = parseInt(slider.value, 10);
      const key = stateKey(type.id, cap);
      state[key] = newVal;
      countEl.textContent = newVal;

      const kgEl = document.getElementById(`hotel-kg-${type.id}-${cap}`);
      if (kgEl) kgEl.textContent = `${newVal * cap} kg`;

      const typeTotal = document.getElementById(`hotel-type-total-${type.id}`);
      if (typeTotal) typeTotal.textContent = `${getTypeKg(type.id)} kg`;

      renderSummary();
      debouncedSave();
      Modal.close();
      Toast.success(`${type.label} ${cap}kg → ${newVal} ciclos`);
      Haptic.success();
    });
  }

  async function init() {
    await load();
    renderSummary();
    renderMachines();
  }

  return { init };
})();

// ============================================================
// MODULE: SETTINGS — App configuration
// ============================================================
const SettingsModule = (() => {
  async function render() {
    const el = document.getElementById("settings-content");
    if (!el) return;

    const taraCfg    = await DB.get(DB.STORES.config, "tara");
    const vibCfg     = await DB.get(DB.STORES.config, "vibration");
    const syncUrlCfg = await DB.get(DB.STORES.config, "syncUrl");

    const currentTara = taraCfg ? taraCfg.value : CONFIG.defaultTara;
    const currentVib  = vibCfg !== undefined ? (vibCfg ? vibCfg.value : CONFIG.vibration) : CONFIG.vibration;
    const currentSync = syncUrlCfg ? syncUrlCfg.value : CONFIG.syncEndpoint;

    el.innerHTML = `
      <div class="settings-group">
        <div class="settings-group__title">Información</div>
        <div class="settings-row">
          <div>
            <div class="settings-row__label">Versión</div>
            <div class="settings-row__desc">LaundryPro</div>
          </div>
          <div class="settings-row__control">
            <span style="font-family:var(--font-mono);font-size:0.82rem;color:var(--text-muted)">${CONFIG.version}</span>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row__label">Estado</div>
          </div>
          <div class="settings-row__control">
            <div class="online-pill ${navigator.onLine ? "online" : "offline"}" id="settings-status-pill">
              <span class="online-pill__dot"></span>
              <span>${navigator.onLine ? "Online" : "Offline"}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group__title">General</div>
        <div class="settings-row">
          <div>
            <div class="settings-row__label">Tara por defecto</div>
            <div class="settings-row__desc">Peso vacío de jaula (kg)</div>
          </div>
          <div class="settings-row__control">
            <div class="settings-stepper">
              <button class="settings-stepper__btn" id="cfg-tara-minus" aria-label="Reducir tara">−</button>
              <div class="settings-stepper__val" id="cfg-tara-val">${currentTara}</div>
              <button class="settings-stepper__btn" id="cfg-tara-plus" aria-label="Aumentar tara">+</button>
            </div>
            <span style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-muted);margin-left:6px">kg</span>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row__label">Vibración táctil</div>
            <div class="settings-row__desc">Feedback háptico</div>
          </div>
          <div class="settings-row__control">
            <label class="toggle" aria-label="Activar vibración">
              <input type="checkbox" id="cfg-vibration" ${currentVib ? "checked" : ""}/>
              <div class="toggle__track"></div>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group__title">Sincronización</div>
        <div class="settings-row">
          <div>
            <div class="settings-row__label">Cola de sincronización</div>
            <div class="settings-row__desc" id="cfg-queue-desc">Cargando...</div>
          </div>
          <div class="settings-row__control">
            <button class="btn-ghost btn--sm" id="cfg-flush-btn" aria-label="Sincronizar ahora">Sync</button>
          </div>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row__label">URL de webhook (Google Sheets)</div>
          <input type="url" id="cfg-sync-url"
            style="background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-md);color:var(--text-secondary);font-family:var(--font-mono);font-size:0.72rem;height:40px;padding:0 12px;width:100%"
            placeholder="https://hooks.zapier.com/..."
            value="${currentSync}" />
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group__title">Datos</div>
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:12px">
          <div class="settings-row__label">Exportar registros del día</div>
          <button class="sync-btn" id="cfg-export-btn" aria-label="Exportar datos">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Exportar JSON
          </button>
          <div id="cfg-export-preview"></div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-row__label" style="color:var(--accent-red)">Borrar todos los datos</div>
            <div class="settings-row__desc">Elimina registros de hoy</div>
          </div>
          <div class="settings-row__control">
            <button class="btn-danger btn--sm" id="cfg-clear-all-btn" aria-label="Borrar todos los datos">Borrar</button>
          </div>
        </div>
      </div>

      <div style="text-align:center;padding:var(--spacing-xl);color:var(--text-muted)">
        <div style="font-size:0.7rem;font-family:var(--font-mono)">LaundryPro v${CONFIG.version}</div>
        <div style="font-size:0.65rem;margin-top:4px">Gestión hotelera de lavandería</div>
      </div>
    `;

    let taraCurrent = currentTara;
    const taraVal  = document.getElementById("cfg-tara-val");

    document.getElementById("cfg-tara-minus").addEventListener("click", async () => {
      taraCurrent = Math.max(0, taraCurrent - 1);
      taraVal.textContent = taraCurrent;
      CONFIG.defaultTara = taraCurrent;
      await DB.put(DB.STORES.config, { key: "tara", value: taraCurrent });
      Haptic.light();
    });

    document.getElementById("cfg-tara-plus").addEventListener("click", async () => {
      taraCurrent = Math.min(200, taraCurrent + 1);
      taraVal.textContent = taraCurrent;
      CONFIG.defaultTara = taraCurrent;
      await DB.put(DB.STORES.config, { key: "tara", value: taraCurrent });
      Haptic.light();
    });

    document.getElementById("cfg-vibration").addEventListener("change", async (e) => {
      CONFIG.vibration = e.target.checked;
      await DB.put(DB.STORES.config, { key: "vibration", value: e.target.checked });
      if (e.target.checked) Haptic.medium();
    });

    document.getElementById("cfg-sync-url").addEventListener("change", async (e) => {
      CONFIG.syncEndpoint = e.target.value;
      await DB.put(DB.STORES.config, { key: "syncUrl", value: e.target.value });
      Toast.info("URL guardada");
    });

    const pending = await Sync.loadQueueCount();
    const qDesc = document.getElementById("cfg-queue-desc");
    if (qDesc) qDesc.textContent = `${pending} registro${pending !== 1 ? "s" : ""} pendiente${pending !== 1 ? "s" : ""}`;

    document.getElementById("cfg-flush-btn").addEventListener("click", async () => {
      if (!navigator.onLine) {
        Toast.warning("Sin conexión — datos guardados localmente");
        return;
      }
      const btn = document.getElementById("cfg-flush-btn");
      btn.classList.add("syncing");
      btn.textContent = "...";
      await Sync.flush();
      await Sync.clearSynced();
      btn.classList.remove("syncing");
      btn.textContent = "Sync";
      Toast.success("Sincronización completada");
      Haptic.success();
      render();
    });

    document.getElementById("cfg-export-btn").addEventListener("click", async () => {
      const sucio  = await DB.all(DB.STORES.sucio);
      const limpio = await DB.all(DB.STORES.limpio);
      const hotel  = await DB.all(DB.STORES.hotel);
      const data   = {
        exportedAt: new Date().toISOString(),
        date: new Date().toLocaleDateString("es-ES"),
        sucio, limpio, hotel,
      };
      const json = JSON.stringify(data, null, 2);
      const preview = document.getElementById("cfg-export-preview");
      if (preview) {
        preview.innerHTML = `<div class="export-preview">${json.substring(0, 400)}${json.length > 400 ? "\n..." : ""}</div>`;
      }

      const blob = new Blob([json], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `laundrypro-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Toast.success("Datos exportados");
      Haptic.success();
    });

    document.getElementById("cfg-clear-all-btn").addEventListener("click", async () => {
      const ok = await Confirm.ask("¿Borrar TODOS los datos de hoy? Esta acción no se puede deshacer.");
      if (!ok) return;
      await DB.clear(DB.STORES.sucio);
      await DB.clear(DB.STORES.limpio);
      await DB.clear(DB.STORES.hotel);
      Toast.info("Todos los datos borrados");
      Haptic.heavy();
      await SucioModule.init();
      await LimpioModule.init();
      await HotelModule.init();
      render();
    });
  }

  async function init() {
    await render();
  }

  return { init };
})();

// ============================================================
// MODULE: NAVIGATION — Tab switching
// ============================================================
const Navigation = (() => {
  let currentTab = "sucio";
  const tabs = ["sucio", "limpio", "hotel", "ajustes"];

  function switchTo(tabId) {
    if (tabId === currentTab) return;
    Haptic.light();

    tabs.forEach(t => {
      const panel = document.getElementById(`tab-${t}`);
      if (panel) panel.style.display = t === tabId ? "flex" : "none";
    });

    tabs.forEach(t => {
      const navBtn = document.getElementById(`nav-${t}`);
      if (navBtn) {
        navBtn.classList.toggle("active", t === tabId);
        navBtn.setAttribute("aria-selected", t === tabId ? "true" : "false");
      }
    });

    currentTab = tabId;
  }

  function init() {
    tabs.forEach(t => {
      const btn = document.getElementById(`nav-${t}`);
      if (btn) btn.addEventListener("click", () => switchTo(t));
    });
  }

  return { init, switchTo };
})();

// ============================================================
// MODULE: ONLINE STATUS — Network monitoring
// ============================================================
const OnlineStatus = (() => {
  function update() {
    const online = navigator.onLine;

    const pill  = document.getElementById("header-online-pill");
    const label = document.getElementById("header-online-label");
    if (pill && label) {
      pill.className = `online-pill ${online ? "online" : "offline"}`;
      label.textContent = online ? "Online" : "Offline";
    }

    const dot  = document.getElementById("splash-status-dot");
    const slbl = document.getElementById("splash-status-label");
    if (dot && slbl) {
      dot.className  = `status-dot ${online ? "online" : "offline"}`;
      slbl.textContent = online ? "Conectado" : "Sin conexión";
    }

    if (online) Sync.flush();
  }

  function init() {
    window.addEventListener("online", () => {
      update();
      Toast.success("Conexión restaurada");
      Haptic.success();
    });
    window.addEventListener("offline", () => {
      update();
      Toast.warning("Sin conexión — datos guardados");
      Haptic.heavy();
    });
    update();
  }

  return { init };
})();

// ============================================================
// MODULE: SERVICE WORKER
// ============================================================
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    console.log("[LaundryPro] SW registered:", reg.scope);
  } catch (err) {
    console.warn("[LaundryPro] SW registration failed:", err);
  }
}

// ============================================================
// MODULE: SPLASH — Initial screen
// ============================================================
async function initSplash() {
  const dateEl = document.getElementById("splash-date");
  if (dateEl) {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString("es-ES", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  await Sync.loadQueueCount();

  const startBtn = document.getElementById("splash-start-btn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      Haptic.medium();
      const splash = document.getElementById("splash-screen");
      const app    = document.getElementById("app");

      splash.classList.add("fade-out");
      setTimeout(() => {
        splash.style.display = "none";
        app.style.display = "flex";
      }, 400);
    });
  }
}

// ============================================================
// APP INIT — Bootstrap everything
// ============================================================
async function init() {
  try {
    await DB.open();

    const vibCfg     = await DB.get(DB.STORES.config, "vibration");
    const syncUrlCfg = await DB.get(DB.STORES.config, "syncUrl");
    const taraCfg    = await DB.get(DB.STORES.config, "tara");

    if (vibCfg !== undefined && vibCfg !== null) CONFIG.vibration = vibCfg.value;
    if (syncUrlCfg) CONFIG.syncEndpoint = syncUrlCfg.value;
    if (taraCfg) CONFIG.defaultTara = taraCfg.value;

    OnlineStatus.init();
    Navigation.init();

    await SucioModule.init();
    await LimpioModule.init();
    await HotelModule.init();
    await SettingsModule.init();

    await initSplash();

    registerServiceWorker();

    if (navigator.onLine) {
      setTimeout(() => Sync.flush(), 2000);
    }

    console.log("[LaundryPro] App initialized v" + CONFIG.version);
  } catch (err) {
    console.error("[LaundryPro] Init error:", err);
    Toast.error("Error al iniciar la app. Recarga la página.");
  }
}

document.addEventListener("DOMContentLoaded", init);
