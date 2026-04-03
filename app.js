"use strict";

/*
LaundryPro — app.js (CLEAN FIXED VERSION)
*/

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  version: "1.0.0",
  dbName: "laundrypro_db",
  dbVersion: 1,
  syncEndpoint: "https://hooks.zapier.com/hooks/catch/PLACEHOLDER/",
  defaultTara: 42,
  vibration: true,

  categoriasSucio: [
    { id: "blanca", label: "Blanca", color: "#e0e7ff" },
    { id: "color", label: "Color", color: "#fca5a5" },
    { id: "cocina", label: "Cocina", color: "#fde68a" },
    { id: "piscina", label: "Piscina", color: "#7dd3fc" },
    { id: "toallas", label: "Toallas", color: "#86efac" },
    { id: "varios", label: "Varios", color: "#d8b4fe" },
  ],

  productosLimpio: [
    { id: "sabanas_90", label: "Sábanas 90" },
    { id: "sabanas_135", label: "Sábanas 135" },
    { id: "sabanas_180", label: "Sábanas 180" },
    { id: "fundas", label: "Fundas" },
    { id: "toallas_mano", label: "T. Mano" },
    { id: "toallas_bano", label: "T. Baño" },
    { id: "toallas_gran", label: "T. Grande" },
    { id: "alfombras", label: "Alfombras" },
    { id: "batines", label: "Batines" },
    { id: "manteleria", label: "Mantelería" },
    { id: "uniformes", label: "Uniformes" },
    { id: "otros", label: "Otros" },
  ],

  tiposHotel: [
    { id: "blanca", label: "Blanca" },
    { id: "piscina", label: "Piscina" },
    { id: "varios", label: "Varios" },
  ],

  capacidadesHotel: [55, 24, 13, 8],
};

// ============================================================
// DB
// ============================================================
const DB = (() => {
  let db = null;

  const STORES = {
    sucio: "sucio_records",
    limpio: "limpio_records",
    hotel: "hotel_state",
  };

  async function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);

      req.onupgradeneeded = (e) => {
        const d = e.target.result;

        if (!d.objectStoreNames.contains(STORES.sucio)) {
          d.createObjectStore(STORES.sucio, { keyPath: "id", autoIncrement: true });
        }

        if (!d.objectStoreNames.contains(STORES.limpio)) {
          d.createObjectStore(STORES.limpio, { keyPath: "id", autoIncrement: true });
        }

        if (!d.objectStoreNames.contains(STORES.hotel)) {
          d.createObjectStore(STORES.hotel, { keyPath: "key" });
        }
      };

      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };

      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(store, mode = "readonly") {
    return db.transaction(store, mode).objectStore(store);
  }

  function all(store) {
    return new Promise((res) => {
      tx(store).getAll().onsuccess = (e) => res(e.target.result);
    });
  }

  function add(store, val) {
    return new Promise((res) => {
      tx(store, "readwrite").add(val).onsuccess = () => res();
    });
  }

  function put(store, val) {
    return new Promise((res) => {
      tx(store, "readwrite").put(val).onsuccess = () => res();
    });
  }

  return { open, all, add, put, STORES };
})();

// ============================================================
// SUCIO
// ============================================================
const SucioModule = (() => {
  let records = [];

  async function load() {
    records = await DB.all(DB.STORES.sucio);
  }

  async function addRecord(data) {
    await DB.add(DB.STORES.sucio, data);
    await load();
    render();
  }

  function render() {
    console.log("SUCIO:", records);
  }

  return { load, addRecord, render };
})();

// ============================================================
// LIMPIO
// ============================================================
const LimpioModule = (() => {
  let records = [];

  async function load() {
    records = await DB.all(DB.STORES.limpio);
  }

  async function addRecord(producto, unidades) {
    const existing = records.find(r => r.producto === producto);

    if (existing) {
      existing.unidades += unidades;
      await DB.put(DB.STORES.limpio, existing);
    } else {
      await DB.add(DB.STORES.limpio, {
        producto,
        unidades,
        ts: Date.now()
      });
    }

    await load();
    render();
  }

  function render() {
    console.log("LIMPIO:", records);
  }

  return { load, addRecord, render };
})();

// ============================================================
// HOTEL
// ============================================================
const HotelModule = (() => {
  let state = {};

  async function load() {
    const data = await DB.all(DB.STORES.hotel);
    state = {};
    data.forEach(d => state[d.key] = d.value);
  }

  async function set(key, value) {
    state[key] = value;
    await DB.put(DB.STORES.hotel, { key, value });
  }

  function get(key) {
    return state[key] || 0;
  }

  return { load, set, get };
})();

// ============================================================
// INIT
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
  await DB.open();

  await SucioModule.load();
  await LimpioModule.load();
  await HotelModule.load();

  console.log("APP OK");
});
