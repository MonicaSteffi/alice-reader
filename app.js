// Alice reader: a graded reader for iPhone that works offline and keeps all progress on the phone.
import * as db from './db.js';

const APP_VERSION = '1.2.0';
const DEFAULT_PREFS = {
  fontSize: 19, theme: 'auto', markNew: true, markStory: true, markSaved: true,
  lastBackup: null, persistAsked: false,
  mode: 'read', rate: 0.85, voice: '',
};
const RATES = [[0.7, 'Slow'], [0.85, 'Normal'], [1, 'Fast']];
const LEVEL_LABEL = { A1: 'A1', A2: 'A2', B1: 'B1', B2: 'B2', B2x: 'B2+', OUT: 'rare', F: 'grammar word', NAME: 'name', NUM: 'number' };
const POS_LABEL = {
  NOUN: 'noun', PROPN: 'name', VERB: 'verb', AUX: 'auxiliary verb', ADJ: 'adjective', ADV: 'adverb',
  ADP: 'preposition', DET: 'article', PRON: 'pronoun', NUM: 'number', CCONJ: 'conjunction',
  SCONJ: 'conjunction', PART: 'particle', INTJ: 'interjection', X: 'word',
};
const COMMON_GRAMMAR = new Set(['PRAES', 'KON_UND_ABER_ODER', 'W_FRAGE', 'PRAET_VOLL', 'PRAET_SEIN_HABEN']);
const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.5v14H6zM19 5.5v13L9.5 12z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5H18v14h-2.5zM5 5.5v13L14.5 12z" fill="currentColor"/></svg>',
  books: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4.5h4.5v15H4zM10.5 4.5H15v15h-4.5zM16.6 5.2l3.9-1 3 14.6-3.9 1z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" transform="translate(-1.5 0)"/></svg>',
  words: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

const state = {
  meta: null, manifest: null, lexicon: {}, glosses: {}, prefs: { ...DEFAULT_PREFS },
  progress: new Map(), words: new Map(), voices: [], streak: 0, reader: null, shelf: [], bookId: null,
  listen: { playing: false, idx: -1, gen: 0, resumeOnClose: false, utt: null, gap: null },
};
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const backdrop = document.getElementById('sheet-backdrop');

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => fmtDate(new Date());
const mdInline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
const cleanEntry = (s) => String(s).split(',')[0].trim();

function articleFor(gender) {
  if (!gender) return '';
  const map = { m: 'der', f: 'die', n: 'das', pl: 'die' };
  return gender.split('/').map((g) => map[g] || '').filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('/');
}

function progressOf(num) {
  return state.progress.get(num) || { num, status: 'new', pct: 0, pos: 0, seconds: 0, updated: null };
}

function wordStatus(lemma) {
  return state.words.get(lemma)?.status || null;
}

function partOf(num) {
  return state.manifest.parts.find((p) => p.num === num);
}

function toast(msg, actionLabel, action, ms = 4500) {
  const el = document.getElementById('toast');
  el.innerHTML = `${esc(msg)}${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (actionLabel) el.querySelector('button').onclick = () => { el.hidden = true; action(); };
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

async function savePrefs() {
  await db.put('settings', state.prefs, 'prefs');
}

function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = state.prefs.theme;
  root.style.setProperty('--fs', `${state.prefs.fontSize}px`);
  const dark = state.prefs.theme === 'dark' || (state.prefs.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#111213' : (state.prefs.theme === 'sepia' ? '#f4ecd8' : '#fbfaf7');
}

function setMeta(meta) {
  state.meta = meta;
  state.manifest = meta.manifest;
  state.lexicon = meta.lexicon || {};
  state.glosses = meta.glosses || {};
}

// ------------------------------------------------------------------ start
function currentBookId() {
  try { return localStorage.getItem('currentBook'); } catch (e) { return null; }
}

function setCurrentBookId(id) {
  try { localStorage.setItem('currentBook', id); } catch (e) { /* storage blocked */ }
}

// The shelf lists the books stored with the app (books/index.json). Offline, the service worker serves the last copy.
async function loadShelf() {
  try {
    const resp = await fetch('books/index.json', { cache: 'no-cache' });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data.books) ? data.books.filter((b) => b && b.id && b.file) : [];
  } catch (e) { return []; }
}

// Switch the storage to one book and load its progress. Text settings carry over between books.
async function loadBookState(id) {
  const carry = state.prefs;
  db.useBook(id);
  await db.openDB();
  const saved = await db.get('settings', 'prefs');
  state.prefs = { ...DEFAULT_PREFS, ...(saved || carry) };
  if (!saved && state.bookId) await savePrefs();
  applyPrefs();
  state.bookId = id;
  state.meta = null; state.manifest = null; state.lexicon = {}; state.glosses = {};
  const meta = await db.get('meta', 'book');
  if (meta) setMeta(meta);
  state.progress = new Map((await db.getAll('progress')).map((p) => [p.num, p]));
  state.words = new Map((await db.getAll('words')).map((w) => [w.lemma, w]));
  await computeStreak();
}

async function init() {
  applyPrefs();
  state.shelf = await loadShelf();
  // Without a shelf the app works as before: one book, loaded from a file.
  const id = currentBookId() || (state.shelf.length ? null : 'alice');
  try {
    await loadBookState(id || 'alice');
    // An Alice book loaded before the shelf existed counts as the open book.
    if (!id) { if (state.meta) setCurrentBookId('alice'); else state.bookId = null; }
  } catch (e) {
    app.innerHTML = `<div class="card"><h2>Storage is not available</h2><p>${esc(e.message || e)}</p><p class="muted">Private browsing can block storage. Open the app from the Home Screen icon.</p></div>`;
    return;
  }
  window.addEventListener('hashchange', route);
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPrefs);
  route();
  registerSW();
  loadVoices();
  maybePersist(false);
  if (state.meta) checkBookUpdate();
}

// If the shelf has a newer version of the open book, load it in the background. Progress is kept.
async function checkBookUpdate() {
  const entry = state.shelf.find((b) => b.id === state.bookId);
  if (!entry || !entry.version || !state.meta || state.meta.bookVersion === entry.version) return;
  try {
    const data = await fetchBook(entry);
    await importBook(data, entry.version);
    toast(`${entry.title} was updated.`);
    if (!location.hash.startsWith('#/read')) route();
  } catch (e) { /* offline: keep the current version */ }
}

function route() {
  stopListening();
  closeSheet();
  stopReading();
  const h = location.hash || '#/';
  if (h.startsWith('#/books') || !state.meta) {
    if (state.shelf.length) renderShelf(); else renderWelcome();
    return;
  }
  const m = h.match(/^#\/read\/(\d+)/);
  if (m) { renderReader(Number(m[1])); return; }
  if (h.startsWith('#/words')) { renderWords(); return; }
  if (h.startsWith('#/settings')) { renderSettings(); return; }
  renderLibrary();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('A new version of the app is ready.', 'Reload', () => location.reload(), 10000);
    hadController = true;
  });
}

async function maybePersist(force) {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    if (await navigator.storage.persisted()) return;
    if (!force && state.prefs.persistAsked) return;
    if (isIOS() && !isStandalone()) return;
    await navigator.storage.persist();
    state.prefs.persistAsked = true;
    await savePrefs();
  } catch (e) { /* not supported */ }
}

// ------------------------------------------------------------------ speech
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const set = () => { state.voices = speechSynthesis.getVoices().filter((v) => /^de([-_]|$)/i.test(v.lang)); };
  set();
  if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', set);
}

function pickVoice() {
  return state.voices.find((x) => x.voiceURI === state.prefs.voice)
    || state.voices.find((x) => /de[-_]DE/i.test(x.lang)) || state.voices[0] || null;
}

// Speak one piece of German text. onEnd runs only if this utterance finished on its own
// (cancel() fires onend in some browsers, the generation counter ignores those).
function speak(text, onEnd, rate = 0.9) {
  if (!('speechSynthesis' in window)) { toast('Speech is not available on this device.'); return; }
  const L = state.listen;
  L.gen += 1;
  const gen = L.gen;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = rate;
  u.onend = () => { if (gen === L.gen && onEnd) onEnd(); };
  u.onerror = (e) => { if (gen === L.gen && onEnd && e.error !== 'interrupted' && e.error !== 'canceled') onEnd(); };
  L.utt = u; // keep a reference so the browser does not drop the callbacks
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function silence() {
  state.listen.gen += 1;
  clearTimeout(state.listen.gap);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ------------------------------------------------------------------ welcome and book import
function showInstall() {
  return isIOS() && !isStandalone();
}

function installCardHTML(where) {
  return `
    <div class="card">
      <h2>1. Install the app</h2>
      <ol class="steps">
        <li>Tap the <b>Share</b> button in Safari.</li>
        <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open <b>Alice</b> from the new icon on your Home Screen.</li>
      </ol>
      <div class="note">${where} inside the installed app, not here in Safari. On iPhone, Safari and the installed app keep separate storage.</div>
    </div>`;
}

function renderWelcome() {
  const inst = showInstall();
  app.innerHTML = `
    <div class="hero"><h1>Alice im Wunderland</h1><div class="sub">Leseroman A1 bis B2</div></div>
    ${inst ? installCardHTML('Load the book') : ''}
    <div class="card">
      <h2>${inst ? '2. ' : ''}Load the book</h2>
      <p>Choose the book file (a <b>.json</b> file) from the Files app. The book is saved on this phone only. Nothing is uploaded.</p>
      <button class="btn primary block" id="load-btn" type="button">Choose book file</button>
      <input type="file" id="book-file" hidden>
      <p id="load-status" class="small muted" aria-live="polite"></p>
    </div>
    <p class="small muted">Version ${APP_VERSION}</p>`;
  $('#load-btn').onclick = () => $('#book-file').click();
  $('#book-file').onchange = (e) => handleBookFile(e.target.files[0], $('#load-status'));
}

function slug(t) {
  return String(t || 'book').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'book';
}

function checkBookData(data) {
  if (!data || data.format !== 'alice-book' || !Array.isArray(data.chapters) || !data.manifest) {
    throw new Error('This is not a book file for this app.');
  }
}

async function importBook(data, version) {
  checkBookData(data);
  const meta = {
    manifest: data.manifest, lexicon: data.lexicon || {}, glosses: data.glosses || {},
    built: data.built || null, bookVersion: version || data.version || 1, loadedAt: new Date().toISOString(),
  };
  await db.replaceBook(meta, data.chapters);
  setMeta(meta);
}

async function fetchBook(entry) {
  const resp = await fetch(entry.file, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`Could not download “${entry.title}” (error ${resp.status}).`);
  try { return await resp.json(); } catch (e) { throw new Error(`“${entry.title}” is not a valid book file.`); }
}

function goHome() {
  if (location.hash !== '#/') location.hash = '#/'; else route();
}

// Open a book from the shelf. The first time, it is downloaded once and then works offline.
async function openShelfBook(id, statusEl) {
  const entry = state.shelf.find((b) => b.id === id);
  if (!entry) return;
  stopListening();
  try {
    await loadBookState(id);
    if (!state.meta) {
      statusEl.textContent = `Downloading “${entry.title}” …`;
      await importBook(await fetchBook(entry), entry.version);
      await maybePersist(true);
    }
    setCurrentBookId(id);
    goHome();
    checkBookUpdate();
  } catch (e) {
    statusEl.innerHTML = `<span class="error">${esc(e.message || e)}</span>`;
  }
}

async function handleBookFile(file, statusEl) {
  if (!file) return;
  statusEl.textContent = 'Reading the file …';
  try {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('This file is not a book file (it is not JSON).'); }
    checkBookData(data);
    const title = data.manifest.book?.title || '';
    const id = data.id || state.shelf.find((b) => b.title === title)?.id || (state.shelf.length ? slug(title) : 'alice');
    stopListening();
    await loadBookState(id);
    statusEl.textContent = `Saving ${data.chapters.length} chapters …`;
    await importBook(data);
    setCurrentBookId(id);
    statusEl.textContent = 'Done.';
    toast('Book loaded. Viel Spaß beim Lesen!');
    await maybePersist(true);
    goHome();
  } catch (e) {
    statusEl.innerHTML = `<span class="error">${esc(e.message || e)}</span>`;
  }
}

// ------------------------------------------------------------------ shelf
function renderShelf() {
  const inst = showInstall();
  const rows = state.shelf.map((b) => {
    const current = b.id === state.bookId && state.meta;
    return `<div class="book-row${current ? ' current' : ''}">
      <div class="grow">
        <b>${esc(b.title)}</b>
        <span>${esc([b.subtitle, b.level].filter(Boolean).join(' · '))}</span>
      </div>
      <button class="btn${current ? '' : ' primary'}" type="button" data-book="${esc(b.id)}">${current ? 'Reading' : 'Open'}</button>
    </div>`;
  }).join('');
  app.innerHTML = `
    <header class="topbar">
      ${state.meta ? `<a class="icon-btn" href="#/" aria-label="Back to the book">${ICON.back}</a>` : ''}
      <div class="title">Books</div>
    </header>
    ${inst ? installCardHTML('Open a book') : ''}
    <div class="card">
      <h2>${inst ? '2. Choose a book' : 'Choose a book'}</h2>
      <div class="books">${rows}</div>
      <p id="shelf-status" class="small muted" aria-live="polite"></p>
    </div>
    <div class="card">
      <h2>Your own book file</h2>
      <p class="small muted">Load a book file (.json) from the Files app. It is saved on this phone only.</p>
      <button class="btn block" id="load-btn" type="button">Choose book file</button>
      <input type="file" id="book-file" hidden>
      <p id="load-status" class="small muted" aria-live="polite"></p>
    </div>
    <p class="small muted">Each book keeps its own progress and saved words. Version ${APP_VERSION}</p>`;
  app.querySelectorAll('[data-book]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.book === state.bookId && state.meta) { goHome(); return; }
      openShelfBook(b.dataset.book, $('#shelf-status'));
    };
  });
  $('#load-btn').onclick = () => $('#book-file').click();
  $('#book-file').onchange = (e) => handleBookFile(e.target.files[0], $('#load-status'));
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ library
function statusIcon(p) {
  if (p.status === 'done') {
    return '<svg class="status" viewBox="0 0 26 26" role="img" aria-label="finished"><circle cx="13" cy="13" r="11" fill="var(--accent)"/><path d="M8 13.5l3.2 3.2L18.5 9.5" fill="none" stroke="var(--accent-text)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  const pct = Math.max(0, Math.min(1, p.pct || 0));
  const C = 2 * Math.PI * 10;
  const arc = pct > 0 ? `<circle cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(pct * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 13 13)"/>` : '';
  return `<svg class="status" viewBox="0 0 26 26" role="img" aria-label="${Math.round(pct * 100)} percent read"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--line)" stroke-width="3"/>${arc}</svg>`;
}

function continueTarget() {
  const reading = [...state.progress.values()].filter((p) => p.status === 'reading').sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  if (reading.length) return reading[0].num;
  const next = state.manifest.chapters.find((c) => progressOf(c.num).status !== 'done');
  return next ? next.num : null;
}

function renderLibrary() {
  const man = state.manifest;
  const chs = man.chapters;
  const done = chs.filter((c) => progressOf(c.num).status === 'done').length;
  const words = [...state.words.values()];
  const known = words.filter((w) => w.status === 'known').length;
  const minutes = Math.round([...state.progress.values()].reduce((s, p) => s + (p.seconds || 0), 0) / 60);
  const contNum = continueTarget();
  const cont = contNum ? chs.find((c) => c.num === contNum) : null;
  const contP = cont ? progressOf(cont.num) : null;
  const lastBackup = state.prefs.lastBackup ? new Date(state.prefs.lastBackup) : null;
  const backupDue = minutes >= 20 && (!lastBackup || (Date.now() - lastBackup.getTime()) > 30 * 864e5);

  const parts = man.parts.map((part) => {
    const rows = part.chapters.map((n) => {
      const c = chs.find((x) => x.num === n);
      if (!c) return '';
      const p = progressOf(n);
      return `<button class="ch-row" type="button" data-open="${n}">
        <span class="ch-num">${n}</span>
        <span class="ch-title"><b>${esc(c.title)}</b><span>${c.reading_minutes} min${p.status === 'reading' ? ` · ${Math.round((p.pct || 0) * 100)} %` : ''}</span></span>
        ${statusIcon(p)}
      </button>`;
    }).join('');
    return `<div class="part-head"><h2>${esc(part.label)}</h2><span class="badge lv-${part.level}">${part.level}</span><span class="muted">${esc(part.title || '')}</span></div><div class="chapters">${rows}</div>`;
  }).join('');

  app.innerHTML = `
    <header class="topbar">
      ${state.shelf.length ? `<a class="icon-btn" href="#/books" aria-label="All books">${ICON.books}</a>` : ''}
      <div class="title">${esc(man.book?.title || 'Alice im Wunderland')}</div>
      <a class="icon-btn" href="#/words" aria-label="Saved words">${ICON.words}</a>
      <a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>
    </header>
    <div class="stats">
      <div class="stat"><b>${done}</b><span>of ${chs.length} chapters</span></div>
      <div class="stat"><b>${known}</b><span>known words</span></div>
      <div class="stat"><b>${minutes}</b><span>minutes read</span></div>
      <div class="stat"><b>${state.streak}</b><span>day streak</span></div>
    </div>
    ${cont ? `
    <div class="card">
      <div class="continue">
        <div class="grow">
          <div class="k">${contP.status === 'reading' ? 'Continue reading' : 'Start'} · Kapitel ${cont.num} · ${cont.level}</div>
          <div class="t">${esc(cont.title)}</div>
          <div class="bar"><i style="width:${Math.round((contP.pct || 0) * 100)}%"></i></div>
        </div>
        <a class="btn primary" href="#/read/${cont.num}">${contP.status === 'reading' ? 'Continue' : 'Start'}</a>
      </div>
    </div>` : '<div class="card"><h2>You finished the book!</h2><p>Herzlichen Glückwunsch.</p></div>'}
    ${backupDue ? `<div class="note">Your progress lives only on this phone. <a href="#/settings">Save a backup</a> to Files or iCloud Drive.</div>` : ''}
    ${parts}`;
  app.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { location.hash = `#/read/${b.dataset.open}`; }; });
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ reader
function legendHTML() {
  const p = state.prefs;
  const items = [];
  if (p.markNew) items.push('<span class="s1">new word</span>');
  if (p.markStory) items.push('<span class="s2">story word</span>');
  if (p.markSaved) items.push('<span class="s3">saved word</span>');
  items.push('<span>Tap any word</span>');
  return `<div class="legend">${items.join('')}</div>`;
}

function chapterHTML(ch) {
  const prefs = state.prefs;
  const sents = ch.sentences;
  const newFirst = new Set((ch.new_vocab || []).filter((e) => e.first && !e.deferred).map((e) => `${e.first[0]}:${e.first[1]}`));
  const tokens = (si) => sents[si].tokens.map((t, ti) => {
    const [surf, lemma, pos, level, ws, , story] = t;
    if (pos === 'PUNCT' || level === 'PUNCT') return esc(surf) + ws;
    let cls = 'w';
    const st = wordStatus(lemma);
    if (prefs.markNew && newFirst.has(`${si}:${ti}`) && st !== 'known') cls += ' nw';
    if (prefs.markStory && story) cls += ' sw';
    if (prefs.markSaved && st === 'learning') cls += ' saved';
    return `<span class="${cls}" data-s="${si}" data-t="${ti}">${esc(surf)}</span>${ws}`;
  }).join('');
  const run = (a, z) => { let h = ''; for (let s = a; s < z; s += 1) h += `<span class="sent" data-si="${s}">${tokens(s)}</span>`; return h; };
  return ch.blocks.map((b, bi) => {
    if (b.type === 'p') return `<p data-b="${bi}">${run(b.range[0], b.range[1])}</p>`;
    if (b.type === 'sign') {
      const lines = b.lines.map(([a, z]) => (a === null ? '<div>&nbsp;</div>' : `<div>${run(a, z)}</div>`)).join('');
      return `<div class="sign" data-b="${bi}">${lines}</div>`;
    }
    if (b.type === 'break') return `<div class="scene" data-b="${bi}" role="separator" aria-label="scene break">* * *</div>`;
    return '';
  }).join('');
}

function endCardHTML(ch, info) {
  const p = progressOf(info.num);
  const g = info.grammar_new || [];
  const notes = ch.notes?.grammar || [];
  const story = ch.notes?.story_words || [];
  const nv = (ch.new_vocab || []).filter((e) => !e.deferred && e.first);
  const next = state.manifest.chapters.find((c) => c.num === info.num + 1);
  return `<section class="card end-card" data-b="end">
    <h2>Ende von Kapitel ${info.num}</h2>
    ${g.length ? `<h3>New grammar in this chapter</h3><div class="chips">${g.map((x) => `<span class="chip hl">${esc(x.de)}</span>`).join('')}</div>` : '<p class="muted">This chapter repeats the grammar of the part.</p>'}
    ${notes.length ? `<div class="grammar-notes">${notes.map((n) => `<p>${mdInline(n)}</p>`).join('')}</div>` : ''}
    ${story.length ? `<h3>Story words</h3><table class="glossary">${story.map((s) => `<tr><td>${esc(s.word)}</td><td>${esc(s.gloss || '')}</td></tr>`).join('')}</table>` : ''}
    ${nv.length ? `<h3>New words in this chapter (${nv.length})</h3><p class="small muted">Tap a word to find it in the text.</p><div class="chips">${nv.map((e) => `<button class="chip" type="button" data-jump="${e.first[0]}:${e.first[1]}">${esc(cleanEntry(e.entry))}</button>`).join('')}</div>` : ''}
    <div class="btn-row">
      <button class="btn primary" id="finish" type="button">${p.status === 'done' ? 'Finished ✓' : 'Mark as finished'}</button>
      ${next ? `<a class="btn" href="#/read/${next.num}">Next: Kapitel ${next.num}</a>` : '<a class="btn" href="#/">Back to the book</a>'}
    </div>
  </section>`;
}

async function renderReader(num) {
  const info = state.manifest.chapters.find((c) => c.num === num);
  if (!info) { location.hash = '#/'; return; }
  const ch = await db.get('chapters', num);
  if (!ch) {
    app.innerHTML = `<div class="card"><h2>Chapter missing</h2><p>Load the book file again in Settings.</p><a class="btn" href="#/settings">Settings</a></div>`;
    return;
  }
  const part = partOf(info.part);
  const p = progressOf(num);
  state.reader = {
    num, ch, info, activeEl: null, visible: new Set(), lastActive: Date.now(), pending: 0,
    storyGloss: new Map((ch.notes?.story_words || []).map((s) => [s.lemma, s])),
    blocks: ch.blocks.length,
  };
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back to the book">${ICON.back}</a>
      <div class="title">Kapitel ${num}</div>
      <button class="icon-btn" id="aa" type="button" aria-label="Text settings">Aa</button>
    </header>
    <div class="reader-head">
      <div class="kicker">${esc(part?.label || '')} · ${esc(part?.title || '')}</div>
      <h1>${esc(info.title)}</h1>
      <div class="meta"><span class="badge lv-${info.level}">${info.level}</span><span>${info.reading_minutes} min</span><span>${info.words.toLocaleString('en')} words</span></div>
    </div>
    <div class="mode-row">${segHTML('seg-mode', [['read', 'Read'], ['listen', 'Listen']], state.prefs.mode)}</div>
    ${legendHTML()}
    <article class="text" id="text" lang="de">${chapterHTML(ch)}</article>
    ${endCardHTML(ch, info)}
    <div class="player" id="player" hidden>
      <button class="icon-btn" type="button" id="pl-prev" aria-label="Previous sentence">${ICON.prev}</button>
      <button class="play-btn" type="button" id="pl-play" aria-label="Play">${ICON.play}</button>
      <button class="icon-btn" type="button" id="pl-next" aria-label="Next sentence">${ICON.next}</button>
      <div class="pl-info"><span id="pl-pos"></span><button type="button" id="pl-rate" class="pl-rate"></button></div>
    </div>`;
  state.reader.order = sentenceOrder(ch);
  app.querySelectorAll('#seg-mode button').forEach((b) => { b.onclick = () => setMode(b.dataset.v); });
  $('#pl-play').onclick = togglePlay;
  $('#pl-prev').onclick = () => stepSentence(-1);
  $('#pl-next').onclick = () => stepSentence(1);
  $('#pl-rate').onclick = cycleRate;
  setMode(state.prefs.mode, true);

  $('#text').addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) openWordSheet(Number(w.dataset.s), Number(w.dataset.t), w);
  });
  $('#aa').onclick = openTextSettings;
  $('#finish').onclick = () => finishChapter(num);
  app.querySelectorAll('[data-jump]').forEach((b) => {
    b.onclick = () => {
      const [s, t] = b.dataset.jump.split(':');
      const el = app.querySelector(`.w[data-s="${s}"][data-t="${t}"]`);
      if (!el) return;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3, behavior: 'smooth' });
      setTimeout(() => openWordSheet(Number(s), Number(t), el), 350);
    };
  });

  if (p.status !== 'done' && p.status !== 'reading') {
    await saveProgress({ ...p, status: 'reading', updated: new Date().toISOString() });
  }
  const restore = () => {
    if (p.pos > 0) {
      const el = app.querySelector(`[data-b="${p.pos}"]`);
      if (el) { window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76); return; }
    }
    window.scrollTo(0, 0);
  };
  requestAnimationFrame(() => requestAnimationFrame(restore));
  startReading();
}

async function saveProgress(p) {
  state.progress.set(p.num, p);
  await db.put('progress', p);
}

function startReading() {
  const r = state.reader;
  if (!r) return;
  r.observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const b = en.target.dataset.b;
      if (en.isIntersecting) r.visible.add(b); else r.visible.delete(b);
    }
    r.lastActive = Date.now();
    schedulePositionSave();
  }, { rootMargin: '-70px 0px -35% 0px' });
  app.querySelectorAll('[data-b]').forEach((el) => r.observer.observe(el));
  r.onActivity = () => { r.lastActive = Date.now(); };
  window.addEventListener('scroll', r.onActivity, { passive: true });
  window.addEventListener('touchstart', r.onActivity, { passive: true });
  r.timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - r.lastActive > 120000) return;
    r.pending += 5;
    if (r.pending >= 30) flushTime();
  }, 5000);
  r.onHide = () => { if (document.visibilityState === 'hidden') { pauseListening(); flushTime(); flushPosition(); } };
  document.addEventListener('visibilitychange', r.onHide);
}

function stopReading() {
  const r = state.reader;
  if (!r) return;
  clearInterval(r.timer);
  clearTimeout(r.posTimer);
  if (r.observer) r.observer.disconnect();
  window.removeEventListener('scroll', r.onActivity);
  window.removeEventListener('touchstart', r.onActivity);
  document.removeEventListener('visibilitychange', r.onHide);
  flushTime();
  flushPosition();
  state.reader = null;
}

function currentBlock() {
  const r = state.reader;
  if (!r || !r.visible.size) return null;
  if (r.visible.has('end')) return 'end';
  return Math.min(...[...r.visible].filter((x) => x !== 'end').map(Number));
}

function schedulePositionSave() {
  const r = state.reader;
  if (!r) return;
  clearTimeout(r.posTimer);
  r.posTimer = setTimeout(flushPosition, 1200);
}

function flushPosition() {
  const r = state.reader;
  if (!r) return;
  const b = currentBlock();
  if (b === null) return;
  const p = progressOf(r.num);
  const pos = b === 'end' ? Math.max(0, r.blocks - 1) : b;
  const pct = b === 'end' ? 1 : Math.min(0.99, (pos + 1) / r.blocks);
  if (pos === p.pos && Math.abs((p.pct || 0) - pct) < 0.005) return;
  saveProgress({ ...p, pos, pct: p.status === 'done' ? 1 : pct, status: p.status === 'done' ? 'done' : 'reading', updated: new Date().toISOString() });
}

async function flushTime() {
  const r = state.reader;
  if (!r || !r.pending) return;
  const secs = r.pending;
  r.pending = 0;
  const p = progressOf(r.num);
  await saveProgress({ ...p, seconds: (p.seconds || 0) + secs, updated: new Date().toISOString() });
  const d = (await db.get('daily', today())) || { date: today(), seconds: 0 };
  d.seconds += secs;
  await db.put('daily', d);
  await computeStreak();
}

async function computeStreak() {
  const days = new Map((await db.getAll('daily')).map((d) => [d.date, d.seconds]));
  const d = new Date();
  if (!((days.get(fmtDate(d)) || 0) >= 60)) d.setDate(d.getDate() - 1);
  let n = 0;
  while ((days.get(fmtDate(d)) || 0) >= 60) { n += 1; d.setDate(d.getDate() - 1); }
  state.streak = n;
}

async function finishChapter(num) {
  const p = progressOf(num);
  await saveProgress({ ...p, status: 'done', pct: 1, updated: new Date().toISOString() });
  const btn = $('#finish');
  if (btn) btn.textContent = 'Finished ✓';
  toast(`Kapitel ${num} finished. Super!`);
}

// ------------------------------------------------------------------ word sheet
function openSheet(html, label) {
  sheet.innerHTML = `<div class="grab"></div>${html}`;
  sheet.setAttribute('aria-label', label || 'Details');
  sheet.hidden = false;
  backdrop.hidden = false;
}

function closeSheet() {
  if (sheet.hidden) return;
  sheet.hidden = true;
  backdrop.hidden = true;
  const r = state.reader;
  if (r && r.activeEl) { r.activeEl.classList.remove('on'); r.activeEl = null; }
  if (state.listen.resumeOnClose) {
    state.listen.resumeOnClose = false;
    if (r && state.prefs.mode === 'listen') playFrom(state.listen.idx);
  }
}

function sentenceText(sentence, boldIndex = -1) {
  return sentence.tokens.map((t, i) => (i === boldIndex ? `<b>${esc(t[0])}</b>${t[4]}` : esc(t[0]) + t[4])).join('');
}

function plainSentence(sentence) {
  return sentence.tokens.map((t) => t[0] + t[4]).join('').trim();
}

function grammarChips(grammar, info) {
  const codes = Object.keys(grammar || {});
  const newCodes = new Set((info.grammar_new || []).map((g) => g.code));
  const shown = codes.filter((c) => newCodes.has(c) || !COMMON_GRAMMAR.has(c)).slice(0, 5);
  if (!shown.length) return '';
  const gc = state.manifest.grammar_codes || {};
  return `<div class="chips">${shown.map((c) => `<span class="chip${newCodes.has(c) ? ' hl' : ''}">${esc(gc[c]?.de || c)}</span>`).join('')}</div>`;
}

function openWordSheet(si, ti, el, quiet = false) {
  const r = state.reader;
  if (!r) return;
  const sentence = r.ch.sentences[si];
  const tok = sentence.tokens[ti];
  const [surf, lemma, pos, level, , , story] = tok;
  const listening = state.prefs.mode === 'listen';
  if (listening && state.listen.playing) { pauseListening(); state.listen.resumeOnClose = true; }
  if (r.activeEl) r.activeEl.classList.remove('on');
  el.classList.add('on');
  r.activeEl = el;
  const lx = state.lexicon[lemma] || null;
  const gender = lx ? lx[2] : null;
  const plural = lx ? lx[3] : null;
  const firstCh = lx ? lx[4] : null;
  const art = pos === 'NOUN' ? articleFor(gender) : '';
  const sg = r.storyGloss.get(lemma) || r.storyGloss.get(surf);
  const gloss = state.glosses[lemma] || (sg && sg.gloss) || null;
  const st = wordStatus(lemma);
  let lemmaLine = '';
  if (pos === 'NOUN') lemmaLine = `${art ? `${esc(art)} ` : ''}<b>${esc(lemma)}</b>${plural ? `, Plural: die ${esc(plural)}` : ''}`;
  else if (lemma && lemma.toLowerCase() !== surf.toLowerCase()) lemmaLine = `from <b>${esc(lemma)}</b>`;
  const where = [];
  if (story) where.push('story word');
  if (firstCh && firstCh === r.num) where.push('new in this chapter');
  else if (firstCh) where.push(`first in Kapitel ${firstCh}`);
  const speech = 'speechSynthesis' in window;
  openSheet(`
    <div class="word" lang="de">${esc(surf)}</div>
    ${lemmaLine ? `<div class="lemma" lang="de">${lemmaLine}</div>` : ''}
    <div class="info"><span class="badge lv-${esc(level)}">${esc(LEVEL_LABEL[level] || level)}</span><span>${esc(POS_LABEL[pos] || 'word')}</span>${where.length ? `<span>· ${esc(where.join(' · '))}</span>` : ''}</div>
    <div class="gloss${gloss ? '' : ' none'}">${gloss ? esc(gloss) : (level === 'NAME' ? 'A name.' : (level === 'NUM' ? 'A number.' : 'No translation yet.'))}</div>
    <div class="sentence" lang="de">${sentenceText(sentence, ti)}</div>
    ${grammarChips(sentence.grammar, r.info)}
    <div class="btn-row">
      ${speech ? '<button class="btn" type="button" id="say-word">▶ Word</button><button class="btn" type="button" id="say-sent">▶ Sentence</button>' : ''}
    </div>
    ${speech && listening ? '<div class="btn-row"><button class="btn primary" type="button" id="listen-here">Listen from this sentence</button></div>' : ''}
    <div class="btn-row">
      <button class="btn${st === 'learning' ? ' on' : ''}" type="button" id="w-save">${st === 'learning' ? '★ Saved' : '☆ Save word'}</button>
      <button class="btn${st === 'known' ? ' on' : ''}" type="button" id="w-known">${st === 'known' ? '✓ Known' : 'I know it'}</button>
    </div>`, `Word ${surf}`);
  if (speech) {
    $('#say-word').onclick = () => speak(surf);
    $('#say-sent').onclick = () => speak(plainSentence(sentence), null, state.prefs.rate);
    if (listening) {
      $('#listen-here').onclick = () => {
        const idx = r.order.findIndex((o) => o.si === si);
        state.listen.resumeOnClose = false;
        closeSheet();
        playFrom(idx < 0 ? 0 : idx);
      };
    }
  }
  if (speech && listening && !quiet) speak(surf);
  const entry = { lemma, surface: surf, chapter: r.num, sentence: plainSentence(sentence), gloss: gloss || '', level, pos, article: art };
  $('#w-save').onclick = () => setWordStatus(entry, st === 'learning' ? null : 'learning').then(() => openWordSheet(si, ti, el, true));
  $('#w-known').onclick = () => setWordStatus(entry, st === 'known' ? null : 'known').then(() => openWordSheet(si, ti, el, true));
}

async function setWordStatus(entry, status) {
  if (!status) {
    state.words.delete(entry.lemma);
    await db.del('words', entry.lemma);
  } else {
    const prev = state.words.get(entry.lemma);
    const rec = { ...(prev || {}), ...entry, status, added: prev?.added || new Date().toISOString(), changed: new Date().toISOString() };
    state.words.set(entry.lemma, rec);
    await db.put('words', rec);
  }
  refreshWordMarks(entry.lemma);
}

function refreshWordMarks(lemma) {
  const r = state.reader;
  if (!r) return;
  const st = wordStatus(lemma);
  app.querySelectorAll('#text .w').forEach((el) => {
    const t = r.ch.sentences[Number(el.dataset.s)].tokens[Number(el.dataset.t)];
    if (t[1] !== lemma) return;
    el.classList.toggle('saved', state.prefs.markSaved && st === 'learning');
    if (st === 'known') el.classList.remove('nw');
  });
}

// ------------------------------------------------------------------ listen mode
// Sentence order follows the blocks (paragraphs and signs), so the voice reads the page top to bottom.
function sentenceOrder(ch) {
  const out = [];
  ch.blocks.forEach((b, bi) => {
    const ranges = b.type === 'p' ? [b.range] : (b.type === 'sign' ? b.lines.filter(([a]) => a !== null) : []);
    for (const [a, z] of ranges) {
      for (let si = a; si < z; si += 1) {
        if (plainSentence(ch.sentences[si]).replace(/[\s\p{P}]/gu, '')) out.push({ si, b: bi });
      }
    }
  });
  return out;
}

function setMode(mode, initial = false) {
  const r = state.reader;
  if (!r) return;
  if (mode === 'listen' && !('speechSynthesis' in window)) { toast('Speech is not available on this device.'); mode = 'read'; }
  if (state.prefs.mode !== mode) { state.prefs.mode = mode; savePrefs(); }
  app.querySelectorAll('#seg-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
  const listen = mode === 'listen';
  $('#player').hidden = !listen;
  document.body.classList.toggle('listening', listen);
  if (!listen) { stopListening(); return; }
  updatePlayer();
  if (!initial && state.listen.idx < 0) toast('Tap ▶ to start. Tap any word to see its meaning.');
}

function startIndex() {
  const r = state.reader;
  const b = currentBlock();
  if (b === null || b === 'end') return 0;
  const i = r.order.findIndex((o) => o.b >= b);
  return i < 0 ? 0 : i;
}

function playFrom(idx) {
  const r = state.reader;
  const L = state.listen;
  if (!r) return;
  if (idx < 0 || idx >= r.order.length) {
    stopListening();
    if (idx >= r.order.length) {
      toast(`Ende von Kapitel ${r.num}.`);
      const end = app.querySelector('.end-card');
      if (end) window.scrollTo({ top: end.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
    }
    return;
  }
  L.idx = idx;
  L.playing = true;
  clearTimeout(L.gap);
  const { si } = r.order[idx];
  markSentence(si);
  updatePlayer();
  r.lastActive = Date.now(); // listening counts as reading time
  speak(plainSentence(r.ch.sentences[si]), () => {
    L.gap = setTimeout(() => { if (L.playing && state.reader === r) playFrom(L.idx + 1); }, 350);
  }, state.prefs.rate);
}

function pauseListening() {
  const L = state.listen;
  if (!L.playing) return;
  L.playing = false;
  silence();
  updatePlayer();
}

function stopListening() {
  const L = state.listen;
  L.playing = false;
  L.idx = -1;
  L.resumeOnClose = false;
  silence();
  app.querySelectorAll('.sent.reading').forEach((el) => el.classList.remove('reading'));
  if (state.reader) updatePlayer();
}

function togglePlay() {
  const L = state.listen;
  if (L.playing) { pauseListening(); return; }
  playFrom(L.idx >= 0 ? L.idx : startIndex());
}

function stepSentence(d) {
  const r = state.reader;
  const L = state.listen;
  const base = L.idx >= 0 ? L.idx : startIndex();
  const idx = Math.max(0, Math.min(r.order.length - 1, base + d));
  if (L.playing) { playFrom(idx); return; }
  L.idx = idx;
  markSentence(r.order[idx].si);
  updatePlayer();
}

function cycleRate() {
  const i = RATES.findIndex(([v]) => v === state.prefs.rate);
  state.prefs.rate = RATES[(i + 1) % RATES.length][0];
  savePrefs();
  updatePlayer();
  if (state.listen.playing) playFrom(state.listen.idx);
}

function markSentence(si) {
  app.querySelectorAll('.sent.reading').forEach((el) => el.classList.remove('reading'));
  const el = app.querySelector(`.sent[data-si="${si}"]`);
  if (!el) return;
  el.classList.add('reading');
  const rect = el.getBoundingClientRect();
  if (rect.top < 90 || rect.bottom > window.innerHeight - 150) {
    window.scrollTo({ top: rect.top + window.scrollY - window.innerHeight / 3, behavior: 'smooth' });
  }
}

function updatePlayer() {
  const r = state.reader;
  const L = state.listen;
  const play = $('#pl-play');
  if (!r || !play) return;
  play.innerHTML = L.playing ? ICON.pause : ICON.play;
  play.setAttribute('aria-label', L.playing ? 'Pause' : 'Play');
  $('#pl-pos').textContent = L.idx >= 0 ? `Satz ${L.idx + 1} / ${r.order.length}` : `${r.order.length} Sätze`;
  const rate = RATES.find(([v]) => v === state.prefs.rate) || RATES[1];
  $('#pl-rate').textContent = rate[1];
}

// ------------------------------------------------------------------ text settings (in the reader)
function segHTML(id, options, value) {
  return `<div class="seg" id="${id}">${options.map(([v, label]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

function switchHTML(id, checked, label) {
  return `<div class="set-row"><label for="${id}">${label}</label><span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span></div>`;
}

const SIZES = [[17, 'S'], [19, 'M'], [21, 'L'], [24, 'XL']];
const THEMES = [['auto', 'Auto'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']];

function bindPrefControls(root, onChange) {
  root.querySelectorAll('#seg-size button').forEach((b) => {
    b.onclick = async () => { state.prefs.fontSize = Number(b.dataset.v); applyPrefs(); await savePrefs(); onChange('size'); };
  });
  root.querySelectorAll('#seg-theme button').forEach((b) => {
    b.onclick = async () => { state.prefs.theme = b.dataset.v; applyPrefs(); await savePrefs(); onChange('theme'); };
  });
  const vs = root.querySelector('#voice');
  if (vs) vs.onchange = async () => { state.prefs.voice = vs.value; await savePrefs(); speak('Hallo, ich lese dir vor.', null, state.prefs.rate); };
  for (const [id, key] of [['t-new', 'markNew'], ['t-story', 'markStory'], ['t-saved', 'markSaved']]) {
    const el = root.querySelector(`#${id}`);
    if (el) el.onchange = async () => { state.prefs[key] = el.checked; await savePrefs(); onChange('marks'); };
  }
}

function prefControlsHTML() {
  const p = state.prefs;
  return `
    <div class="set-row"><span>Text size</span>${segHTML('seg-size', SIZES, p.fontSize)}</div>
    <div class="set-row"><span>Theme</span>${segHTML('seg-theme', THEMES, p.theme)}</div>
    ${switchHTML('t-new', p.markNew, 'Mark the chapter\'s new words')}
    ${switchHTML('t-story', p.markStory, 'Mark story words')}
    ${switchHTML('t-saved', p.markSaved, 'Highlight saved words')}
    ${state.voices.length > 1 ? `<div class="set-row"><label for="voice">Voice</label><select id="voice" class="select">${state.voices.map((v) => `<option value="${esc(v.voiceURI)}"${pickVoice() === v ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>` : ''}`;
}

function openTextSettings() {
  openSheet(`<h2 style="margin:4px 0 8px">Text</h2>${prefControlsHTML()}`, 'Text settings');
  bindPrefControls(sheet, (what) => {
    if (what === 'marks' && state.reader) {
      const r = state.reader;
      const keep = window.scrollY;
      $('#text').innerHTML = chapterHTML(r.ch);
      if (state.listen.idx >= 0) app.querySelector(`.sent[data-si="${r.order[state.listen.idx].si}"]`)?.classList.add('reading');
      const lg = app.querySelector('.legend');
      if (lg) lg.outerHTML = legendHTML();
      window.scrollTo(0, keep);
      r.observer.disconnect();
      app.querySelectorAll('[data-b]').forEach((el) => r.observer.observe(el));
    }
    openTextSettings();
  });
}

// ------------------------------------------------------------------ saved words
function renderWords(tab) {
  const current = tab || (location.hash.includes('known') ? 'known' : 'learning');
  const list = [...state.words.values()].filter((w) => w.status === current).sort((a, b) => String(b.changed || b.added).localeCompare(String(a.changed || a.added)));
  const nLearning = [...state.words.values()].filter((w) => w.status === 'learning').length;
  const nKnown = [...state.words.values()].filter((w) => w.status === 'known').length;
  const rows = list.map((w) => `
    <div class="list-row">
      <div class="grow"><b lang="de">${w.article ? `${esc(w.article)} ` : ''}${esc(w.lemma)}</b><span>${esc(w.gloss || w.sentence || '')}</span></div>
      <span class="badge lv-${esc(w.level)}">${esc(LEVEL_LABEL[w.level] || w.level || '')}</span>
      <button class="icon-btn" type="button" data-del="${esc(w.lemma)}" aria-label="Remove ${esc(w.lemma)}">✕</button>
    </div>`).join('');
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back to the book">${ICON.back}</a>
      <div class="title">Words</div>
    </header>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="learning" class="${current === 'learning' ? 'on' : ''}">Saved (${nLearning})</button>
      <button type="button" role="tab" data-tab="known" class="${current === 'known' ? 'on' : ''}">Known (${nKnown})</button>
    </div>
    <div class="list">${rows || `<div class="empty">${current === 'learning' ? 'No saved words yet. Tap a word while reading and choose “Save word”.' : 'No known words yet. Tap a word and choose “I know it”.'}</div>`}</div>
    <p class="small muted">Flashcard training with spaced repetition comes in the next version.</p>`;
  app.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => renderWords(b.dataset.tab); });
  app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      state.words.delete(b.dataset.del);
      await db.del('words', b.dataset.del);
      renderWords(current);
    };
  });
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ settings, backup, restore
async function storageInfo() {
  if (!navigator.storage) return 'not available';
  try {
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const mb = est && est.usage ? `${(est.usage / 1048576).toFixed(1)} MB used` : '';
    return `${persisted ? 'Protected (persistent storage)' : 'Not protected yet'}${mb ? ` · ${mb}` : ''}`;
  } catch (e) { return 'unknown'; }
}

async function renderSettings() {
  const lb = state.prefs.lastBackup ? new Date(state.prefs.lastBackup).toLocaleDateString() : 'never';
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back to the book">${ICON.back}</a>
      <div class="title">Settings</div>
    </header>
    <div class="card"><h2>Reading</h2>${prefControlsHTML()}</div>
    <div class="card">
      <h2>Your progress</h2>
      <p class="small">Progress is saved only on this phone. A backup file keeps it safe if the phone is reset or replaced.</p>
      <p class="small muted">Last backup: ${esc(lb)}<br>Storage: <span id="st-info">checking …</span></p>
      <div class="btn-row">
        <button class="btn primary" id="backup" type="button">Save backup</button>
        <button class="btn" id="restore" type="button">Restore backup</button>
      </div>
      <input type="file" id="restore-file" hidden>
      <p id="restore-status" class="small" aria-live="polite"></p>
    </div>
    <div class="card">
      <h2>Book</h2>
      <p class="small muted">${esc(state.manifest.book?.title || '')}, ${state.manifest.chapters.length} chapters. Loaded ${state.meta.loadedAt ? esc(new Date(state.meta.loadedAt).toLocaleDateString()) : ''}.</p>
      ${state.shelf.length ? '<a class="btn block" href="#/books">Choose another book</a>' : ''}
      <button class="btn block" id="reload-book" type="button" style="margin-top:10px">Load a book file</button>
      <input type="file" id="book-file" hidden>
      <p id="load-status" class="small muted" aria-live="polite"></p>
    </div>
    <div class="card">
      <h2>Start over</h2>
      <p class="small">Deletes reading progress and saved words for this book on this phone. The book stays.</p>
      <button class="btn danger block" id="reset" type="button">Delete my progress</button>
    </div>
    <p class="small muted">App version ${APP_VERSION}. Works offline after the first start.</p>`;
  bindPrefControls(app, () => renderSettings());
  $('#st-info').textContent = await storageInfo();
  $('#backup').onclick = exportBackup;
  $('#restore').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = (e) => importBackup(e.target.files[0], $('#restore-status'));
  $('#reload-book').onclick = () => $('#book-file').click();
  $('#book-file').onchange = (e) => handleBookFile(e.target.files[0], $('#load-status'));
  let armed = false;
  $('#reset').onclick = async () => {
    if (!armed) { armed = true; $('#reset').textContent = 'Tap again to delete everything'; setTimeout(() => { armed = false; const b = $('#reset'); if (b) b.textContent = 'Delete my progress'; }, 4000); return; }
    await db.clear('progress'); await db.clear('words'); await db.clear('daily');
    state.progress.clear(); state.words.clear(); state.streak = 0;
    toast('Progress deleted.');
    location.hash = '#/';
  };
}

async function exportBackup() {
  const data = {
    format: 'alice-progress', version: 1, app: APP_VERSION, exported: new Date().toISOString(),
    progress: await db.getAll('progress'), words: await db.getAll('words'), daily: await db.getAll('daily'),
    prefs: state.prefs,
  };
  const name = `alice-backup-${today()}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  let shared = false;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Alice backup' });
      shared = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  if (!shared) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  state.prefs.lastBackup = new Date().toISOString();
  await savePrefs();
  toast('Backup saved.');
  if (location.hash.startsWith('#/settings')) renderSettings();
}

async function importBackup(file, statusEl) {
  if (!file) return;
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('This is not a backup file.'); }
    if (!data || data.format !== 'alice-progress') throw new Error('This is not an Alice backup file.');
    await db.clear('progress'); await db.putMany('progress', data.progress || []);
    await db.clear('words'); await db.putMany('words', data.words || []);
    await db.clear('daily'); await db.putMany('daily', data.daily || []);
    if (data.prefs) { state.prefs = { ...DEFAULT_PREFS, ...data.prefs, persistAsked: state.prefs.persistAsked }; await savePrefs(); applyPrefs(); }
    state.progress = new Map((data.progress || []).map((p) => [p.num, p]));
    state.words = new Map((data.words || []).map((w) => [w.lemma, w]));
    await computeStreak();
    statusEl.textContent = `Restored: ${state.progress.size} chapters, ${state.words.size} words.`;
    toast('Backup restored.');
  } catch (e) {
    statusEl.innerHTML = `<span class="error">${esc(e.message || e)}</span>`;
  }
}

init();
