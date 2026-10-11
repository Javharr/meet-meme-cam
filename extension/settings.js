/*
 * settings.js — настройки Meme Cam, одни на всех
 * ---------------------------------------------------------------------------
 * Подключается в трёх местах: мост (detector.js), детектор (detector.html)
 * и popup. Хранится в chrome.storage.sync — едет за твоим профилем Chrome.
 */
(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,            // главный выключатель
    memesFace: true,          // мемы от мимики
    memesHands: true,         // мемы от жестов рукой
    memes: {},                // key → false, если конкретный мем выключен
    vanish: true,             // исчезновение по двойному хлопку
    dustSize: 4,              // размер частицы, px при ширине кадра 1280
    clapSensitivity: 'normal',// low | normal | high
    previewMirror: true,      // зеркало только в твоём окошке
    hud: false,               // отладка поверх картинки
    engine: 'auto',           // 'auto' | 'canvas' — запасной движок камеры
    customGestures: true,     // свои жесты вкл/выкл
    lasers: true,             // лазеры из глаз: нахмурься — и пошли
    laserColor: 'red',        // red | green | blue
    captions: {},             // key → своя подпись мема ('' — без плашки)
    th: {},                   // пороги мимики из калибровки
  });

  const MEMES = [
    { key: 'shock',   emoji: '😱', label: 'Шок',    kind: 'face', how: 'открой рот и глаза' },
    { key: 'smile',   emoji: '😂', label: 'Ржу',    kind: 'face', how: 'широко улыбнись' },
    { key: 'hmm',     emoji: '🤨', label: 'Хм',     kind: 'face', how: 'подними брови' },
    { key: 'like',    emoji: '👍', label: 'Лайк',   kind: 'hand', how: 'палец вверх' },
    { key: 'dislike', emoji: '👎', label: 'Не-а',   kind: 'hand', how: 'палец вниз' },
    { key: 'peace',   emoji: '✌️', label: 'Мир',    kind: 'hand', how: 'знак V' },
    { key: 'fire',    emoji: '🔥', label: 'Огонь',  kind: 'hand', how: 'кулак' },
    { key: 'wave',    emoji: '👋', label: 'Привет', kind: 'hand', how: 'открытая ладонь' },
    { key: 'idea',    emoji: '💡', label: 'Идея',   kind: 'hand', how: 'палец вверх, указательный' },
    { key: 'love',    emoji: '🤟', label: 'Лав',    kind: 'hand', how: '🤟' },
  ];

  // вложенные объекты — копируем, чтобы правка одного ключа не затирала соседей
  const NESTED = ['memes', 'captions', 'th'];

  function merge(saved) {
    const s = Object.assign({}, DEFAULTS, saved || {});
    for (const k of NESTED) s[k] = Object.assign({}, (saved && saved[k]) || {});
    return s;
  }

  async function load() {
    try {
      const r = await chrome.storage.sync.get('settings');
      return merge(r.settings);
    } catch (_) {
      return merge(null);
    }
  }

  async function save(patch) {
    const cur = await load();
    const next = Object.assign({}, cur, patch);
    for (const k of NESTED) if (patch[k] && k !== 'th') next[k] = Object.assign({}, cur[k], patch[k]);
    await chrome.storage.sync.set({ settings: merge(next) });
    return merge(next);
  }

  function onChange(cb) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'sync' && ch.settings) cb(merge(ch.settings.newValue));
    });
  }

  // ---- свои картинки и свои жесты: chrome.storage.local (там больше места) ----
  async function getLocal(key, def) {
    try { const r = await chrome.storage.local.get(key); return r[key] ?? def; } catch (_) { return def; }
  }
  const setLocal = (key, val) => chrome.storage.local.set({ [key]: val });

  globalThis.MemeCamSettings = { DEFAULTS, MEMES, merge, load, save, onChange, getLocal, setLocal };
})();
