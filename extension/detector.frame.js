/*
 * detector.frame.js — распознавание мимики, жестов и своих жестов
 * ---------------------------------------------------------------------------
 * Работает внутри detector.html — скрытого iframe со страницей расширения,
 * вставленного в Meet. Почему именно так, после двух неудачных подходов:
 *
 *   1. Изолированный мир контент-скрипта. MediaPipe грузит wasm-загрузчик
 *      через <script> в document.body, но такой тег выполняется в мире
 *      СТРАНИЦЫ → "ModuleFactory not set."
 *   2. Web Worker из контент-скрипта наследует origin страницы, а скрипт
 *      лежит на chrome-extension:// → "Failed to construct 'Worker'"
 *   3. Iframe со страницей расширения: origin наш, document есть, CSP наша.
 *
 * Общение с внешним миром — postMessage через parent (мост detector.js).
 */
import {
  FilesetResolver,
  FaceLandmarker,
  GestureRecognizer,
  ImageSegmenter,
} from './vendor/vision_bundle.mjs';

// Пороги по умолчанию. Калибровка из панели кладёт свои в settings.th.
const DEFAULT_TH = Object.freeze({
  jawOpen: 0.45,
  eyeWide: 0.20,
  smile: 0.55,
  browUp: 0.60,
  gesture: 0.60,
  needFrames: 3,
  cooldownKey: 3500,
  cooldownAny: 1500,
});
const TH = Object.assign({}, DEFAULT_TH);

const GESTURE_MAP = {
  Thumb_Up:    'like',
  Thumb_Down:  'dislike',
  Victory:     'peace',
  Closed_Fist: 'fire',
  Open_Palm:   'wave',
  Pointing_Up: 'idea',
  ILoveYou:    'love',
};

const say = (msg) => parent.postMessage({ __memecamFrame: 1, ...msg }, '*');

let faceLm = null, gestureRec = null, segmenter = null, ready = false;
let segError = null;

(async () => {
  try {
    say({ type: 'status', ready: false, stage: 'грузится' });
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');

    const mk = async (Cls, model, extra) => {
      const opts = {
        baseOptions: { modelAssetPath: './models/' + model, delegate: 'GPU' },
        runningMode: 'VIDEO',
        ...extra,
      };
      try {
        return await Cls.createFromOptions(fileset, opts);
      } catch (e) {
        console.warn('[ai]', model, 'GPU не вышло, беру CPU', e);
        opts.baseOptions.delegate = 'CPU';
        return await Cls.createFromOptions(fileset, opts);
      }
    };

    faceLm = await mk(FaceLandmarker, 'face_landmarker.task', {
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,   // поворот головы считаем по точкам — см. eyesOf()
    });
    gestureRec = await mk(GestureRecognizer, 'gesture_recognizer.task', { numHands: 1 });

    // Сегментация отдельно: без неё не будет исчезновения, но мемы
    // по жестам и мимике должны работать всё равно.
    try {
      segmenter = await mk(ImageSegmenter, 'selfie_segmenter_landscape.tflite', {
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    } catch (e) {
      segError = 'нет модели сегментации';
      console.warn('[ai] сегментация не загрузилась', e);
    }

    ready = true;
    say({ type: 'status', ready: true, seg: !!segmenter, segError });
    console.log('[ai] модели загружены, сегментация:', !!segmenter);
  } catch (e) {
    console.error('[ai] загрузка не удалась', e);
    say({ type: 'status', ready: false, error: String((e && e.message) || e) });
  }
})();

// =========================================================================
// Настройки
// =========================================================================
let faceOn = true, handsOn = true, customOn = true, lasersOn = true;
const SETTINGS = globalThis.MemeCamSettings;
if (SETTINGS) {
  const apply = (st) => {
    faceOn = !!(st.enabled && st.memesFace);
    handsOn = !!(st.enabled && st.memesHands);
    customOn = !!(st.enabled && st.customGestures !== false);
    lasersOn = !!(st.enabled && st.lasers !== false);
    Object.assign(TH, DEFAULT_TH, st.th || {});
  };
  SETTINGS.load().then(apply);
  SETTINGS.onChange(apply);
}

// =========================================================================
// Свои жесты: few-shot обучение на 21 точке руки
// =========================================================================
// MediaPipe отдаёт 21 точку руки в 3D (worldLandmarks, в метрах). Из них —
// вектор 63 числа: начало координат в запястье, масштаб по длине ладони
// (запястье → основание среднего пальца), левая рука отражается в правую.
// Так один и тот же жест похож на себя у любой руки и на любом расстоянии
// от камеры, а поворот кисти учитывается — 👍 и 👎 остаются разными.
//
// Классификатор — k ближайших соседей (k=3) среди твоих примеров. Порог
// «не узнал» у каждого жеста свой: по разбросу его же примеров
// (90-й перцентиль расстояния до ближайшего соседа × 2.2). Если два жеста
// почти одинаково близки — не срабатываем: лучше пропустить, чем ошибиться.
const FEAT = 63;
let custom = [];   // [{ id, name, X: Float32Array[], thr }]

function featureOf(gRes) {
  const wl = gRes.worldLandmarks && gRes.worldLandmarks[0];
  if (!wl || wl.length < 21) return null;
  const hd = gRes.handedness && gRes.handedness[0] && gRes.handedness[0][0];
  const flip = hd && hd.categoryName === 'Left' ? -1 : 1;
  const o = wl[0], m = wl[9];
  const scale = Math.hypot(m.x - o.x, m.y - o.y, m.z - o.z) || 1;
  const f = new Float32Array(FEAT);
  for (let i = 0; i < 21; i++) {
    f[i * 3]     = flip * (wl[i].x - o.x) / scale;
    f[i * 3 + 1] = (wl[i].y - o.y) / scale;
    f[i * 3 + 2] = (wl[i].z - o.z) / scale;
  }
  return f;
}

function dist(a, b) {
  let s = 0;
  for (let i = 0; i < FEAT; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function prepare(g) {
  const X = (g.samples || []).filter((a) => a && a.length === FEAT).map((a) => Float32Array.from(a));
  let thr = 0.6;
  if (X.length >= 3) {
    const nn = X.map((x, i) => {
      let best = Infinity;
      for (let j = 0; j < X.length; j++) if (j !== i) { const d = dist(x, X[j]); if (d < best) best = d; }
      return best;
    }).sort((a, b) => a - b);
    thr = Math.min(1.2, Math.max(0.15, nn[Math.floor(0.9 * (nn.length - 1))] * 2.2));
  }
  return { id: g.id, name: g.name, X, thr };
}

function loadCustom(list) {
  custom = (list || []).map(prepare).filter((g) => g.X.length >= 3);
  console.log('[ai] своих жестов:', custom.length);
}
try {
  chrome.storage.local.get('customGestures').then((r) => loadCustom(r.customGestures));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.customGestures) loadCustom(ch.customGestures.newValue);
  });
} catch (_) {}

function classify(f) {
  let best = null, bestR = Infinity, secondR = Infinity, bestD = 0;
  for (const g of custom) {
    const ds = g.X.map((x) => dist(f, x)).sort((a, b) => a - b);
    const k = Math.min(3, ds.length);
    let mean = 0;
    for (let i = 0; i < k; i++) mean += ds[i];
    mean /= k;
    const r = mean / g.thr;               // < 1 — внутри порога этого жеста
    if (r < bestR) { secondR = bestR; bestR = r; best = g; bestD = mean; }
    else if (r < secondR) secondR = r;
  }
  if (!best) return null;
  const ok = bestR < 1 && !(secondR < Infinity && bestR / secondR > 0.8);
  return { g: ok ? best : null, near: best, r: bestR, d: bestD };
}

// =========================================================================
// Лазеры: где глаза и куда смотрит голова
// =========================================================================
// Точки лица MediaPipe: x, y — доли кадра, z — глубина в масштабе x
// (меньше — ближе к камере). Центры зрачков — 468 и 473, внешние углы глаз —
// 33 и 263, лоб — 10, подбородок — 152.
// Куда повёрнута голова: нормаль к плоскости «линия глаз × линия лоб–подбородок».
// Её проекция на кадр — направление лучей: смотришь в камеру — лучи летят
// прямо на зрителя (видна вспышка), повернул голову — лучи уходят вбок.
const AI_AR = 144 / 256;   // кадр детектора 256x144: y переводим в единицы x
function eyesOf(lm) {
  if (!lm || lm.length < 474) return null;
  const P = (i) => [lm[i].x, lm[i].y * AI_AR, lm[i].z];
  const a = P(263), b = P(33), top = P(10), chin = P(152);
  const ax = a[0] - b[0], ay = a[1] - b[1], az = a[2] - b[2];             // поперёк лица
  const bx = chin[0] - top[0], by = chin[1] - top[1], bz = chin[2] - top[2]; // сверху вниз
  let nx = -(ay * bz - az * by), ny = -(az * bx - ax * bz), nz = -(ax * by - ay * bx);
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; }   // нормаль — к камере
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return {
    l: [r4(lm[468].x), r4(lm[468].y)], r: [r4(lm[473].x), r4(lm[473].y)],
    span: r4(Math.hypot(ax, ay)),        // ширина между углами глаз, доля ширины кадра
    n: [r4(nx), r4(ny), r4(nz)],
  };
}

// =========================================================================
// Антидребезг
// =========================================================================
let candidate = null, streak = 0, lastAny = -1e9;
const lastFired = Object.create(null);

function consider(key) {
  if (key !== candidate) { candidate = key; streak = 0; }
  if (!key) return;
  streak++;
  if (streak < TH.needFrames) return;
  const now = Date.now();
  if (now - lastAny < TH.cooldownAny) return;
  if (now - (lastFired[key] || -1e9) < TH.cooldownKey) return;
  lastFired[key] = now;
  lastAny = now;
  streak = 0;
  say({ type: 'fire', key });
}

// =========================================================================
// Разбор кадра
// =========================================================================
const scoreOf = (cats) => {
  const o = Object.create(null);
  if (cats) for (const c of cats) o[c.categoryName] = c.score;
  return o;
};

// Обе модели на каждом кадре — вдвое больше работы, чем нужно. Гоняем их
// по очереди и держим свежий результат другой: триггер не теряется, потому
// что жест и гримасу всё равно надо удержать ~0.3 с.
const FRESH_MS = 600;
const cache = { hand: null, handRaw: null, custom: null, handAt: -1e9, face: null, faceAt: -1e9 };
let busy = false, lastTs = 0, dbg = 0, turn = 0;

let rec = null;         // запись своего жеста: { id, until, samples, lastAt, seen }
let calibOn = false;    // калибровка: лицо каждый кадр, оценки — сразу на страницу

// Обратная связь со страницей: после каждого кадра — 'ack', и страница не шлёт
// новый, пока не получит подтверждение. Распознавание синхронное, поэтому
// «занят — пропускаю» само по себе не спасает: сообщения просто встают
// в очередь. Без подтверждений на медленной машине очередь росла бы без конца,
// мемы срабатывали бы с опозданием в секунды, а команды записи и калибровки
// стояли бы за десятками кадров.
const STALE_MS = 400;
const ack = (kind) => say({ type: 'ack', kind });

function onFrame(bitmap, ts, sent, fast) {
  if (!ready || busy || (sent && Date.now() - sent > STALE_MS)) {
    try { bitmap.close(); } catch (_) {}
    ack('frame');
    return;
  }
  busy = true;
  if (ts <= lastTs) ts = lastTs + 1;   // MediaPipe требует растущий таймстемп
  lastTs = ts;
  const now = Date.now();

  try {
    const runFace = faceOn || calibOn || lasersOn;
    const runHands = handsOn || (customOn && custom.length > 0) || !!rec;
    let doFace, doHands;
    if (rec) { doFace = false; doHands = true; }          // запись — только рука
    else if (calibOn) { doFace = true; doHands = false; } // калибровка — только лицо
    else if (fast) { doFace = true; doHands = false; }    // лазеры — глаза каждый кадр
    else {
      const t2 = turn++ % 2;
      doFace = runFace && (!runHands || t2 === 0);
      doHands = runHands && (!runFace || t2 === 1);
    }
    if (!doFace && !doHands) return;

    if (doFace) {
      const fRes = faceLm.detectForVideo(bitmap, ts);
      const b = scoreOf(fRes.faceBlendshapes && fRes.faceBlendshapes[0]
        && fRes.faceBlendshapes[0].categories);
      cache.face = {
        jaw:   b.jawOpen || 0,
        wide:  ((b.eyeWideLeft || 0) + (b.eyeWideRight || 0)) / 2,
        smile: ((b.mouthSmileLeft || 0) + (b.mouthSmileRight || 0)) / 2,
        brow:  b.browInnerUp || 0,
        frown: ((b.browDownLeft || 0) + (b.browDownRight || 0)) / 2,
        seen:  !!(fRes.faceBlendshapes && fRes.faceBlendshapes.length),
      };
      cache.faceAt = now;
      if (lasersOn && !calibOn) {
        const e = cache.face.seen ? eyesOf(fRes.faceLandmarks && fRes.faceLandmarks[0]) : null;
        say(e ? { type: 'eyes', seen: true, frown: +cache.face.frown.toFixed(3), ...e } : { type: 'eyes', seen: false });
      }
      if (calibOn) say({ type: 'calibSample', ...cache.face });
    }

    if (doHands) {
      const gRes = gestureRec.recognizeForVideo(bitmap, ts);
      const gTop = gRes.gestures && gRes.gestures[0] && gRes.gestures[0][0];
      cache.hand = gTop && gTop.score >= TH.gesture ? gTop.categoryName : null;
      cache.handRaw = gTop ? gTop.categoryName : null;
      cache.custom = null;
      const f = featureOf(gRes);
      if (f) {
        if (rec) {
          rec.seen++;
          // не чаще раза в 50 мс и не больше 60 примеров за запись
          if (now - rec.lastAt >= 50 && rec.samples.length < 60) {
            rec.lastAt = now;
            rec.samples.push(Array.from(f, (v) => Math.round(v * 1e4) / 1e4));
          }
        } else if (customOn && custom.length) {
          cache.custom = classify(f);
        }
      }
      cache.handAt = now;
    }

    if (rec && now >= rec.until) {
      say({ type: 'recorded', id: rec.id, samples: rec.samples, seen: rec.seen });
      rec = null;
    }
    if (rec || calibOn) return;    // во время записи и калибровки мемы не стреляют

    const f = (now - cache.faceAt < FRESH_MS) ? cache.face : null;
    const fresh = now - cache.handAt < FRESH_MS;
    const hand = fresh ? cache.hand : null;
    const cm = fresh ? cache.custom : null;

    // Свои жесты важнее встроенных, руки — важнее мимики: жест — осознанное
    // действие, а мимика может сработать случайно посреди разговора.
    let key = null;
    if (cm && cm.g) key = 'g_' + cm.g.id;
    else if (handsOn && hand && GESTURE_MAP[hand]) key = GESTURE_MAP[hand];
    else if (faceOn && f && f.jaw > TH.jawOpen && f.wide > TH.eyeWide) key = 'shock';
    else if (faceOn && f && f.smile > TH.smile) key = 'smile';
    else if (faceOn && f && f.brow > TH.browUp) key = 'hmm';

    consider(key);

    if (++dbg % 8 === 0) {
      say({
        type: 'scores',
        jaw: f ? +f.jaw.toFixed(2) : 0, wide: f ? +f.wide.toFixed(2) : 0,
        smile: f ? +f.smile.toFixed(2) : 0, brow: f ? +f.brow.toFixed(2) : 0,
        frown: f ? +f.frown.toFixed(2) : 0,
        hand: hand || (cache.handRaw ? cache.handRaw + '?' : '-'),
        face: !!(f && f.seen),
        custom: cm && cm.near
          ? { id: cm.near.id, name: cm.near.name, r: +cm.r.toFixed(2), hit: !!cm.g }
          : null,
      });
    }
  } catch (e) {
    say({ type: 'status', ready: true, error: 'кадр: ' + String((e && e.message) || e) });
  } finally {
    try { bitmap.close(); } catch (_) {}
    busy = false;
    ack('frame');
  }
}

// =========================================================================
// Сегментация: где человек, а где фон
// =========================================================================
// Маска уходит как ImageBitmap: белые пиксели, альфа = уверенность, что тут
// человек. Плюс доля кадра, занятая человеком — по ней страница понимает,
// что кадр пуст и можно снять чистый фон.
let segBusy = false, segLastTs = 0;

function onSeg(bitmap, ts, sent) {
  if (!segmenter || segBusy || (sent && Date.now() - sent > STALE_MS)) {
    try { bitmap.close(); } catch (_) {}
    ack('seg');
    return;
  }
  segBusy = true;
  if (ts <= segLastTs) ts = segLastTs + 1;
  segLastTs = ts;

  let out = null;
  const handle = (res) => {
    if (out || !res || !res.confidenceMasks || !res.confidenceMasks.length) return;
    const masks = res.confidenceMasks;              // 0 — фон, 1 — человек
    const m = masks.length >= 2 ? masks[1] : masks[0];
    const w = m.width, h = m.height;
    const f = m.getAsFloat32Array();
    const img = new ImageData(w, h);
    const px = img.data;
    let cov = 0;
    for (let i = 0; i < f.length; i++) {
      const c = f[i];
      if (c > 0.5) cov++;
      const a = c <= 0.3 ? 0 : c >= 0.7 ? 255 : ((c - 0.3) * 637.5) | 0;
      const j = i * 4;
      px[j] = 255; px[j + 1] = 255; px[j + 2] = 255; px[j + 3] = a;
    }
    out = { img, cov: cov / f.length };
  };

  try {
    // маски живут только внутри колбэка — переводим в ImageData сразу там
    const ret = segmenter.segmentForVideo(bitmap, ts, handle);
    if (ret) { handle(ret); try { ret.close(); } catch (_) {} }
  } catch (e) {
    say({ type: 'status', ready: true, seg: true, error: 'маска: ' + String((e && e.message) || e) });
  } finally {
    try { bitmap.close(); } catch (_) {}
    segBusy = false;
    ack('seg');
  }

  if (out) {
    createImageBitmap(out.img).then((bmp) => {
      parent.postMessage({ __memecamFrame: 1, type: 'mask', bitmap: bmp, coverage: out.cov }, '*', [bmp]);
    }).catch(() => {});
  }
}

// =========================================================================
// Сообщения
// =========================================================================
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.__memecam !== 1) return;
  if (d.type === 'frame' && d.bitmap) onFrame(d.bitmap, d.ts || Date.now(), d.sent, !!d.fast);
  else if (d.type === 'seg' && d.bitmap) onSeg(d.bitmap, d.ts || Date.now(), d.sent);
  else if (d.type === 'record' && d.id) {
    rec = { id: String(d.id), until: Date.now() + (d.ms || 3000), samples: [], lastAt: 0, seen: 0 };
  } else if (d.type === 'calib') {
    calibOn = !!d.on;
  }
});

// для проверки логики без камеры (используется в тестах)
globalThis.__memeKnn = { featureOf, prepare, classify, setCustom: (l) => loadCustom(l) };
globalThis.__memeEyes = eyesOf;

say({ type: 'status', ready: false, stage: 'iframe поднят' });
