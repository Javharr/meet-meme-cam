/*
 * Meme Cam — v1.2
 * ---------------------------------------------------------------------------
 * Живёт в MAIN-мире страницы Meet. Подменяет getUserMedia:
 *   камера → <video> → <canvas> + эффекты → canvas.captureStream() → Meet
 * Meet отправляет в сеть наш canvas, поэтому всё, что тут нарисовано,
 * видят все участники.
 *
 * Распознавание — в detector.frame.js (iframe расширения): оттуда приходят
 * триггеры мемов и маска «где человек».
 *
 * Новое в v1.0 — исчезновение:
 *   два хлопка → ты рассыпаешься на кусочки, как пепел, и становишься
 *   невидимкой; ещё два хлопка → собираешься обратно.
 *
 * Хоткеи: Ctrl+Shift+1/2/3 — мем вручную, +V — исчезнуть/появиться,
 *         +P — снять фон (обратный отсчёт), +A — распознавание вкл/выкл,
 *         +H — отладка, +M — зеркало, +B — яркость.
 */
(() => {
  'use strict';
  if (window.__memeCamInstalled) return;
  window.__memeCamInstalled = true;

  const TAG = '[meme-cam]';

  const MEMES = {
    shock:   { emoji: '\u{1F631}', text: 'ШОК',    color: '#ff3b30' },
    smile:   { emoji: '\u{1F602}', text: 'РЖУ',    color: '#ffcc00' },
    hmm:     { emoji: '\u{1F928}', text: 'ХМ',     color: '#a2845e' },
    like:    { emoji: '\u{1F44D}', text: 'ЛАЙК',   color: '#34c759' },
    dislike: { emoji: '\u{1F44E}', text: 'НЕ-А',   color: '#8e8e93' },
    peace:   { emoji: '\u{270C}\u{FE0F}', text: 'МИР', color: '#5ac8fa' },
    fire:    { emoji: '\u{1F525}', text: 'ОГОНЬ',  color: '#ff9500' },
    wave:    { emoji: '\u{1F44B}', text: 'ПРИВЕТ', color: '#af52de' },
    idea:    { emoji: '\u{1F4A1}', text: 'ИДЕЯ',   color: '#ffd60a' },
    love:    { emoji: '\u{1F91F}', text: 'ЛАВ',    color: '#ff2d55' },
  };

  const state = { key: null, start: 0, dur: 2500 };
  const GAINS = [1, 1.4, 1.8, 2.4, 3.0];
  let gainIdx = 0;
  let hudOn = false;
  let aiOn = true;
  let mirror = false;
  let shared = null;
  let pipeSeq = 0;

  const ai = { ready: false, stage: 'wait', error: null, s: null, fires: 0, seg: false, lastSeen: 0,
    inflight: 0 };   // когда ушёл кадр, который детектор ещё не подтвердил (0 — нет такого)
  const recording = { active: false, id: null, until: 0 };   // запись своего жеста
  const calib = { active: false };                           // калибровка мимики

  // Настройки из popup. Пока не пришли — работает всё, как раньше.
  const CFG = {
    enabled: true,
    memesFace: true,
    memesHands: true,
    memes: {},              // key → false, если мем выключен
    vanish: true,
    dustSize: 4,
    clapSensitivity: 'normal',
    previewMirror: true,
    hud: false,
    engine: 'auto',         // 'auto' | 'canvas' — запасной движок камеры
    captions: {},           // key → своя подпись ('' — без плашки)
    customGestures: true,
    lasers: true,
    laserColor: 'red',
    th: {},
  };
  const memeOn = (key) => CFG.memes[key] !== false;

  // Зеркало превью — только у тебя на экране. В поток не попадает.
  let previewMirror = true;
  let previewWins = 0;              // сколько окошек Meet показывают наш поток
  const ourTracks = new WeakSet();  // все треки, которые мы отдали Meet (с клонами)

  // =========================================================================
  // Подсказки — видишь только ты (это DOM страницы, а не видеопоток)
  // =========================================================================
  let toastEl = null, toastTimer = 0;
  function toast(text, ms = 1800) {
    if (!document.documentElement) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', left: '50%', top: '18px', transform: 'translateX(-50%)',
        zIndex: '2147483647', background: 'rgba(18,18,18,.9)', color: '#fff',
        font: '600 14px system-ui,-apple-system,sans-serif', padding: '9px 16px',
        borderRadius: '12px', pointerEvents: 'none', transition: 'opacity .2s',
        opacity: '0', maxWidth: '80vw', textAlign: 'center',
        boxShadow: '0 4px 20px rgba(0,0,0,.35)',
      });
    }
    if (!toastEl.isConnected) document.documentElement.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, ms);
  }

  // =========================================================================
  // Мемы
  // =========================================================================
  function fire(key, dur) {
    if (!MEMES[key]) return;
    // GIF показываем хотя бы один полный круг, но не дольше 6 с
    const media = MEDIA[key];
    if (dur == null) dur = media && media.total > 0 ? Math.min(6000, Math.max(2500, media.total)) : 2500;
    state.key = key; state.start = performance.now(); state.dur = dur;
    console.log(TAG, 'мем →', key);
  }
  window.__memeFire = fire;

  // =========================================================================
  // Исчезновение: состояние
  // =========================================================================
  //   visible → dissolving → gone → forming → visible
  const V = {
    state: 'visible',
    t0: 0, dur: 0,
    P: null, snapPx: null,
    mask: null, maskAt: 0, coverage: 1,
    emptyStreak: 0,
    plateClean: null,   // снятый пустой кадр — лучший фон
    plateCleanAt: -1e9,
    known: null,        // фон, увиденный по кусочкам: прозрачно там, где был ты
    knownReady: false, accumAt: 0,
    filled: null,       // known с дорисованными дырами — запасной фон
    wantPlate: false, wantAccum: false,
    pending: null,      // 'vanish' | 'appear' — ждём свежую маску
    pendingSince: 0,
    begin: null,        // 'dissolve' | 'form' — стартуем на ближайшем кадре
    segUntil: 0,        // до этого момента гоняем сегментацию часто
    cv: null,
  };
  const LIFE = 1.15;    // сколько летит одна частица, сек

  // =========================================================================
  // Хлопки — по микрофону
  // =========================================================================
  // Анализ идёт только локально, ничего не пишется и никуда не уходит.
  // Если микрофон выключен в Meet — не слушаем.
  const CLAP = {
    minPeak: 0.28,      // абсолютный порог громкости пика (0..1)
    ratio: 7,           // во сколько раз пик громче фона
    crest: 3.0,         // пик / RMS окна: хлопок — резкий, речь — плавная
    refractory: 110,    // один хлопок не считается дважды, мс
    minGap: 120,        // два хлопка — не ближе
    maxGap: 650,        // и не дальше, мс
    cooldown: 1500,     // пауза после двойного хлопка, мс
    quietBefore: 350,   // перед первым хлопком — тишина, мс
    quietAfter: 450,    // после второго — тишина не короче этого, мс…
    periodic: 1.2,      // …и не короче 1.2 промежутка: так отсекается любой ровный
                        // ритм — метроном, музыка, писк уведомлений
  };
  window.__memeClap = CLAP;

  const clap = {
    ctx: null, an: null, sink: null, buf: null, src: null,
    track: null, orig: null, timer: 0,
    avg: 0.02, last: -1e9, first: 0, pending: 0, pendingGap: 0, lastDouble: -1e9,
    peak: 0, count: 0, doubles: 0, rejected: 0,
  };

  function detachMic() {
    try { if (clap.src) clap.src.disconnect(); } catch (_) {}
    try { if (clap.track) clap.track.stop(); } catch (_) {}
    clap.src = clap.track = clap.orig = null;
  }

  function attachMic(orig) {
    if (!orig || orig.kind !== 'audio') return;
    try {
      detachMic();
      const t = orig.clone();            // клон: тот же микрофон, второй раз не открывается
      clap.track = t;
      clap.orig = orig;

      if (!clap.ctx) {
        clap.ctx = new AudioContext();
        // Chrome держит AudioContext на паузе до первого клика/клавиши
        const wake = () => {
          if (clap.ctx && clap.ctx.state !== 'running') clap.ctx.resume().catch(() => {});
        };
        window.addEventListener('pointerdown', wake, true);
        window.addEventListener('keydown', wake, true);
        clap.an = clap.ctx.createAnalyser();
        // Окно 4096 сэмплов ≈ 85 мс при опросе раз в 20 мс: окна перекрываются
        // с запасом, хлопок не проскочит, даже если страница подвиснет на 60 мс,
        // а пробуждений таймера вдвое меньше, чем при 2048/10 мс.
        // С окном 512 (≈11 мс) под нагрузкой терялись 2 хлопка из 5 —
        // Meet тяжёлая страница, такие подвисания там постоянно.
        clap.an.fftSize = 4096;
        clap.buf = new Float32Array(clap.an.fftSize);
        // анализатор подключаем к выходу через нулевую громкость:
        // так граф гарантированно обрабатывается, а звука нет
        clap.sink = clap.ctx.createGain();
        clap.sink.gain.value = 0;
        clap.an.connect(clap.sink).connect(clap.ctx.destination);
      }
      clap.ctx.resume().catch(() => {});
      clap.src = clap.ctx.createMediaStreamSource(new MediaStream([t]));
      clap.src.connect(clap.an);
      if (!clap.timer) clap.timer = setInterval(tickClap, 20);

      // Meet закрывает микрофон через stop(), а при stop() событие 'ended'
      // не приходит — поэтому оборачиваем stop и гасим свой клон вместе с ним
      const origStop = orig.stop.bind(orig);
      orig.stop = () => { origStop(); if (clap.orig === orig) detachMic(); };

      console.log(TAG, 'хлопки: слушаю микрофон');
    } catch (e) {
      console.warn(TAG, 'хлопки: микрофон не подключился', e);
    }
  }

  function tickClap() {
    if (!clap.src || !clap.ctx || clap.ctx.state !== 'running') return;
    if (!CFG.enabled || !CFG.vanish) { clap.peak = 0; clap.first = 0; clap.pending = 0; return; }
    const o = clap.orig;
    if (!o || o.readyState !== 'live' || !o.enabled) { clap.peak = 0; return; }

    clap.an.getFloatTimeDomainData(clap.buf);
    const b = clap.buf;
    let peak = 0, sum = 0;
    for (let i = 0; i < b.length; i++) {
      const v = b[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / b.length) || 1e-6;
    clap.peak = peak;

    const now = performance.now();
    const onset = peak > CLAP.minPeak
      && peak > clap.avg * CLAP.ratio
      && peak / rms > CLAP.crest
      && now - clap.last > CLAP.refractory;
    clap.avg = clap.avg * 0.97 + rms * 0.03;

    // Двойной хлопок — это ритм: пауза, удар, удар, пауза.
    // Клавиатура даёт серию щелчков, музыка и уведомления — ровный бит.
    // Поэтому после второго удара ждём тишину, и не короче 1.2 промежутка
    // между хлопками: у любого периодического звука третий удар придёт
    // ровно через тот же промежуток и всё отменит.
    const quiet = Math.max(CLAP.quietAfter, clap.pendingGap * CLAP.periodic);
    if (clap.pending && now - clap.pending > quiet) {
      clap.pending = 0;
      if (now - clap.lastDouble > CLAP.cooldown) {
        clap.lastDouble = now;
        clap.doubles++;
        console.log(TAG, 'двойной хлопок');
        toggleVanish('хлопок');
      }
    }

    if (!onset) {
      if (clap.first && now - clap.first > CLAP.maxGap) clap.first = 0;
      return;
    }

    const prev = clap.last;
    clap.last = now;
    clap.count++;

    if (clap.pending) {
      // третий удар подряд — клавиатура или аплодисменты
      clap.pending = 0;
      clap.first = 0;
      clap.rejected++;
      return;
    }
    if (clap.first && now - clap.first >= CLAP.minGap && now - clap.first <= CLAP.maxGap) {
      clap.pendingGap = now - clap.first;
      clap.first = 0;
      clap.pending = now;
    } else if (now - prev > CLAP.quietBefore) {
      clap.first = now;
      // Первый хлопок — заранее гоняем сегментацию: если будет второй,
      // свежая маска уже на руках и эффект стартует без задержки.
      V.segUntil = Math.max(V.segUntil, now + 1500);
    } else {
      clap.first = 0;   // посреди серии щелчков — не считаем
    }
  }

  // =========================================================================
  // Исчезновение: холсты, маска, фон
  // =========================================================================
  function newCanvas(w, h, opts) {
    const el = document.createElement('canvas');
    el.width = w; el.height = h;
    return [el, el.getContext('2d', opts)];
  }

  function resetPlates(why) {
    V.plateClean = null; V.plateCleanAt = -1e9;
    V.known = null; V.knownReady = false; V.filled = null;
    if (why) console.log(TAG, 'фон сброшен:', why);
  }

  function ensureCanvases(W, H) {
    if (V.cv && V.cv.W === W && V.cv.H === H) return V.cv;
    const sizeChanged = !!V.cv;
    const [snap, snapCtx] = newCanvas(W, H);
    const [layer, layerCtx] = newCanvas(W, H);
    const [tmp, tmpCtx] = newCanvas(W, H);
    const [small, smallCtx] = newCanvas(256, 144);
    const [grid, gridCtx] = newCanvas(8, 8, { willReadFrequently: true });
    const [dust, dustCtx] = newCanvas(W, H);
    const dustImg = dustCtx.createImageData(W, H);
    const dustBuf = new Uint32Array(dustImg.data.buffer);
    V.cv = { W, H, snap, snapCtx, layer, layerCtx, tmp, tmpCtx, small, smallCtx, grid, gridCtx,
             dust, dustCtx, dustImg, dustBuf, bb: null };
    if (sizeChanged) resetPlates('сменился размер кадра');
    return V.cv;
  }

  // Маска «где человек», расширенная на dil пикселей маски во все стороны.
  // Расширение нужно, чтобы край тела не просвечивал, когда двигаешься:
  // маска приходит ~20 раз в секунду, а кадров — 30.
  function maskToSmall(dil) {
    const c = V.cv, m = V.mask;
    if (c.small.width !== m.width || c.small.height !== m.height) {
      c.small.width = m.width; c.small.height = m.height;
    }
    const s = c.smallCtx;
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, m.width, m.height);
    s.globalCompositeOperation = 'lighter';
    const step = dil || 1;
    for (let dx = -dil; dx <= dil; dx += step) {
      for (let dy = -dil; dy <= dil; dy += step) s.drawImage(m, dx, dy);
    }
    s.globalCompositeOperation = 'source-over';
    return c.small;
  }

  // Маска 256x144 → во весь кадр. Билинейное растяжение само даёт мягкий край.
  function drawMaskBig(g, W, H, small) {
    g.save();
    if (mirror) { g.translate(W, 0); g.scale(-1, 1); }
    g.imageSmoothingEnabled = true;
    g.drawImage(small, 0, 0, W, H);
    g.restore();
  }

  const plate = () => V.plateClean || V.filled;

  function captureCleanPlate(canvas, W, H) {
    if (!V.plateClean) [V.plateClean] = newCanvas(W, H);
    V.plateClean.getContext('2d').drawImage(canvas, 0, 0);
    V.plateCleanAt = performance.now();
  }

  // Накопление фона: каждый раз, когда приходит маска, всё, что сейчас НЕ ты,
  // переносится в known. Там, где ты сидишь всё время, known остаётся
  // прозрачным — эти дыры дорисовывает inpaint.
  function accumulatePlate(canvas, W, H) {
    if (!V.mask) return;
    const c = V.cv;
    if (!V.known) [V.known] = newCanvas(W, H);
    const t = c.tmpCtx;
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, W, H);
    t.drawImage(canvas, 0, 0);
    t.globalCompositeOperation = 'destination-out';
    const big = maskToSmall(4);          // с запасом, чтобы край тела не въелся в фон
    drawMaskBig(t, W, H, big);
    drawMaskBig(t, W, H, big);           // дважды — мягкий край маски вырезаем начисто
    t.globalCompositeOperation = 'source-over';
    V.known.getContext('2d').drawImage(c.tmp, 0, 0);
    V.knownReady = true;
    V.accumAt = performance.now();
  }

  // Дорисовать дыру на месте человека.
  // Типичная картинка с вебкамеры: человек в центре, слева и справа фон.
  // Поэтому каждую строку дыры заполняем плавным переходом от цвета фона
  // слева к цвету фона справа. Цвет на концах — среднее по 6 пикселям,
  // чтобы шум камеры не превратился в полосы. Если фон есть только с одной
  // стороны (сидишь у края кадра) — тянем его. Если строка целиком занята
  // тобой — копируем строку выше.
  // Считаем в половинном разрешении (в 4 раза быстрее), потом мягко
  // размываем заливку и кладём резкий известный фон поверх.
  function inpaint(src, W, H) {
    const w = W >> 1, h = H >> 1;
    const [half, hg] = newCanvas(w, h, { willReadFrequently: true });
    hg.drawImage(src, 0, 0, w, h);
    const img = hg.getImageData(0, 0, w, h);
    const px = img.data;
    const KNOWN = 200;
    const al = (x, y) => px[(y * w + x) * 4 + 3];

    const avg = (y, xs, dir) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let x = xs; x >= 0 && x < w && n < 6; x += dir) {
        if (al(x, y) <= KNOWN) break;
        const i = (y * w + x) * 4;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
      }
      return n ? [r / n, g / n, b / n] : null;
    };

    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (al(x, y) > KNOWN) { x++; continue; }
        const x0 = x;
        while (x < w && al(x, y) <= KNOWN) x++;
        const x1 = x;                                   // дыра [x0, x1)
        const L = x0 > 0 ? avg(y, x0 - 1, -1) : null;
        const R = x1 < w ? avg(y, x1, +1) : null;
        const A = L || R, B = R || L;
        for (let k = x0; k < x1; k++) {
          const i = (y * w + k) * 4;
          if (!A) {                                     // вся строка — ты
            if (y > 0) {
              const j = ((y - 1) * w + k) * 4;
              px[i] = px[j]; px[i + 1] = px[j + 1]; px[i + 2] = px[j + 2];
            } else { px[i] = px[i + 1] = px[i + 2] = 127; }
          } else {
            const t = x1 - x0 <= 1 ? 0.5 : (k - x0) / (x1 - x0 - 1);
            px[i]     = A[0] + (B[0] - A[0]) * t;
            px[i + 1] = A[1] + (B[1] - A[1]) * t;
            px[i + 2] = A[2] + (B[2] - A[2]) * t;
          }
          px[i + 3] = 255;
        }
      }
    }
    hg.putImageData(img, 0, 0);

    const [out, o] = newCanvas(W, H);
    o.filter = 'blur(6px)';            // сгладить построчные полосы
    o.drawImage(half, 0, 0, W, H);
    o.filter = 'none';
    o.drawImage(src, 0, 0);            // известный фон — резкий, поверх
    return out;
  }

  // Закрыть человека фоном по маске
  function drawCover(ctx, W, H, alpha) {
    const P = plate();
    if (!V.mask || !P || alpha <= 0) return;
    const c = V.cv, g = c.layerCtx;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    drawMaskBig(g, W, H, maskToSmall(2));
    g.globalCompositeOperation = 'source-in';
    g.drawImage(P, 0, 0);
    g.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.drawImage(c.layer, 0, 0);
    ctx.globalAlpha = 1;
  }

  // =========================================================================
  // Исчезновение: частицы
  // =========================================================================
  // Кадр режется на квадраты DUST.size пикселей (в пересчёте на ширину 1280).
  // В частицы идут только те, что попали на человека: при 4 px это
  // ~10–15 тысяч штук. Рисовать каждую через drawImage слишком дорого,
  // поэтому частицы пишутся прямо в пиксельный буфер, а на холст уходит
  // только прямоугольник, где они сейчас есть.
  const DUST = { size: 4 };
  window.__memeDust = DUST;

  function buildParticles(W, H) {
    const c = V.cv;
    const T = Math.max(2, Math.round(DUST.size * W / 1280));
    const gw = Math.ceil(W / T), gh = Math.ceil(H / T);
    c.grid.width = gw; c.grid.height = gh;
    const g = c.gridCtx;
    g.clearRect(0, 0, gw, gh);
    g.save();
    if (mirror) { g.translate(gw, 0); g.scale(-1, 1); }
    g.drawImage(maskToSmall(1), 0, 0, gw, gh);
    g.restore();
    const d = g.getImageData(0, 0, gw, gh).data;

    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] >= 70) n++;
    const P = {
      n, T,
      hx: new Int16Array(n), hy: new Int16Array(n), d: new Float32Array(n),
      vx: new Float32Array(n), vy: new Float32Array(n), w: new Float32Array(n),
    };
    let maxD = 0, k = 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (d[(y * gw + x) * 4 + 3] < 70) continue;
        const nx = x / gw, ny = y / gh;
        // волна идёт по кадру с рваным краем — как пепел на ветру
        const delay = nx * 0.75 + Math.random() * 0.55 + (1 - ny) * 0.1;
        if (delay > maxD) maxD = delay;
        P.hx[k] = x * T; P.hy[k] = y * T; P.d[k] = delay;
        P.vx[k] = 60 + Math.random() * 200;
        P.vy[k] = -(10 + Math.random() * 90);
        P.w[k] = Math.random() * 6.283;
        k++;
      }
    }
    // цвета частиц — из пикселей застывшего кадра
    V.snapPx = new Uint32Array(c.snapCtx.getImageData(0, 0, W, H).data.buffer);
    c.dustBuf.fill(0);
    c.dustCtx.clearRect(0, 0, W, H);
    c.bb = null;
    V.P = P;
    V.dur = maxD + LIFE;
    return n;
  }

  // mode 'out' — разлёт, 'in' — сборка (кто улетел последним, возвращается первым)
  function renderDust(ctx, t, mode, fade) {
    const c = V.cv, P = V.P, W = c.W, H = c.H, T = P.T;
    const buf = c.dustBuf, src = V.snapPx;
    const maxD = V.dur - LIFE;

    // стереть частицы прошлого кадра
    const ob = c.bb;
    if (ob) for (let y = ob.y0; y < ob.y1; y++) buf.fill(0, y * W + ob.x0, y * W + ob.x1);

    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let i = 0; i < P.n; i++) {
      const hx = P.hx[i], hy = P.hy[i];
      let x, y, a, s;
      if (mode === 'out') {
        const u = t - P.d[i];
        if (u >= LIFE) continue;
        if (u <= 0) {               // ещё не отлетел — кусочек «застывшего» тебя
          x = hx; y = hy; a = 1; s = T;
        } else {
          const k = u / LIFE;
          x = hx + P.vx[i] * u + Math.sin(P.w[i] + u * 7) * 6 * k;
          y = hy + P.vy[i] * u - 40 * u * u;
          a = (1 - k) * (1 - k);
          s = Math.max(1, Math.round(T * (1 - 0.6 * k)));
        }
      } else {
        const u = t - (maxD - P.d[i]);
        if (u <= 0) continue;
        const k = Math.min(1, u / LIFE);
        const e = 1 - (1 - k) * (1 - k) * (1 - k);   // плавное торможение у цели
        const r = 1 - e, uu = LIFE * r;
        x = hx + P.vx[i] * uu + Math.sin(P.w[i] + uu * 7) * 6 * r;
        y = hy + P.vy[i] * uu - 40 * uu * uu;
        a = e * fade;
        s = Math.max(1, Math.round(T * (1 - 0.6 * r)));
      }
      const A = (a * 255) | 0;
      if (A <= 2) continue;
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi >= W || yi >= H || xi + s <= 0 || yi + s <= 0) continue;
      const am = A << 24;
      const sxs = xi < 0 ? -xi : 0, sys = yi < 0 ? -yi : 0;
      const sxe = Math.min(s, W - xi, W - hx), sye = Math.min(s, H - yi, H - hy);
      for (let dy = sys; dy < sye; dy++) {
        const so = (hy + dy) * W + hx, to = (yi + dy) * W + xi;
        for (let dx = sxs; dx < sxe; dx++) buf[to + dx] = (src[so + dx] & 0x00ffffff) | am;
      }
      if (xi < x0) x0 = xi;
      if (yi < y0) y0 = yi;
      if (xi + s > x1) x1 = xi + s;
      if (yi + s > y1) y1 = yi + s;
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    const nb = x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;

    // на холст — объединение прошлой и новой области, чтобы стереть и старые частицы
    const ux0 = Math.min(nb ? nb.x0 : W, ob ? ob.x0 : W);
    const uy0 = Math.min(nb ? nb.y0 : H, ob ? ob.y0 : H);
    const ux1 = Math.max(nb ? nb.x1 : 0, ob ? ob.x1 : 0);
    const uy1 = Math.max(nb ? nb.y1 : 0, ob ? ob.y1 : 0);
    if (ux1 > ux0 && uy1 > uy0) c.dustCtx.putImageData(c.dustImg, 0, 0, ux0, uy0, ux1 - ux0, uy1 - uy0);
    c.bb = nb;
    if (nb) {
      const w = nb.x1 - nb.x0, h = nb.y1 - nb.y0;
      ctx.drawImage(c.dust, nb.x0, nb.y0, w, h, nb.x0, nb.y0, w, h);
    }
  }

  function startDissolve(canvas, W, H) {
    const c = ensureCanvases(W, H);
    c.snapCtx.clearRect(0, 0, W, H);
    c.snapCtx.drawImage(canvas, 0, 0);       // застывший кадр — из него и летят кусочки
    if (!V.plateClean) {
      accumulatePlate(canvas, W, H);
      const t0 = performance.now();
      V.filled = inpaint(V.known, W, H);
      console.log(TAG, `фон дорисован за ${Math.round(performance.now() - t0)} мс`);
      toast('Фон за тобой дорисован. Для идеала выйди заранее '
        + 'из кадра на 2 секунды — сниму чистый', 4500);
    }
    const n = buildParticles(W, H);
    V.state = 'dissolving';
    V.t0 = performance.now();
    console.log(TAG, 'исчезаю, частиц:', n);
  }

  function startForming(canvas, W, H) {
    const c = ensureCanvases(W, H);
    c.snapCtx.clearRect(0, 0, W, H);
    c.snapCtx.drawImage(canvas, 0, 0);       // какой ты сейчас — таким и соберёшься
    const n = buildParticles(W, H);
    V.state = 'forming';
    V.t0 = performance.now();
    console.log(TAG, 'появляюсь, частиц:', n);
  }

  function renderVanish(ctx, W, H) {
    const t = (performance.now() - V.t0) / 1000;
    if (V.state === 'dissolving') {
      drawCover(ctx, W, H, 1);
      renderDust(ctx, t, 'out', 1);
      if (t >= V.dur) {
        V.state = 'gone';
        V.P = null; V.snapPx = null;
        toast('Ты невидимка 👻  Хлопни дважды — вернёшься', 3000);
      }
    } else if (V.state === 'gone') {
      drawCover(ctx, W, H, 1);
    } else if (V.state === 'forming') {
      const TAIL = 0.35;
      if (t < V.dur) {
        drawCover(ctx, W, H, 1);
        renderDust(ctx, t, 'in', 1);
      } else if (t < V.dur + TAIL) {
        // собранный «слепок» растворяется в живую картинку
        const k = (t - V.dur) / TAIL;
        drawCover(ctx, W, H, 1 - k);
        renderDust(ctx, V.dur, 'in', 1 - k);
      } else {
        V.state = 'visible';
        V.P = null; V.snapPx = null;
      }
    }
  }

  function toggleVanish(source) {
    if (!CFG.enabled || !CFG.vanish) { toast('Исчезновение выключено в настройках расширения'); return; }
    if (!ai.ready || !ai.seg) {
      toast('Исчезновение недоступно: нет модели сегментации — см. папку models/', 4000);
      return;
    }
    if (!aiOn) { toast('Распознавание выключено — Ctrl+Shift+A'); return; }
    const now = performance.now();
    if (V.state === 'visible') V.pending = 'vanish';
    else if (V.state === 'gone') V.pending = 'appear';
    else return;   // анимация уже идёт — не дёргаем
    V.pendingSince = now;
    V.segUntil = Math.max(V.segUntil, now + 2500);
    console.log(TAG, source, '→', V.pending);
  }

  function countdownPlate() {
    if (!ai.ready || !ai.seg) { toast('Нужна модель сегментации — см. папку models/', 3500); return; }
    if (V.state !== 'visible') { toast('Сначала появись'); return; }
    let n = 3;
    const step = () => {
      if (n > 0) {
        toast(`Выйди из кадра… ${n}`, 1100);
        V.segUntil = performance.now() + 1500;
        n--;
        setTimeout(step, 1000);
      } else if (V.coverage > 0.02) {
        toast('Ты ещё в кадре — фон не снят. Попробуй снова', 3000);
      } else {
        V.wantPlate = 'manual';
      }
    };
    step();
  }

  // =========================================================================
  // Сообщения от детектора
  // =========================================================================
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__memecam !== 1 || d.dir !== 'toPage') return;

    if (d.type === 'settings' && d.s) {
      applySettings(d.s);
      return;
    }
    if (d.type === 'cmd') {
      runCommand(d.cmd, d.arg);
      return;
    }
    if (d.type === 'eyes') {
      onEyes(d);
      return;
    }
    if (d.type === 'fire') {
      if (V.state !== 'visible') return;   // невидимке мемы ни к чему
      if (L.on) return;                    // лазеры важнее мема
      if (!CFG.enabled || !memeOn(d.key)) return;
      ai.fires++;
      fire(d.key);
    } else if (d.type === 'status') {
      ai.ready = !!d.ready;
      if ('seg' in d) ai.seg = !!d.seg;
      ai.error = d.error || d.segError || null;
      ai.stage = d.error ? 'ошибка' : (d.ready ? 'готов' : (d.stage || 'грузится'));
      console.log(TAG, 'детектор:', ai.stage, 'сегментация:', ai.seg, d.error || d.segError || '');
    } else if (d.type === 'ack') {
      ai.inflight = 0;
    } else if (d.type === 'media' && d.items) {
      applyMedia(d.items);
    } else if (d.type === 'gestures') {
      applyGestures(d.list);
    } else if (d.type === 'recorded') {
      onRecorded(d);
    } else if (d.type === 'calibSample') {
      onCalibSample(d);
    } else if (d.type === 'scores') {
      ai.s = d;
      if (d.face || (d.hand && d.hand !== '-')) ai.lastSeen = performance.now();
    } else if (d.type === 'mask' && d.bitmap) {
      if (V.mask) { try { V.mask.close(); } catch (_) {} }
      V.mask = d.bitmap;
      V.maskAt = performance.now();
      V.coverage = d.coverage;

      if (V.pending === 'vanish') { V.begin = 'dissolve'; V.pending = null; }
      else if (V.pending === 'appear') { V.begin = 'form'; V.pending = null; }

      if (V.state === 'visible') {
        if (d.coverage < 0.004) {
          // в кадре никого — самый момент снять чистый фон.
          // Подтверждаем частой сегментацией, но только пока свежего фона нет:
          // иначе пустой кадр бесконечно продлевал бы частый режим сам себе,
          // и детектор лица и рук оставался бы без кадров.
          const stale = performance.now() - V.plateCleanAt > 5000;
          if (stale) V.segUntil = Math.max(V.segUntil, performance.now() + 600);
          if (++V.emptyStreak >= 3 && stale) V.wantPlate = 'auto';
        } else {
          V.emptyStreak = 0;
          if (d.coverage < 0.6 && performance.now() - V.accumAt > 400) V.wantAccum = true;
        }
      }
    }
  });

  // =========================================================================
  // Хоткеи
  // =========================================================================
  const HOTKEYS = { Digit1: 'shock', Digit2: 'like', Digit3: 'fire' };
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.code) {
      case 'KeyV': stop(); toggleVanish('хоткей'); return;
      case 'KeyL':
        stop();
        if (L.on) stopLasers();
        else if (!lasersAllowed()) toast('Лазеры выключены в панели');
        else startLasers(3000);
        return;
      case 'KeyP': stop(); countdownPlate(); return;
      case 'KeyH': stop(); hudOn = !hudOn; saveSetting({ hud: hudOn }); return;
      case 'KeyA':
        stop(); aiOn = !aiOn;
        toast(aiOn ? 'Распознавание включено' : 'Распознавание выключено');
        return;
      case 'KeyB':
        stop(); gainIdx = (gainIdx + 1) % GAINS.length;
        resetPlates('сменилась яркость');
        toast(`Яркость ×${GAINS[gainIdx]}`);
        return;
      case 'KeyM':
        stop();
        previewMirror = !previewMirror;
        saveSetting({ previewMirror });
        toast(previewMirror
          ? 'Превью как в зеркале. Собеседники видят тебя как обычно'
          : 'Превью без зеркала. Собеседники видят тебя как обычно');
        return;
    }
    const key = HOTKEYS[e.code];
    if (!key || !CFG.enabled) return;
    stop(); fire(key);
  }, true);

  // =========================================================================
  // Отрисовка мема и отладки
  // =========================================================================
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function drawOverlay(ctx, W, H) {
    if (!state.key) return;
    const t = (performance.now() - state.start) / state.dur;
    if (t >= 1) { state.key = null; return; }

    const m = MEMES[state.key];
    if (!m) { state.key = null; return; }
    const pop  = t < 0.18 ? easeOutBack(t / 0.18) : 1;
    const fade = t > 0.80 ? 1 - (t - 0.80) / 0.20 : 1;
    const a = Math.max(0, Math.min(1, fade));

    ctx.save();
    ctx.globalAlpha = a;
    const media = MEDIA[state.key];
    if (media && media.frames.length) {
      // своя картинка или GIF: кадр по времени, вписываем в правую часть кадра
      let fr = media.frames[0];
      if (media.frames.length > 1 && media.total > 0) {
        let left = (performance.now() - state.start) % media.total;
        for (const f of media.frames) { if (left < f.dur) { fr = f; break; } left -= f.dur; }
      }
      let h = H * 0.48 * pop, w = h * fr.bmp.width / fr.bmp.height;
      const maxW = W * 0.46;
      if (w > maxW) { h *= maxW / w; w = maxW; }
      ctx.drawImage(fr.bmp, W * 0.74 - w / 2, H * 0.38 - h / 2, w, h);
    } else {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const size = Math.max(1, Math.round(H * 0.34 * pop));
      ctx.font = `${size}px "Apple Color Emoji","Noto Color Emoji",sans-serif`;
      ctx.fillText(m.emoji, W * 0.76, H * 0.36);
    }

    const cap = Object.prototype.hasOwnProperty.call(CFG.captions, state.key)
      ? CFG.captions[state.key] : m.text;
    if (cap) {
      const bh = Math.round(H * 0.14);
      ctx.globalAlpha = a * 0.88;
      ctx.fillStyle = m.color;
      ctx.fillRect(0, H - bh, W, bh);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let fs = Math.round(bh * 0.55);
      ctx.font = `700 ${fs}px system-ui,-apple-system,sans-serif`;
      while (fs > 12 && ctx.measureText(cap).width > W * 0.92) {   // длинная подпись — мельче
        fs -= 2; ctx.font = `700 ${fs}px system-ui,-apple-system,sans-serif`;
      }
      ctx.fillText(cap, W / 2, H - bh / 2);
    }
    ctx.restore();
  }


  // =========================================================================
  // Лазеры из глаз
  // =========================================================================
  // Нахмурься — из глаз бьют лучи, пока держишь. Детектор шлёт центры зрачков,
  // ширину глаз и нормаль лица (куда повёрнута голова). Лучи идут по проекции
  // нормали: смотришь в камеру — лучи летят прямо на зрителя, и видна только
  // вспышка; повернул голову — лучи уходят в сторону и жгут край кадра.
  // Пока лазеры горят, детектор получает кадры чаще и смотрит только на лицо.
  const LASER_COLORS = {
    red:   { glow: '255,36,24',  mid: '255,84,60',   core: '255,238,228' },
    green: { glow: '36,255,96',  mid: '110,255,140', core: '232,255,236' },
    blue:  { glow: '40,160,255', mid: '96,196,255',  core: '228,244,255' },
  };
  const LASER_FADE = 260;
  const L = {
    on: false, since: 0, offAt: -1e9, manualUntil: 0,
    tg: null, sm: null, seenAt: -1e9, drawAt: 0,
    frown: 0, above: 0, lastAbove: 0, warmAt: -1e9, gap: 100,
    shots: 0, sparks: [], glow: null,
  };
  // Порог хмурости. После калибровки — свой. Без неё — от твоего спокойного
  // лица: у многих MediaPipe и без всякой хмурости видит 0.4–0.5 (свет сверху,
  // глубоко посаженные глаза), и общий порог срабатывал бы сам собой.
  // Поэтому копим, какая хмурость у тебя обычно (40-й перцентиль за ~20 с),
  // и стреляем, когда она выше обычной на 0.22. Пока не накопили — не стреляем.
  const FROWN_HIST = [];
  let frownHistAt = 0;
  const frownTh = () => {
    const v = CFG.th && +CFG.th.browDown;
    if (v > 0 && v < 1) return v;
    if (FROWN_HIST.length < 12) return 0.95;
    const a = FROWN_HIST.slice().sort((x, y) => x - y);
    const base = a[Math.floor(a.length * 0.4)];
    return +Math.min(0.92, Math.max(0.3, base + 0.22)).toFixed(2);
  };
  const lasersAllowed = () => CFG.enabled && CFG.lasers !== false;

  function onEyes(d) {
    const now = performance.now();
    if (!d.seen) { L.frown = 0; L.above = 0; return; }
    // как часто приходят глаза: на медленной машине — реже, и ждать надо дольше
    if (now - L.seenAt < 2000) L.gap = L.gap * 0.8 + (now - L.seenAt) * 0.2;
    L.seenAt = now;
    ai.lastSeen = now;
    const fx = (x) => (mirror ? 1 - x : x);
    L.tg = {
      lx: fx(d.l[0]), ly: d.l[1], rx: fx(d.r[0]), ry: d.r[1], span: d.span,
      nx: mirror ? -d.n[0] : d.n[0], ny: d.n[1], nz: d.n[2],
    };
    if (!L.sm || (!L.on && now - L.offAt > LASER_FADE)) L.sm = Object.assign({}, L.tg);
    L.frown = +d.frown || 0;
    if (!L.on && now - frownHistAt > 250) {
      frownHistAt = now;
      FROWN_HIST.push(L.frown);
      if (FROWN_HIST.length > 90) FROWN_HIST.shift();
    }
    if (!lasersAllowed()) return;
    const th = frownTh();
    if (L.frown > th - 0.1) L.warmAt = now;
    L.above = L.frown > th ? L.above + 1 : 0;
    if (L.on) {
      if (L.frown > Math.max(th * 0.75, th - 0.1)) L.lastAbove = now;
    } else if (L.above >= 2 && V.state === 'visible' && !recording.active && !calib.active
      && now - L.offAt > 400) {
      startLasers(0);
    }
  }

  function startLasers(manualMs) {
    const now = performance.now();
    if (!lasersAllowed()) return false;
    if (V.state !== 'visible') return false;
    if (!L.tg || now - L.seenAt > 3000) {
      if (manualMs) toast('Лицо не видно — лазерам не из чего стрелять', 2500);
      return false;
    }
    if (!L.on) { L.since = now; L.sm = Object.assign({}, L.tg); L.shots++; }
    L.on = true;
    L.lastAbove = now;
    L.manualUntil = manualMs ? now + manualMs : 0;
    state.key = null;                    // мем уступает место лазерам
    console.log(TAG, 'лазеры →', manualMs ? 'вручную' : 'хмурость ' + L.frown.toFixed(2));
    return true;
  }
  function stopLasers() {
    if (!L.on) return;
    L.on = false;
    L.offAt = performance.now();
    L.above = 0;
  }

  // Сглаживание: глаза приходят 7–16 раз в секунду, кадры — 20–30.
  const L_KEYS = ['lx', 'ly', 'rx', 'ry', 'span', 'nx', 'ny', 'nz'];
  function glowCanvas(w, h) {
    if (!L.glow || L.glow.width !== w || L.glow.height !== h) {
      if (typeof OffscreenCanvas === 'function') L.glow = new OffscreenCanvas(w, h);
      else { L.glow = document.createElement('canvas'); L.glow.width = w; L.glow.height = h; }
    }
    return L.glow;
  }

  function drawLasers(ctx, W, H) {
    const now = performance.now();
    if (L.on && now >= L.manualUntil) {
      const lost = now - L.seenAt > Math.max(700, L.gap * 3);
      const relaxed = now - L.lastAbove > 300 + L.gap * 2 && now - L.since > 900;
      if (lost || relaxed || !lasersAllowed() || V.state !== 'visible') stopLasers();
    }
    const fading = !L.on && now - L.offAt < LASER_FADE;
    if ((!L.on && !fading) || !L.sm) {
      L.sparks.length = 0;
      L.drawAt = now;
      return;
    }
    const dt = Math.min(0.1, Math.max(0, (now - L.drawAt) / 1000));
    L.drawAt = now;
    if (L.tg) {
      const k = 1 - Math.exp(-dt / 0.06);
      for (const key of L_KEYS) L.sm[key] += (L.tg[key] - L.sm[key]) * k;
    }
    const S = L.sm;
    const C = LASER_COLORS[CFG.laserColor] || LASER_COLORS.red;
    const alpha = L.on ? Math.min(1, (now - L.since) / 140) : Math.max(0, 1 - (now - L.offAt) / LASER_FADE);
    const g01 = Math.min(1, (now - L.since) / 260);
    const grow = 1 - (1 - g01) ** 3;
    const span = Math.max(8, S.span * W);
    const sc = W / 1280;

    // куда лучи: проекция нормали лица на кадр
    let nx = S.nx, ny = S.ny;
    const s = Math.min(0.95, Math.hypot(nx, ny));
    if (s > 1e-4) { nx /= Math.hypot(S.nx, S.ny); ny /= Math.hypot(S.nx, S.ny); }
    const front = 1 - Math.min(1, s / 0.28);            // 1 — смотришь прямо в камеру
    const len = s > 0.04 ? s * W * 2.6 * grow : 0;
    const flick = 0.9 + Math.random() * 0.2;
    const w0 = span * 0.05 * flick;
    const w1 = (span * 0.05 + span * 0.55 * s) * flick;
    const eyes = [[S.lx * W, S.ly * H], [S.rx * W, S.ry * H]];
    const tilt = Math.atan2(eyes[1][1] - eyes[0][1], eyes[1][0] - eyes[0][0]);
    const quad = (g, ex, ey, k) => {
      const px = -ny, py = nx;
      const qx = ex + nx * len, qy = ey + ny * len;
      g.beginPath();
      g.moveTo(ex + px * w0 * k / 2, ey + py * w0 * k / 2);
      g.lineTo(qx + px * w1 * k / 2, qy + py * w1 * k / 2);
      g.lineTo(qx - px * w1 * k / 2, qy - py * w1 * k / 2);
      g.lineTo(ex - px * w0 * k / 2, ey - py * w0 * k / 2);
      g.closePath();
      g.fill();
    };

    // точка, где луч уходит за край кадра: оттуда летят искры
    const exits = [];
    if (len > 0) {
      for (const [ex, ey] of eyes) {
        const tx = nx > 1e-6 ? (W - ex) / nx : nx < -1e-6 ? -ex / nx : Infinity;
        const ty = ny > 1e-6 ? (H - ey) / ny : ny < -1e-6 ? -ey / ny : Infinity;
        const t = Math.min(tx, ty);
        if (t > 0 && t < len) exits.push([ex + nx * t, ey + ny * t]);
      }
    }
    if (L.on && dt > 0) {
      for (const [x, y] of exits) {
        for (let i = 0; i < 3 && L.sparks.length < 180; i++) {
          const a = Math.atan2(-ny, -nx) + (Math.random() - 0.5) * 2.4;
          const v = (180 + Math.random() * 520) * sc;
          L.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 0.3 + Math.random() * 0.35 });
        }
      }
    }

    // 1) мягкое свечение: рисуем в холст 1/4 размера с размытием и растягиваем
    const gw = Math.max(2, Math.round(W / 4)), gh = Math.max(2, Math.round(H / 4));
    const G = glowCanvas(gw, gh);
    const gg = G.getContext('2d');
    gg.setTransform(1, 0, 0, 1, 0, 0);
    gg.clearRect(0, 0, gw, gh);
    gg.setTransform(gw / W, 0, 0, gh / H, 0, 0);
    gg.globalCompositeOperation = 'lighter';
    gg.filter = `blur(${Math.max(1, Math.round(span / 40))}px)`;
    gg.fillStyle = `rgba(${C.glow},0.55)`;
    if (len > 0) for (const [ex, ey] of eyes) quad(gg, ex, ey, 3.4);
    for (const [ex, ey] of eyes) {
      const r = span * (0.32 + front * 0.3) * (0.4 + 0.6 * grow) * flick;
      const rg = gg.createRadialGradient(ex, ey, 0, ex, ey, r);
      rg.addColorStop(0, `rgba(${C.glow},0.9)`);
      rg.addColorStop(1, `rgba(${C.glow},0)`);
      gg.fillStyle = rg;
      gg.fillRect(ex - r, ey - r, r * 2, r * 2);
    }
    for (const [x, y] of exits) {
      const r = span * 0.45 * flick;
      const rg = gg.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `rgba(${C.mid},0.9)`);
      rg.addColorStop(1, `rgba(${C.glow},0)`);
      gg.fillStyle = rg;
      gg.fillRect(x - r, y - r, r * 2, r * 2);
    }
    gg.filter = 'none';

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.drawImage(G, 0, 0, W, H);

    // 2) сами лучи: цветная середина и почти белая сердцевина
    if (len > 0) {
      ctx.fillStyle = `rgba(${C.mid},0.85)`;
      for (const [ex, ey] of eyes) quad(ctx, ex, ey, 1);
      ctx.fillStyle = `rgba(${C.core},0.95)`;
      for (const [ex, ey] of eyes) quad(ctx, ex, ey, 0.38);
    }

    // 3) вспышка в глазу: ядро, лучи-звезда (сильнее, когда смотришь в камеру)
    //    и горизонтальный блик вдоль линии глаз
    const spin = now / 900;
    for (const [ex, ey] of eyes) {
      const r = span * (0.13 + front * 0.09) * (0.5 + 0.5 * grow) * flick;
      const rg = ctx.createRadialGradient(ex, ey, 0, ex, ey, r);
      rg.addColorStop(0, `rgba(${C.core},1)`);
      rg.addColorStop(0.35, `rgba(${C.mid},0.9)`);
      rg.addColorStop(1, `rgba(${C.glow},0)`);
      ctx.fillStyle = rg;
      ctx.fillRect(ex - r, ey - r, r * 2, r * 2);

      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(tilt);
      const sw = span * (0.7 + front * 0.6) * grow, shh = Math.max(1, span * 0.022);
      const lg = ctx.createLinearGradient(-sw, 0, sw, 0);
      lg.addColorStop(0, `rgba(${C.glow},0)`);
      lg.addColorStop(0.5, `rgba(${C.core},0.9)`);
      lg.addColorStop(1, `rgba(${C.glow},0)`);
      ctx.fillStyle = lg;
      ctx.fillRect(-sw, -shh / 2, sw * 2, shh);
      if (front > 0.05) {
        ctx.rotate(spin);
        ctx.fillStyle = `rgba(${C.mid},${0.55 * front})`;
        const rl = span * 0.55 * front * grow * flick, rw = span * 0.03;
        for (let i = 0; i < 6; i++) {
          ctx.rotate(Math.PI / 3);
          ctx.beginPath();
          ctx.moveTo(0, -rw); ctx.lineTo(rl * (i % 2 ? 0.6 : 1), 0); ctx.lineTo(0, rw);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 4) искры
    if (L.sparks.length) {
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.5, 2.6 * sc);
      const keep = [];
      for (const p of L.sparks) {
        p.t += dt;
        if (p.t >= p.life) continue;
        p.vy += 900 * sc * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const k = 1 - p.t / p.life;
        ctx.strokeStyle = `rgba(${k > 0.5 ? C.core : C.mid},${k})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
        ctx.stroke();
        keep.push(p);
      }
      L.sparks = keep;
    }
    ctx.restore();
  }
  window.__memeLasers = (ms = 3000) => startLasers(ms);
  window.__memeLaserState = () => ({ on: L.on, sm: L.sm, frown: L.frown, th: frownTh(), shots: L.shots });

  // Рисуется зеркально: Meet зеркалит превью, у тебя читается нормально
  function drawHud(ctx, W, H, p) {
    if (!hudOn) return;
    const s = ai.s;
    const P = V.plateClean ? 'чистый' : (V.filled ? 'дорисованный' : (V.knownReady ? 'копится' : 'нет'));
    const micState = clap.orig ? (clap.orig.enabled ? clap.peak.toFixed(2) : 'выкл в Meet') : 'нет';
    const lines = [
      `v1.4 #${p.id} ${p.engine} ${p.W}x${p.H} ${p.fps}fps ${p.workMs.toFixed(1)}мс/кадр ИИ:${p.aiSent}/с `
        + `превью:${previewMirror ? 'зеркало' : 'как есть'} окон:${previewWins}`
        + (CFG.enabled ? '' : ' [ВЫКЛ]'),
      `ИИ:${aiOn ? ai.stage : 'выкл'} сегм:${ai.seg ? 'да' : 'нет'} мемов:${ai.fires}`
        + (ai.error ? ` [${ai.error.slice(0, 36)}]` : ''),
      s ? `лицо:${s.face ? 'да' : 'нет'} рот:${s.jaw} глаза:${s.wide} улыбка:${s.smile} `
          + `брови:${s.brow} рука:${s.hand}` : 'оценок пока нет',
      `исчезание:${V.state} фон:${P} в кадре:${Math.round(V.coverage * 100)}% `
        + `маска:${V.mask ? Math.round(performance.now() - V.maskAt) + 'мс' : '-'}`,
      `мик:${micState} ударов:${clap.count} двойных:${clap.doubles} отсеяно:${clap.rejected}`,
      `лазеры:${L.on ? 'ГОРЯТ' : 'нет'} хмурость:${L.frown.toFixed(2)}/${frownTh()} выстрелов:${L.shots}`,
      `свои жесты:${customList.length}` + (s && s.custom
        ? ` ближе всех «${s.custom.name}» ${s.custom.r}${s.custom.hit ? ' ✓' : ''}` : ''),
    ];
    ctx.save();
    if (previewMirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    const fs = Math.max(11, Math.round(H * 0.024));
    ctx.font = `600 ${fs}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const pad = Math.round(fs * 0.5);
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(pad, pad, w + pad * 2, lines.length * (fs + 2) + pad * 2);
    ctx.fillStyle = '#39ff88';
    lines.forEach((l, i) => ctx.fillText(l, pad * 2, pad * 2 + i * (fs + 2)));
    ctx.restore();
  }

  window.__memeDiag = () => {
    console.table([{
      pipe: shared ? shared.id : '-', 'движок': shared ? shared.engine : '-',
      fps: shared ? shared.fps : 0, 'мс/кадр': shared ? +shared.workMs.toFixed(1) : 0,
      'ИИ': ai.stage, 'сегментация': ai.seg, 'исчезание': V.state,
      'фон': V.plateClean ? 'чистый' : (V.filled ? 'дорисованный' : (V.knownReady ? 'копится' : 'нет')),
      'микрофон': clap.orig ? (clap.orig.enabled ? 'слушаю' : 'выкл в Meet') : 'нет',
      'ударов': clap.count, 'двойных': clap.doubles, 'отсеяно': clap.rejected,
    }]);
    return shared ? 1 : 0;
  };

  // =========================================================================
  // Пайплайн камеры
  // =========================================================================
  // Два движка:
  //  'track'  — MediaStreamTrackProcessor → OffscreenCanvas → MediaStreamTrackGenerator.
  //             Кадры идут прямо от камеры, без отрисовки страницы, поэтому
  //             не тормозят, когда вкладка Meet в фоне, и сохраняют метки
  //             времени камеры — кодировщику Meet проще держать ровный темп.
  //  'canvas' — запасной: <video> + requestVideoFrameCallback + captureStream.
  //             Включается в панели («Совместимость») или если браузер не умеет первый.
  function buildPipe(vTrack) {
    const st = vTrack.getSettings() || {};
    const p = {
      id: ++pipeSeq, vTrack,
      deviceId: st.deviceId || 'default',
      W: st.width || 1280, H: st.height || 720,
      alive: true, refs: 0, frames: 0,
      fps: 0, fpsAt: performance.now(), fpsFrom: 0, aiCount: 0, aiSent: 0,
      outTrack: null, engine: 'canvas', gen: null, workMs: 0,
    };

    const canTrack = CFG.engine !== 'canvas'
      && typeof MediaStreamTrackProcessor === 'function'
      && typeof MediaStreamTrackGenerator === 'function'
      && typeof VideoFrame === 'function'
      && typeof OffscreenCanvas === 'function';

    let canvas, ctx, outTrack;
    if (canTrack) {
      canvas = new OffscreenCanvas(p.W, p.H);
      ctx = canvas.getContext('2d', { alpha: false });
      p.gen = new MediaStreamTrackGenerator({ kind: 'video' });
      // Meet получает КЛОН: сам генератор он никогда не остановит, и запись
      // в него не оборвётся, когда Meet при входе в звонок закроет исходный трек
      outTrack = p.gen.clone();
      p.engine = 'track';
    } else {
      canvas = document.createElement('canvas');
      canvas.width = p.W; canvas.height = p.H;
      ctx = canvas.getContext('2d', { alpha: false });
      outTrack = canvas.captureStream(0).getVideoTracks()[0];
    }
    p.outTrack = outTrack;

    const teardown = () => {
      if (!p.alive) return;
      p.alive = false;
      try { vTrack.stop(); } catch (_) {}
      try { if (p.gen) p.gen.stop(); } catch (_) {}
      if (shared === p) shared = null;
      console.log(TAG, `pipe#${p.id} закрыт (кадров: ${p.frames})`);
    };

    // Meet клонирует трек при входе в звонок и закрывает исходный —
    // камеру гасим только когда закрыты ВСЕ выданные треки
    const guard = (track) => {
      ourTracks.add(track);
      const oStop = track.stop.bind(track);
      const oClone = track.clone.bind(track);
      track.stop = () => { oStop(); if (--p.refs <= 0) teardown(); };
      track.clone = () => { p.refs++; return guard(oClone()); };
      if (p.engine === 'track') {
        // Для Meet трек выглядит как камера: те же настройки и возможности.
        track.getSettings = () => Object.assign({}, vTrack.getSettings(), { width: p.W, height: p.H });
        track.getCapabilities = () => (vTrack.getCapabilities ? vTrack.getCapabilities() : {});
        track.getConstraints = () => vTrack.getConstraints();
        // Если Meet просит меньше кадров (слабый компьютер, плохая сеть) —
        // передаём камере: меньше кадров, меньше работы. Разрешение не трогаем,
        // иначе снятый фон сбрасывался бы при каждой подстройке Meet.
        track.applyConstraints = (c) => {
          const fr = c && c.frameRate;
          if (fr) {
            console.log(TAG, 'Meet просит частоту кадров', JSON.stringify(fr));
            return vTrack.applyConstraints({ frameRate: fr }).catch(() => {});
          }
          return Promise.resolve();
        };
      }
      return track;
    };
    guard(outTrack);

    const resize = (w, h) => {
      if (!w || !h || (w === p.W && h === p.H)) return;
      p.W = canvas.width = w; p.H = canvas.height = h;
    };

    const drawMain = (src) => {
      const t0 = performance.now();
      const g = GAINS[gainIdx];
      if (mirror || g !== 1) {
        ctx.save();
        if (mirror) { ctx.translate(p.W, 0); ctx.scale(-1, 1); }
        ctx.filter = g === 1 ? 'none' : `brightness(${g})`;
        ctx.drawImage(src, 0, 0, p.W, p.H);
        ctx.restore();
      } else {
        ctx.drawImage(src, 0, 0, p.W, p.H);
      }

      // --- исчезновение: работаем с «чистым» кадром, до мема и отладки ---
      if (V.begin || V.wantPlate || V.wantAccum || V.state !== 'visible') {
        ensureCanvases(p.W, p.H);
        if (V.state === 'visible') {
          if (V.wantPlate) {
            const first = !V.plateClean;
            captureCleanPlate(canvas, p.W, p.H);
            if (V.wantPlate === 'manual') toast('Фон снят ✓');
            else if (first) toast('Фон снят автоматически ✓ — можно исчезать', 2500);
            V.wantPlate = false;
          }
          if (V.wantAccum && V.mask) accumulatePlate(canvas, p.W, p.H);
          V.wantAccum = false;
        }
        if (V.begin === 'dissolve') startDissolve(canvas, p.W, p.H);
        else if (V.begin === 'form') startForming(canvas, p.W, p.H);
        V.begin = null;
        if (V.state !== 'visible') renderVanish(ctx, p.W, p.H);
      }
      if (V.pending && performance.now() - V.pendingSince > 2500) {
        toast('Маска не пришла — сегментация не отвечает', 3000);
        V.pending = null;
      }

      // мем и отладка не зеркалятся — иначе текст поедет
      drawOverlay(ctx, p.W, p.H);
      drawLasers(ctx, p.W, p.H);
      drawHud(ctx, p.W, p.H, p);

      p.frames++;
      const now = performance.now();
      p.workMs = p.workMs * 0.9 + (now - t0) * 0.1;   // сглаженное время на кадр
      if (now - p.fpsAt >= 1000) {
        p.fps = Math.round((p.frames - p.fpsFrom) * 1000 / (now - p.fpsAt));
        p.aiSent = p.aiCount; p.aiCount = 0;
        p.fpsFrom = p.frames; p.fpsAt = now;
      }
    };

    // ---- кадры детектору ----------------------------------------------------
    // Обычный режим: лицо/руки каждые 150 мс, и раз в ~секунду — маска,
    //   чтобы понять, есть ли кто в кадре (для автоснятия фона).
    // Режим сегментации (исчезновение, подготовка к нему): только маска,
    //   каждые 50 мс — чтобы невидимка не «просвечивал», когда двигается.
    // Если ни лица, ни рук давно не видно — реже (раз в 300 мс): экономия.
    const AI_FPS_MS = 150, AI_IDLE_MS = 300, SEG_MS = 50, AI_W = 256, AI_H = 144;
    let shipping = false, lastShip = 0, lastSeg = 0, shipN = 0, lastMemeShip = 0;

    const shipFrame = async (type, src, fast) => {
      // ждём подтверждения предыдущего кадра (страховка — 1.5 с, вдруг оно потерялось)
      if (shipping || (ai.inflight && performance.now() - ai.inflight < 1500)) return;
      shipping = true;
      // VideoFrame закроется сразу после отрисовки — для детектора берём копию
      const own = (typeof VideoFrame === 'function' && src instanceof VideoFrame) ? src.clone() : null;
      try {
        const bmp = await createImageBitmap(own || src, {
          resizeWidth: AI_W, resizeHeight: AI_H, resizeQuality: 'low',
        });
        ai.inflight = performance.now();
        window.postMessage(
          { __memecam: 1, dir: 'toAI', type, bitmap: bmp, ts: Math.round(performance.now()), sent: Date.now(), fast: !!fast },
          '*', [bmp],
        );
      } catch (_) {
        // кадр пропустим — следующий уйдёт через 50–150 мс
      } finally {
        if (own) own.close();
        shipping = false;
      }
    };

    const maybeShip = (src) => {
      const now = performance.now();
      if (!aiOn || !ai.ready) return;
      const wantFaces = CFG.enabled && (CFG.memesFace || CFG.memesHands || CFG.lasers !== false
        || (CFG.customGestures && customList.length > 0) || recording.active || calib.active);
      const wantSeg = CFG.enabled && CFG.vanish && ai.seg;
      // запись жеста и калибровка важнее подготовки фона
      const busy = recording.active || calib.active;
      // лазеры горят или ты почти нахмурился — глаза нужны часто и без задержки
      const fast = !busy && lasersAllowed() && V.state === 'visible' && (L.on || now - L.warmAt < 1500);
      const segMode = wantSeg && (V.state !== 'visible' || V.pending !== null || (now < V.segUntil && !busy && !fast));
      if (segMode) {
        if (now - lastSeg >= SEG_MS) { lastSeg = now; p.aiCount++; shipFrame('seg', src); }
        return;
      }
      const idle = !busy && !fast && now - ai.lastSeen > 4000;
      if (now - lastShip < (busy || fast ? 60 : idle ? AI_IDLE_MS : AI_FPS_MS)) return;
      // раз в ~секунду — маска: есть ли кто в кадре (для автоснятия фона);
      // остальное — лицо и руки, но не пока мем на экране
      const sampleSeg = wantSeg && !busy && !fast && (++shipN % 7 === 0);   // при записи и калибровке маска не нужна
      lastShip = now;
      if (sampleSeg) { p.aiCount++; shipFrame('seg', src); }
      else if (wantFaces && (state.key === null || busy || fast)) { p.aiCount++; shipFrame('frame', src, fast); }
      else if (state.key !== null && lasersAllowed() && now - lastMemeShip >= AI_IDLE_MS) {
        // пока висит мем, руки не нужны, но глаза — да: иначе лазеры не загорятся
        lastMemeShip = now; p.aiCount++; shipFrame('frame', src, true);
      }
    };

    if (p.engine === 'track') {
      // ---- движок 'track' --------------------------------------------------
      const reader = new MediaStreamTrackProcessor({ track: vTrack, maxBufferSize: 2 }).readable.getReader();
      const writer = p.gen.writable.getWriter();
      let warned = false;
      (async () => {
        try {
          while (p.alive) {
            const { value: frame, done } = await reader.read();
            if (done) break;
            let out = null;
            try {
              resize(frame.displayWidth, frame.displayHeight);
              drawMain(frame);
              maybeShip(frame);
              out = new VideoFrame(canvas, { timestamp: frame.timestamp });
            } catch (e) {
              if (!warned) { console.warn(TAG, 'кадр не собрался', e); warned = true; }
            } finally {
              frame.close();
            }
            if (out) {
              try { await writer.write(out); }      // генератор сам закроет кадр
              catch (_) { try { out.close(); } catch (__) {} if (!p.alive) break; }
            }
          }
        } catch (e) {
          console.warn(TAG, 'конвейер остановился', e);
        }
        try { reader.releaseLock(); } catch (_) {}
        try { writer.releaseLock(); } catch (_) {}
      })();
    } else {
      // ---- движок 'canvas' (запасной) --------------------------------------
      const video = document.createElement('video');
      video.autoplay = true; video.muted = true; video.playsInline = true;
      video.srcObject = new MediaStream([vTrack]);
      Object.assign(video.style, {
        position: 'fixed', top: '-10000px', left: '0',
        width: '2px', height: '2px', opacity: '0', pointerEvents: 'none',
      });
      document.documentElement.appendChild(video);
      video.play().catch((e) => console.warn(TAG, 'video.play()', e));
      const keep = setInterval(() => {
        if (!p.alive) { clearInterval(keep); video.remove(); return; }
        if (!video.isConnected) { document.documentElement.appendChild(video); video.play().catch(() => {}); }
        if (video.paused) video.play().catch(() => {});
      }, 1000);

      const stepV = () => {
        if (!p.alive) return;
        if (video.readyState >= 2 && video.videoWidth) {
          resize(video.videoWidth, video.videoHeight);
          drawMain(video);
          maybeShip(video);
          if (outTrack.requestFrame) outTrack.requestFrame();
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(stepV);
        else requestAnimationFrame(stepV);
      };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(stepV);
      else requestAnimationFrame(stepV);
    }

    vTrack.addEventListener('ended', teardown);
    console.log(TAG, `pipe#${p.id} готов ${p.W}x${p.H}, движок: ${p.engine}`);
    return p;
  }


  // =========================================================================
  // Свои картинки и GIF
  // =========================================================================
  // Приходят из панели через мост как байты файла. GIF и анимированный WebP
  // раскладываются на кадры через ImageDecoder (WebCodecs) — заранее, один
  // раз: в кадре звонка остаётся только выбрать нужный кадр по времени.
  // Каждая сторона — не больше 480 px, и не больше 150 кадров: память.
  const MEDIA = Object.create(null);    // key → { frames: [{ bmp, dur }], total }
  const MAX_SIDE = 480, MAX_FRAMES = 150;

  const fit = (w, h) => {
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    return { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)) };
  };
  function freeMedia(key) {
    const m = MEDIA[key];
    if (m) { for (const f of m.frames) try { f.bmp.close(); } catch (_) {} delete MEDIA[key]; }
  }
  async function decodeMedia(key, item) {
    const bytes = new Uint8Array(item.buf);
    const frames = [];
    if (typeof ImageDecoder === 'function' && await ImageDecoder.isTypeSupported(item.type)) {
      const dec = new ImageDecoder({ data: bytes, type: item.type });
      await dec.tracks.ready;
      const tr = dec.tracks.selectedTrack;
      const n = Math.max(1, Math.min(tr ? tr.frameCount : 1, MAX_FRAMES));
      for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const bmp = await createImageBitmap(image, fit(image.displayWidth, image.displayHeight));
        frames.push({ bmp, dur: n > 1 ? Math.max(20, (image.duration || 100000) / 1000) : Infinity });
        image.close();
      }
      dec.close();
    } else {
      const raw = await createImageBitmap(new Blob([bytes], { type: item.type }));
      const bmp = await createImageBitmap(raw, fit(raw.width, raw.height));
      raw.close();
      frames.push({ bmp, dur: Infinity });
    }
    const total = frames.length > 1 ? frames.reduce((s, f) => s + f.dur, 0) : 0;
    freeMedia(key);
    MEDIA[key] = { frames, total };
  }
  async function applyMedia(items) {
    for (const key of Object.keys(MEDIA)) if (!items[key]) freeMedia(key);
    for (const [key, item] of Object.entries(items)) {
      try { await decodeMedia(key, item); }
      catch (e) { console.warn(TAG, 'картинка не открылась:', key, e); }
    }
    console.log(TAG, 'своих картинок:', Object.keys(MEDIA).length);
  }

  // =========================================================================
  // Свои жесты — в списке мемов как 'g_<id>'
  // =========================================================================
  const CUSTOM_COLORS = ['#7c5cff', '#ff4fa3', '#00b8d9', '#ff8a00', '#2ecc71', '#e74c3c'];
  let customList = [];
  function applyGestures(list) {
    for (const k of Object.keys(MEMES)) if (k.startsWith('g_')) delete MEMES[k];
    customList = list || [];
    customList.forEach((g, i) => {
      MEMES['g_' + g.id] = {
        emoji: g.emoji || '✨',
        text: (g.name || 'Жест').toUpperCase(),
        color: CUSTOM_COLORS[i % CUSTOM_COLORS.length],
      };
    });
  }

  const toAI = (msg) => window.postMessage({ __memecam: 1, dir: 'toAI', ...msg }, '*');

  // Запись своего жеста: отсчёт 3-2-1, потом 3 секунды держишь жест.
  // Детектор в это время смотрит только на руку, каждый кадр.
  function runRecord(arg) {
    if (!ai.ready) { toast('ИИ ещё грузится — секунду'); return; }
    if (recording.active || calib.active) return;
    const id = arg && arg.id, name = (arg && arg.name) || 'жест';
    if (!id) return;
    Object.assign(recording, { active: true, id, phase: 'countdown', result: null });
    let n = 3;
    const tick = () => {
      if (n > 0) { toast(`Покажи «${name}» в камеру… ${n}`, 1100); n--; setTimeout(tick, 1000); return; }
      recording.phase = 'rec';
      toast(`Записываю «${name}» — держи и чуть поворачивай кисть`, 3200);
      toAI({ type: 'record', id, ms: 3000 });
      setTimeout(() => {
        if (recording.active && recording.id === id) {
          recording.active = false;
          recording.result = { id, ok: false, n: 0 };
          toast('Запись не завершилась — детектор не ответил', 3500);
        }
      }, 6500);
    };
    tick();
  }
  function onRecorded(d) {
    if (!recording.active || d.id !== recording.id) return;
    recording.active = false;
    const n = (d.samples || []).length;
    if (n < 10) {
      recording.result = { id: d.id, ok: false, n };
      toast(`Рука почти не видна (${n} кадров). Поднеси ближе к камере, при свете`, 4500);
      return;
    }
    toBridge({ type: 'saveGesture', id: d.id, samples: d.samples });
    recording.result = { id: d.id, ok: true, n };
    toast(`Запомнил ✓ ${n} примеров. Покажи жест — сработает мем`, 3500);
  }

  // Калибровка мимики: 4 шага по ~3 секунды. На каждом — свои оценки, порог
  // ставится между «спокойным лицом» и «гримасой»: 45% пути от первого ко второму.
  const CAL_STEPS = [
    { k: 'neutral', say: 'Сиди спокойно, лицо расслаблено' },
    { k: 'shock',   say: 'Удивись: открой рот и широко глаза 😱' },
    { k: 'smile',   say: 'Широко улыбнись 😂' },
    { k: 'brow',    say: 'Подними брови 🤨' },
    { k: 'frown',   say: 'Нахмурься, как злодей' },
  ];
  function runCalibration() {
    if (!ai.ready) { toast('ИИ ещё грузится — секунду'); return; }
    if (calib.active || recording.active) return;
    Object.assign(calib, { active: true, data: {}, phase: null, step: 0, result: null });
    toAI({ type: 'calib', on: true });
    let i = 0;
    const next = () => {
      if (i >= CAL_STEPS.length) {
        calib.phase = null; calib.active = false;
        toAI({ type: 'calib', on: false });
        finishCalibration();
        return;
      }
      const st = CAL_STEPS[i++];
      calib.step = i;
      calib.phase = null;
      toast(`${i}/${CAL_STEPS.length} · ${st.say}`, 3300);
      setTimeout(() => { calib.phase = st.k; calib.data[st.k] = []; }, 1200);   // время принять выражение
      setTimeout(next, 3300);
    };
    next();
  }
  function onCalibSample(d) {
    if (calib.active && calib.phase && d.seen) calib.data[calib.phase].push(d);
  }
  const pct = (arr, q) => {
    const a = arr.slice().sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))] : NaN;
  };
  function finishCalibration() {
    const D = calib.data, N = D.neutral || [];
    if (N.length < 5) {
      calib.result = { ok: false, why: 'лицо не видно' };
      toast('Лицо не видно — калибровка не удалась. Сядь к свету', 4000);
      return;
    }
    const th = {}, report = [];
    const one = (metric, phase, key, label) => {
      const base = pct(N.map((x) => x[metric]), 0.9);
      const P = D[phase] || [];
      const peak = pct(P.map((x) => x[metric]), 0.5);
      if (P.length >= 5 && peak > base + 0.08) {
        th[key] = +(base + 0.45 * (peak - base)).toFixed(3);
        report.push({ label, ok: true, base: +base.toFixed(2), peak: +peak.toFixed(2), thr: th[key] });
      } else {
        report.push({ label, ok: false, base: +(base || 0).toFixed(2), peak: +(peak || 0).toFixed(2) });
      }
    };
    one('jaw', 'shock', 'jawOpen', 'рот (шок)');
    one('wide', 'shock', 'eyeWide', 'глаза (шок)');
    one('smile', 'smile', 'smile', 'улыбка');
    one('brow', 'brow', 'browUp', 'брови');
    one('frown', 'frown', 'browDown', 'хмурость (лазеры)');
    // глаза при удивлении у многих расширяются слабо — тогда условие по глазам
    // ставим так, чтобы большинство «удивлённых» кадров проходили
    if (!('eyeWide' in th) && 'jawOpen' in th && (D.shock || []).length >= 5) {
      th.eyeWide = +Math.max(0.01, pct(D.shock.map((x) => x.wide), 0.3)).toFixed(3);
    }
    const ok = Object.keys(th).length;
    if (ok) toBridge({ type: 'saveTh', th });
    calib.result = { ok: ok > 0, report, th };
    toast(ok ? `Калибровка готова ✓ ${report.filter((r) => r.ok).length} из ${report.length} выражений` +
      ' — пороги подстроены под тебя' : 'Не удалось различить выражения — пороги не менялись', 4000);
  }

  // =========================================================================
  // Настройки, команды и статус — связь с popup через мост (detector.js)
  // =========================================================================
  const toBridge = (msg) => window.postMessage({ __memecam: 1, dir: 'toBridge', ...msg }, '*');
  const saveSetting = (patch) => toBridge({ type: 'save', patch });

  function applySettings(s) {
    const wasEnabled = CFG.enabled, wasVanish = CFG.vanish;
    Object.assign(CFG, s);
    CFG.memes = Object.assign({}, s.memes || {});
    CFG.captions = Object.assign({}, s.captions || {});
    DUST.size = Math.max(2, Math.min(16, +CFG.dustSize || 4));
    CLAP.minPeak = { low: 0.42, normal: 0.28, high: 0.17 }[CFG.clapSensitivity] || 0.28;
    previewMirror = CFG.previewMirror !== false;
    hudOn = !!CFG.hud;

    // выключили, пока ты невидимка — возвращаем сразу, без анимации
    if ((!CFG.enabled || !CFG.vanish) && (wasEnabled && wasVanish) && V.state !== 'visible') {
      V.state = 'visible'; V.P = null; V.snapPx = null; V.pending = null;
      toast('Исчезновение выключено — ты снова в кадре');
    }
    if (!CFG.enabled) state.key = null;
    if (!lasersAllowed()) stopLasers();
    syncPreviewMirror();
    console.log(TAG, 'настройки:', JSON.stringify(CFG));
  }

  function runCommand(cmd, arg) {
    if (cmd === 'vanish') toggleVanish('кнопка');
    else if (cmd === 'plate') countdownPlate();
    else if (cmd === 'meme' && CFG.enabled && MEMES[arg]) fire(arg);
    else if (cmd === 'record') runRecord(arg);
    else if (cmd === 'calibrate') runCalibration();
    else if (cmd === 'lasers') { if (L.on) stopLasers(); else startLasers(3000); }
  }

  // Отражено ли окошко сейчас: учитываем transform и scale у самого <video>
  // и у всех предков — Meet может зеркалить на любом уровне.
  // Наш собственный scale на самом <video> не считаем.
  function isFlipped(el) {
    let flips = 0;
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 40; n = n.parentElement, depth++) {
      const cs = getComputedStyle(n);
      const tr = cs.transform;
      if (tr && tr !== 'none') {
        const m = tr.match(/matrix(3d)?\(([^)]+)\)/);
        if (m) {
          const v = m[2].split(',').map(Number);
          const det = m[1] ? v[0] * v[5] - v[1] * v[4] : v[0] * v[3] - v[1] * v[2];
          if (det < 0) flips++;
        }
      }
      if (n !== el && cs.scale && cs.scale !== 'none') {
        const q = cs.scale.split(' ').map(parseFloat);
        if (q[0] * (q.length > 1 ? q[1] : q[0]) < 0) flips++;
      }
    }
    return flips % 2 === 1;
  }

  // Находим окошки Meet с нашим потоком и доводим их до нужного состояния
  // CSS-свойством scale: оно не затирает transform, который ставит Meet,
  // а складывается с ним. Это чисто отображение — в сеть не уходит.
  function syncPreviewMirror() {
    if (document.hidden) return;   // окошек всё равно не видно
    let n = 0;
    for (const v of document.querySelectorAll('video')) {
      const so = v.srcObject;
      if (!(so instanceof MediaStream)) continue;
      if (!so.getVideoTracks().some((t) => ourTracks.has(t))) continue;
      n++;
      const need = isFlipped(v) !== previewMirror;
      const has = v.style.scale === '-1 1';
      if (need !== has) v.style.scale = need ? '-1 1' : '';
    }
    previewWins = n;
  }
  setInterval(syncPreviewMirror, 700);

  // статус для popup — раз в секунду
  setInterval(() => {
    toBridge({
      type: 'state',
      state: {
        camera: !!(shared && shared.alive),
        fps: shared ? shared.fps : 0,
        engine: shared ? shared.engine : null,
        workMs: shared ? +shared.workMs.toFixed(1) : 0,
        ai: ai.stage, aiError: ai.error, seg: ai.seg,
        mic: clap.orig ? (clap.orig.enabled ? 'on' : 'muted') : 'none',
        plate: V.plateClean ? 'clean' : ((V.filled || V.knownReady) ? 'filled' : 'none'),
        vanish: V.state,
        memes: ai.fires, claps: clap.doubles,
        previewWins,
        custom: ai.s ? ai.s.custom : null,
        hand: ai.s ? ai.s.hand : null,
        recording: { active: recording.active, phase: recording.phase, id: recording.id, result: recording.result },
        calib: { active: calib.active, step: calib.step, total: CAL_STEPS.length, result: calib.result },
        media: Object.keys(MEDIA).length,
        lasers: { on: L.on, frown: +L.frown.toFixed(2), th: frownTh(), shots: L.shots,
          face: performance.now() - L.seenAt < 2000, learning: !(CFG.th && CFG.th.browDown) && FROWN_HIST.length < 12 },
      },
    });
  }, 1000);
  toBridge({ type: 'hello' });

  // =========================================================================
  // Хук getUserMedia
  // =========================================================================
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);

  const wantedDeviceId = (c) => {
    const v = c && c.video;
    if (!v || typeof v !== 'object' || !v.deviceId) return null;
    const d = v.deviceId;
    return typeof d === 'string' ? d : (d.exact || d.ideal || null);
  };

  md.getUserMedia = async function (constraints) {
    // только звук: отдаём как есть, но подслушиваем хлопки
    if (!constraints || !constraints.video) {
      const s = await orig(constraints);
      try { attachMic(s.getAudioTracks()[0]); } catch (_) {}
      return s;
    }
    try {
      const want = wantedDeviceId(constraints);
      if (shared && shared.alive && want && want !== shared.deviceId) {
        try { shared.vTrack.stop(); } catch (_) {}
        shared = null;
      }
      if (!shared || !shared.alive) {
        const real = await orig(constraints);
        const vTrack = real.getVideoTracks()[0];
        if (!vTrack) return real;
        shared = buildPipe(vTrack);
        const o = new MediaStream([shared.outTrack]);
        shared.refs = 1;
        real.getAudioTracks().forEach((t) => o.addTrack(t));
        attachMic(real.getAudioTracks()[0]);
        return o;
      }
      // камера уже открыта — отдаём клон, железо второй раз не трогаем
      const o = new MediaStream([shared.outTrack.clone()]);
      if (constraints.audio) {
        const a = await orig({ audio: constraints.audio });
        a.getAudioTracks().forEach((t) => o.addTrack(t));
        attachMic(a.getAudioTracks()[0]);
      }
      return o;
    } catch (err) {
      console.warn(TAG, 'хук упал, отдаю оригинал', err);
      return orig(constraints);
    }
  };

  console.log(TAG, 'v1.2 готов. Ctrl+Shift+V — исчезнуть, +P — снять фон, +H — отладка.');
})();
