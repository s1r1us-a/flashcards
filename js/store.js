/* =============================================================================
 * Flashcards – Data Access Layer
 * Backed by Firebase Realtime Database.
 * ========================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsSupported }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";
import {
  getDatabase, ref, onValue, set, update, remove,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDf19KTKfpjKZyLRR4guw18Em3B6FqoTp8",
  authDomain: "flashcards-98d40.firebaseapp.com",
  databaseURL: "https://flashcards-98d40-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "flashcards-98d40",
  storageBucket: "flashcards-98d40.firebasestorage.app",
  messagingSenderId: "269035893008",
  appId: "1:269035893008:web:caec98e8ff6a6aa8713595",
  measurementId: "G-Y3041VDZ3F",
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

analyticsSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {});

/* ---------- helpers ---------- */

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const cache = { categories: {}, cards: {} };
const listeners = new Set();
let ready = { categories: false, cards: false };

function notify() {
  listeners.forEach((cb) => {
    try { cb(cache); } catch (e) { console.error("[Store] listener error", e); }
  });
}

onValue(ref(db, "categories"), (snap) => {
  cache.categories = snap.val() || {};
  ready.categories = true;
  notify();
}, (err) => console.error("[Store] categories read failed", err));

onValue(ref(db, "cards"), (snap) => {
  cache.cards = snap.val() || {};
  ready.cards = true;
  notify();
}, (err) => console.error("[Store] cards read failed", err));

/* ---------- public API ---------- */

const Store = {
  isReady() { return ready.categories && ready.cards; },

  async getCategories() {
    return Object.values(cache.categories).sort((a, b) => a.createdAt - b.createdAt);
  },

  async getCategory(id) {
    return cache.categories[id] || null;
  },

  async addCategory(name, color) {
    const cat = {
      id: uid("cat"),
      name: (name || "").trim() || "Neue Box",
      color: color || "#8b5cf6",
      createdAt: Date.now(),
    };
    cache.categories[cat.id] = cat;
    notify();
    await set(ref(db, `categories/${cat.id}`), cat);
    return cat;
  },

  async updateCategory(id, patch) {
    const current = cache.categories[id];
    if (!current) return null;
    const next = { ...current, ...patch };
    cache.categories[id] = next;
    notify();
    await update(ref(db, `categories/${id}`), patch);
    return next;
  },

  async deleteCategory(id) {
    const updates = {};
    updates[`categories/${id}`] = null;
    Object.values(cache.cards).forEach((card) => {
      if (card.categoryId === id) updates[`cards/${card.id}`] = null;
    });
    delete cache.categories[id];
    Object.keys(cache.cards).forEach((k) => {
      if (cache.cards[k].categoryId === id) delete cache.cards[k];
    });
    notify();
    await update(ref(db), updates);
  },

  async getCards(categoryId) {
    const all = Object.values(cache.cards);
    const list = categoryId ? all.filter((c) => c.categoryId === categoryId) : all;
    return list.sort((a, b) => a.createdAt - b.createdAt);
  },

  async getCard(id) {
    return cache.cards[id] || null;
  },

  async addCard(categoryId, front, back) {
    const card = {
      id: uid("card"),
      categoryId,
      front: (front || "").trim(),
      back: (back || "").trim(),
      progress: { seen: 0, correct: 0, wrong: 0, lastReviewed: 0 },
      createdAt: Date.now(),
    };
    cache.cards[card.id] = card;
    notify();
    await set(ref(db, `cards/${card.id}`), card);
    return card;
  },

  async updateCard(id, patch) {
    const current = cache.cards[id];
    if (!current) return null;
    const next = { ...current, ...patch };
    cache.cards[id] = next;
    notify();
    await update(ref(db, `cards/${id}`), patch);
    return next;
  },

  async deleteCard(id) {
    delete cache.cards[id];
    notify();
    await remove(ref(db, `cards/${id}`));
  },

  async recordAnswer(cardId, correct) {
    const card = cache.cards[cardId];
    if (!card) return null;
    const progress = {
      seen:    (card.progress?.seen    || 0) + 1,
      correct: (card.progress?.correct || 0) + (correct ? 1 : 0),
      wrong:   (card.progress?.wrong   || 0) + (correct ? 0 : 1),
      lastReviewed: Date.now(),
    };
    cache.cards[cardId] = { ...card, progress };
    notify();
    await update(ref(db, `cards/${cardId}/progress`), progress);
    return cache.cards[cardId];
  },

  subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};

window.Store = Store;
export default Store;
