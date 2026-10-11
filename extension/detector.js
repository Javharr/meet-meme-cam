/*
 * detector.js — мост между страницей Meet, детектором и панелью
 * ---------------------------------------------------------------------------
 * Сам ничего не распознаёт. Поднимает скрытый iframe со страницей расширения
 * (там MediaPipe) и перекладывает сообщения:
 *
 *   страница (MAIN) ⇄ мост ⇄ iframe-детектор
 *   панель (popup)  ⇄ мост      — статус и команды через chrome.tabs.sendMessage
 *   chrome.storage  → мост → страница — настройки, свои картинки, свои жесты
 *
 * Кадры и маски идут как ImageBitmap со списком передачи — пиксели не копируются.
 */
(() => {
  'use strict';
  const TAG = '[meme-cam/мост]';
  const SRC = chrome.runtime.getURL('detector.html');
  const toPage = (msg, transfer) => window.postMessage({ __memecam: 1, dir: 'toPage', ...msg }, '*', transfer || []);
  const toFrame = (msg, transfer) => {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ __memecam: 1, ...msg }, '*', transfer || []);
  };

  let frame = null;

  // =========================================================================
  // Настройки (storage.sync) → страница
  // =========================================================================
  const S = globalThis.MemeCamSettings;
  let settings = null;
  let lastState = null;
  const pushSettings = () => { if (settings) toPage({ type: 'settings', s: settings }); };
  if (S) {
    S.load().then((s) => { settings = s; pushSettings(); });
    S.onChange((s) => { settings = s; pushSettings(); });
  }

  // =========================================================================
  // Свои картинки и жесты (storage.local) → страница
  // =========================================================================
  // Картинки лежат base64-строками; странице отдаём ArrayBuffer со списком
  // передачи — без копирования, хоть это и несколько мегабайт GIF.
  const b64ToBuf = (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };
  async function pushMedia() {
    try {
      const { memeImages = {} } = await chrome.storage.local.get('memeImages');
      const items = {}, transfer = [];
      for (const [key, it] of Object.entries(memeImages)) {
        if (!it || !it.b64) continue;
        const buf = b64ToBuf(it.b64);
        items[key] = { type: it.type, buf };
        transfer.push(buf);
      }
      toPage({ type: 'media', items }, transfer);
    } catch (e) { console.warn(TAG, 'картинки не прочитались', e); }
  }
  async function pushGestures() {
    try {
      const { customGestures = [] } = await chrome.storage.local.get('customGestures');
      toPage({
        type: 'gestures',
        list: customGestures.map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, n: (g.samples || []).length })),
      });
    } catch (_) {}
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.memeImages) pushMedia();
    if (ch.customGestures) pushGestures();
  });

  // Записанные примеры жеста — дописываем к жесту, не больше 120 последних
  async function saveGestureSamples(id, samples) {
    const { customGestures = [] } = await chrome.storage.local.get('customGestures');
    const g = customGestures.find((x) => x.id === id);
    if (!g) return;
    g.samples = (g.samples || []).concat(samples).slice(-120);
    await chrome.storage.local.set({ customGestures });
  }

  // =========================================================================
  // Панель: статус и команды
  // =========================================================================
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || !msg.memecam) return;
    if (msg.memecam === 'status') {
      reply({ ok: true, state: lastState, settings });
    } else if (msg.memecam === 'cmd') {
      toPage({ type: 'cmd', cmd: msg.cmd, arg: msg.arg });
      reply({ ok: true });
    }
  });

  // =========================================================================
  // Iframe-детектор
  // =========================================================================
  function mount() {
    frame = document.createElement('iframe');
    frame.src = SRC;
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, {
      position: 'fixed', top: '-10000px', left: '0',
      width: '1px', height: '1px', opacity: '0',
      border: '0', pointerEvents: 'none',
    });
    frame.addEventListener('error', () => {
      toPage({ type: 'status', ready: false, error: 'iframe не загрузился' });
    });
    document.documentElement.appendChild(frame);
    console.log(TAG, 'iframe поднят');
  }

  const start = () => {
    mount();
    // Meet перерисовывает DOM при входе в звонок — возвращаем iframe назад
    setInterval(() => {
      if (frame && !frame.isConnected) {
        console.log(TAG, 'iframe снесло, поднимаю заново');
        document.documentElement.appendChild(frame);
      }
    }, 2000);
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  // =========================================================================
  // Сообщения
  // =========================================================================
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;

    // страница → мост
    if (d.__memecam === 1 && d.dir === 'toBridge' && ev.source === window) {
      if (d.type === 'hello') { pushSettings(); pushMedia(); pushGestures(); }
      else if (d.type === 'state') lastState = d.state;
      else if (d.type === 'save' && d.patch && S) {
        // со страницы разрешаем менять только то, что меняют хоткеи
        const ok = {};
        for (const k of ['hud', 'previewMirror']) if (k in d.patch) ok[k] = !!d.patch[k];
        if (Object.keys(ok).length) S.save(ok);
      } else if (d.type === 'saveTh' && d.th && S) {
        // пороги из калибровки — только числа и только знакомые ключи
        const th = {};
        for (const k of ['jawOpen', 'eyeWide', 'smile', 'browUp', 'browDown']) {
          const v = +d.th[k];
          if (Number.isFinite(v) && v > 0 && v < 1) th[k] = v;
        }
        S.save({ th });
      } else if (d.type === 'saveGesture' && d.id && Array.isArray(d.samples)) {
        saveGestureSamples(String(d.id), d.samples.filter((a) => Array.isArray(a) && a.length === 63));
      }
      return;
    }

    // страница → детектор
    if (d.__memecam === 1 && d.dir === 'toAI' && ev.source === window) {
      if ((d.type === 'frame' || d.type === 'seg') && d.bitmap) {
        toFrame({ type: d.type, bitmap: d.bitmap, ts: d.ts, sent: d.sent, fast: !!d.fast }, [d.bitmap]);
      } else if (d.type === 'record') {
        toFrame({ type: 'record', id: d.id, ms: d.ms });
      } else if (d.type === 'calib') {
        toFrame({ type: 'calib', on: !!d.on });
      }
      return;
    }

    // детектор → страница
    if (d.__memecamFrame === 1 && frame && ev.source === frame.contentWindow) {
      if (d.type === 'status') console.log(TAG, 'детектор:', d.ready ? 'готов' : (d.error || d.stage));
      const { __memecamFrame, ...rest } = d;
      if (rest.type === 'mask' && rest.bitmap) toPage(rest, [rest.bitmap]);   // маску передаём, а не копируем
      else toPage(rest);
    }
  });
})();
