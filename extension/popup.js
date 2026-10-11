/*
 * popup.js — панель управления Meme Cam
 * ---------------------------------------------------------------------------
 * Настройки — chrome.storage.sync, свои картинки и жесты — chrome.storage.local.
 * Мост в Meet подхватывает изменения сразу, перезагружать вкладку не нужно.
 * Статус и команды — через chrome.tabs.sendMessage в мост активной вкладки.
 */
(() => {
  'use strict';
  const S = globalThis.MemeCamSettings;
  const $ = (id) => document.getElementById(id);
  const byKey = Object.fromEntries(S.MEMES.map((m) => [m.key, m]));

  let st = S.merge(null);
  let images = {};          // key → { type, b64, name }
  let gestures = [];        // [{ id, name, emoji, samples }]
  let tabId = null;
  let link = { ok: false, state: null };
  let selKey = 'shock';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const imgSrc = (it) => `data:${it.type};base64,${it.b64}`;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    rec: 'M8 3.5v9M3.5 8h9',
    pic: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3',
    del: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  };
  const icon = (name) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  };

  // ===================== сохранение =====================
  let saveTimer = 0, pending = {};
  function save(patch, delay = 0) {
    const next = Object.assign({}, st, patch);
    for (const k of ['memes', 'captions']) if (patch[k]) next[k] = Object.assign({}, st[k], patch[k]);
    st = next;
    pending = Object.assign({}, pending, patch);
    for (const k of ['memes', 'captions']) {
      if (patch[k]) pending[k] = Object.assign({}, (pending[k] || {}), patch[k]);
    }
    clearTimeout(saveTimer);
    // ползунок и поля ввода пишем с задержкой: у storage.sync лимит записей в минуту
    saveTimer = setTimeout(() => { const p = pending; pending = {}; S.save(p); }, delay);
    render();
  }

  // ===================== вкладки =====================
  const tabs = [...document.querySelectorAll('.tabs button')];
  function showTab(name) {
    for (const b of tabs) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $(`p-${b.dataset.tab}`).hidden = !on;
    }
    try { localStorage.setItem('memecam.tab', name); } catch (_) {}
    // анимация превью крутится только на вкладке «Пепел»: панель живёт в одном
    // процессе с детектором, и лишний requestAnimationFrame отнимает у него время
    if (name === 'vanish') {
      fitCanvas(); buildDust();
      if (!animOn) { animOn = true; requestAnimationFrame(frame); }
    } else animOn = false;
    if (name === 'lasers') {
      fitLaser();
      if (!laserOn) { laserOn = true; requestAnimationFrame(laserFrame); }
    } else laserOn = false;
  }
  for (const b of tabs) {
    b.addEventListener('click', () => showTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1);
      const nx = tabs[(i + tabs.length) % tabs.length];
      nx.focus(); showTab(nx.dataset.tab);
    });
  }

  // ===================== картинки: чтение файла =====================
  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  async function readImage(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error('файл больше 8 МБ');
    const buf = new Uint8Array(await file.arrayBuffer());
    let frames = 1;
    if (typeof ImageDecoder === 'function' && /gif|webp/.test(file.type)) {
      try {
        const dec = new ImageDecoder({ data: buf, type: file.type });
        await dec.tracks.ready;
        frames = dec.tracks.selectedTrack ? dec.tracks.selectedTrack.frameCount : 1;
        dec.close();
      } catch (_) {}
    }
    if (frames > 1) {
      // анимацию храним как есть: пересжать GIF в браузере без потерь не выйдет
      if (file.size > 5 * 1024 * 1024) throw new Error('анимация больше 5 МБ');
      return { type: file.type, b64: toB64(buf), name: file.name };
    }
    // статичную — уменьшаем до 512 px и в WebP: прозрачность сохраняется
    const bmp = await createImageBitmap(new Blob([buf], { type: file.type }));
    const k = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.92 });
    return { type: 'image/webp', b64: toB64(new Uint8Array(await blob.arrayBuffer())), name: file.name };
  }

  let uploadKey = null;
  $('file').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f || !uploadKey) return;
    const key = uploadKey;
    try {
      const it = await readImage(f);
      images = Object.assign({}, images, { [key]: it });
      await S.setLocal('memeImages', images);
      flash(key.startsWith('g_') ? 'gNote' : null, `Сохранил «${f.name}»`);
    } catch (e) {
      flash(key.startsWith('g_') ? 'gNote' : null, `Не получилось: ${e.message || e}`);
    }
    render();
  });
  const pickFile = (key) => { uploadKey = key; $('file').click(); };

  // временное сообщение в строке-подсказке
  function flash(id, text) {
    const n = id ? $(id) : $('edHow');
    if (!n) return;
    n.dataset.flash = '1';
    n.textContent = text;
    clearTimeout(n._t);
    n._t = setTimeout(() => { delete n.dataset.flash; render(); }, 2600);
  }

  // ===================== мемы =====================
  const chips = $('chips');
  S.MEMES.forEach((m, i) => {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.key = m.key;
    b.setAttribute('role', 'option');
    b.append(el('span', 'n', String(i + 1).padStart(2, '0')), el('span', 'e'), el('span', 'l', m.label));
    b.title = `${m.how} · двойной клик — вкл/выкл`;
    b.addEventListener('click', () => { selKey = m.key; render(); });
    b.addEventListener('dblclick', () => save({ memes: { [m.key]: st.memes[m.key] === false } }));
    chips.append(b);
  });
  // Перерисовываем ячейку, только если картинка или эмодзи поменялись: панель
  // обновляется раз в секунду, а декодировать base64 заново каждый раз — лишняя
  // работа в том же процессе, где крутится детектор.
  const fillEmoji = (box, key, emoji) => {
    const it = images[key];
    const sig = it ? `${it.type}:${it.b64.length}:${it.b64.slice(-24)}` : `e:${emoji}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (it) {
      const i = el('img');
      i.src = imgSrc(images[key]);
      i.alt = '';
      box.append(i);
    } else box.textContent = emoji;
  };

  $('edOn').addEventListener('change', (e) => save({ memes: { [selKey]: e.target.checked } }));
  $('edCaption').addEventListener('input', (e) => save({ captions: { [selKey]: e.target.value } }, 500));
  $('edUpload').addEventListener('click', () => pickFile(selKey));
  $('edReset').addEventListener('click', async () => {
    const next = Object.assign({}, images);
    delete next[selKey];
    images = next;
    await S.setLocal('memeImages', images);
    const caps = Object.assign({}, st.captions);
    delete caps[selKey];
    st = Object.assign({}, st, { captions: caps });
    // captions сливаются при сохранении — поэтому сначала пустой объект, потом новый
    const cur = await S.load();
    cur.captions = caps;
    await chrome.storage.sync.set({ settings: S.merge(cur) });
    render();
  });
  $('edTest').addEventListener('click', () => cmd('meme', selKey));

  function renderMemes() {
    for (const b of chips.children) {
      const m = byKey[b.dataset.key];
      const on = st.memes[m.key] !== false;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-selected', String(m.key === selKey));
      b.classList.toggle('sel', m.key === selKey);
      b.classList.toggle('dim', !(m.kind === 'face' ? st.memesFace : st.memesHands));
      fillEmoji(b.querySelector('.e'), m.key, m.emoji);
    }
    const m = byKey[selKey];
    fillEmoji($('edThumb'), m.key, m.emoji);
    $('edTitle').textContent = m.label;
    if (!$('edHow').dataset.flash) {
      $('edHow').textContent = `${m.kind === 'face' ? 'лицо' : 'рука'} · ${m.how}`
        + (images[m.key] ? ' · своя картинка' : '');
    }
    $('edOn').checked = st.memes[m.key] !== false;
    const cap = $('edCaption');
    cap.placeholder = m.label.toUpperCase();
    if (document.activeElement !== cap) cap.value = st.captions[m.key] ?? '';
    $('edReset').disabled = !images[m.key] && !(m.key in st.captions);
    $('edTest').disabled = !link.ok || !st.enabled;
  }

  // ===================== свои жесты =====================
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  async function saveGestures(list) {
    gestures = list;
    await S.setLocal('customGestures', list);
    render();
  }

  $('gAdd').addEventListener('click', async () => {
    const name = $('gName').value.trim();
    const emoji = $('gEmoji').value.trim() || '✨';
    if (!name) { $('gName').focus(); flash('gNote', 'Сначала название.'); return; }
    const g = { id: newId(), name, emoji, samples: [] };
    await saveGestures(gestures.concat(g));
    $('gName').value = '';
    cmd('record', { id: g.id, name: g.name });
  });
  $('gName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gAdd').click(); });

  let glistSig = '';
  function renderGestures() {
    const ul = $('glist');
    const s = link.state || {};
    const live = s.custom;
    const sig = JSON.stringify([gestures.map((g) => [g.id, g.name, g.emoji, (g.samples || []).length]),
      Object.keys(images).filter((k) => k.startsWith('g_')).map((k) => k + images[k].b64.length),
      live && live.hit ? live.id : null, link.ok]);
    const rebuild = sig !== glistSig;
    glistSig = sig;
    if (rebuild) ul.textContent = '';
    if (rebuild && !gestures.length) ul.append(el('li', 'empty', 'Пока нет своих жестов'));
    (rebuild ? gestures : []).forEach((g, idx) => {
      const li = el('li');
      if (live && live.hit && live.id === g.id) li.classList.add('now');
      const ge = el('div', 'ge');
      fillEmoji(ge, 'g_' + g.id, g.emoji || '✨');
      const n = (g.samples || []).length;
      const gt = el('div', 'gt');
      const samp = el('div', 'samp' + (n < 10 ? ' low' : ''));
      const dots = el('span', 'dots');
      const lit = Math.min(12, Math.round((n / 60) * 12));
      for (let k = 0; k < 12; k++) dots.append(el('i', k < lit ? 'on' : null));
      samp.append(dots, el('span', null, n < 10 ? `${n} · мало` : String(n)));
      if (images['g_' + g.id]) samp.append(el('span', null, '· своя'));
      gt.append(el('b', null, g.name), samp);
      const acts = el('div', 'acts');
      const more = el('button', 'ib');
      more.append(icon('rec'));
      more.title = 'Дописать примеры';
      more.setAttribute('aria-label', 'Дописать примеры');
      more.disabled = !link.ok;
      more.addEventListener('click', () => cmd('record', { id: g.id, name: g.name }));
      const pic = el('button', 'ib');
      pic.append(icon('pic'));
      pic.title = 'Своя картинка или GIF';
      pic.setAttribute('aria-label', 'Своя картинка или GIF');
      pic.addEventListener('click', () => pickFile('g_' + g.id));
      const del = el('button', 'ib');
      del.append(icon('del'));
      del.title = 'Удалить — нажми ещё раз';
      del.setAttribute('aria-label', 'Удалить');
      del.addEventListener('click', async () => {
        if (!del.classList.contains('arm')) {
          del.classList.add('arm');
          setTimeout(() => del.classList.remove('arm'), 2500);
          return;
        }
        const img = Object.assign({}, images);
        delete img['g_' + g.id];
        images = img;
        await S.setLocal('memeImages', images);
        await saveGestures(gestures.filter((x) => x.id !== g.id));
      });
      acts.append(more, pic, del);
      li.append(el('span', 'gi', String(idx + 1).padStart(2, '0')), ge, gt, acts);
      ul.append(li);
    });

    // живой индикатор: что детектор видит прямо сейчас
    const L = $('live');
    const hit = !!(live && live.hit);
    let now, lit = 0;
    if (!link.ok) now = 'нет вкладки Meet';
    else if (!gestures.length) now = 'нечего узнавать';
    else if (live) {
      now = hit ? live.name : `${live.name}?`;
      lit = Math.round(Math.max(0, Math.min(1, (1.6 - live.r) / 1.6)) * 20);
    } else now = s.hand && s.hand !== '-' ? 'незнакомый жест' : 'руки нет';
    if (!L.firstChild) {
      const top = el('div', 'top');
      top.append(el('span', 'lbl', 'Вижу'), el('span', 'now'));
      const meter = el('div', 'meter');
      for (let k = 0; k < 20; k++) meter.append(el('i'));
      L.append(top, meter);
    }
    L.classList.toggle('hit', hit);
    L.querySelector('.now').textContent = now;
    [...L.querySelector('.meter').children].forEach((d, k) => d.classList.toggle('on', k < lit));

    // запись
    const r = s.recording || {};
    const note = $('gNote');
    if (!note.dataset.flash) {
      const rg = gestures.find((x) => x.id === r.id);
      if (r.active && r.phase === 'countdown') note.textContent = `Сейчас запишу «${rg ? rg.name : 'жест'}». Готовь руку.`;
      else if (r.active) note.textContent = 'Пишу. Держи жест и понемногу крути кисть.';
      else if (r.result && r.result.ok) note.textContent = `Запомнил, ${r.result.n} примеров. Покажи жест в камеру.`;
      else if (r.result && !r.result.ok) note.textContent = `Руку почти не видно (${r.result.n} кадров). Нажми + и запиши ещё раз.`;
      else note.textContent = 'Запись идёт 4 секунды. Покрути кисть, тогда жест узнается под любым углом.';
    }
    $('gAdd').disabled = !link.ok || !st.enabled || !!r.active;
    $('customGestures').checked = st.customGestures !== false;
  }

  // ===================== ещё: калибровка, вид, совместимость =====================
  $('btnCalib').addEventListener('click', () => cmd('calibrate'));
  $('engineCanvas').addEventListener('change', (e) => save({ engine: e.target.checked ? 'canvas' : 'auto' }));

  function renderMore() {
    const s = link.state || {};
    const c = s.calib || {};
    const box = $('calib');
    $('btnCalib').disabled = !link.ok || !st.enabled || !!c.active;
    if (c.active) {
      box.textContent = '';
      const steps = el('div', 'steps');
      const cur = c.step || 1, total = c.total || 5;
      for (let k = 1; k <= total; k++) steps.append(el('i', k < cur ? 'done' : k === cur ? 'cur' : null, String(k)));
      const say = ['Сиди спокойно', 'Удивись', 'Улыбнись', 'Подними брови', 'Нахмурься'][cur - 1] || 'Следи за окном Meet';
      box.append(steps, el('div', null, say + '. Подсказки в окне Meet.'));
    } else if (c.result && !c.result.report) {
      box.textContent = '';
      box.append(el('div', 'bad', `Не вышло: ${c.result.why || 'лицо не видно'}.`), el('div', null, 'Сядь ближе к свету и начни заново.'));
    } else if (c.result && c.result.report) {
      box.textContent = '';
      const t = el('table');
      for (const r of c.result.report) {
        const tr = el('tr');
        tr.append(el('td', null, r.label));
        tr.append(el('td', r.ok ? null : 'bad', r.ok ? `${r.base} → ${r.peak} · порог ${r.thr}` : 'не различил'));
        t.append(tr);
      }
      box.append(t);
    } else {
      const th = st.th || {};
      const names = { jawOpen: 'рот', eyeWide: 'глаза', smile: 'улыбка', browUp: 'брови', browDown: 'хмурость' };
      box.textContent = Object.keys(th).length
        ? `Подстроено под тебя: ${Object.entries(th).map(([k, v]) => `${names[k] || k} ${v}`).join(' · ')}`
        : 'Пять шагов по 3 секунды. Если мимика или лазеры срабатывают не вовремя.';
    }
    $('engineCanvas').checked = st.engine === 'canvas';
    const eng = s.engine;
    $('engineNote').textContent = !eng ? 'Если в звонке что-то не так'
      : (st.engine === 'canvas') === (eng === 'canvas')
        ? (eng === 'track' ? 'Сейчас новый, он не тормозит в фоне' : 'Сейчас старый')
        : 'Сработает после перезапуска камеры в Meet';
  }

  // ===================== общие переключатели =====================
  for (const k of ['enabled', 'memesFace', 'memesHands', 'vanish', 'previewMirror', 'hud', 'customGestures', 'lasers']) {
    $(k).addEventListener('change', (ev) => save({ [k]: ev.target.checked }));
  }
  $('dustSize').addEventListener('input', (ev) => { save({ dustSize: +ev.target.value }, 350); buildDust(); });
  for (const b of $('clapSensitivity').children) {
    b.addEventListener('click', () => save({ clapSensitivity: b.dataset.v }));
  }
  for (const b of $('laserColor').children) {
    b.addEventListener('click', () => save({ laserColor: b.dataset.v }));
  }
  $('btnLasers').addEventListener('click', () => cmd('lasers'));
  $('btnLaserCalib').addEventListener('click', () => { cmd('calibrate'); showTab('more'); });

  function render() {
    document.body.classList.toggle('off', !st.enabled);
    for (const k of ['enabled', 'memesFace', 'memesHands', 'vanish', 'previewMirror', 'hud']) $(k).checked = !!st[k];
    const r = $('dustSize');
    r.value = st.dustSize;
    r.style.setProperty('--p', `${((st.dustSize - r.min) / (r.max - r.min)) * 100}%`);
    $('dustOut').textContent = `${st.dustSize} px`;
    for (const b of $('clapSensitivity').children) {
      b.setAttribute('aria-checked', String(b.dataset.v === st.clapSensitivity));
    }
    $('vanishBody').classList.toggle('dim', !st.vanish);
    $('lasers').checked = st.lasers !== false;
    for (const b of $('laserColor').children) {
      b.setAttribute('aria-checked', String(b.dataset.v === (st.laserColor || 'red')));
    }
    $('lasersBody').classList.toggle('dim', st.lasers === false);
    renderMemes();
    renderGestures();
    renderMore();
    renderLink();
  }

  function pill(k, s, text, title) {
    const li = document.querySelector(`#status li[data-k="${k}"]`);
    li.dataset.s = s;
    li.querySelector('span').textContent = text;
    li.title = title || '';
  }

  function renderLink() {
    const { ok, state } = link;
    const s = state || {};
    if (!ok) {
      $('sub').textContent = 'нет вкладки Meet';
      for (const k of ['camera', 'ai', 'mic', 'plate']) pill(k, 'off', '—');
    } else {
      $('sub').textContent = !st.enabled ? 'выключен, звонок как обычно'
        : s.camera ? 'в эфире' : 'Meet открыт, камера выкл';
      pill('camera', s.camera ? 'ok' : 'off', s.camera ? `${s.fps || 0} fps` : 'выкл',
        s.engine ? `движок: ${s.engine}, ${s.workMs} мс на кадр` : '');
      pill('ai', s.ai === 'готов' ? 'ok' : 'warn',
        s.ai === 'готов' ? (s.seg ? 'готов' : 'без маски') : (s.ai === 'ошибка' ? 'ошибка' : 'грузится'),
        s.aiError || '');
      if (!st.vanish) {
        pill('mic', 'off', 'выкл');
        pill('plate', 'off', '—');
      } else {
        pill('mic', s.mic === 'on' ? 'ok' : s.mic === 'muted' ? 'warn' : 'off',
          s.mic === 'on' ? 'слушаю' : s.mic === 'muted' ? 'мьют' : 'нет');
        pill('plate', s.plate === 'clean' ? 'ok' : s.plate === 'filled' ? 'warn' : 'off',
          s.plate === 'clean' ? 'снят' : s.plate === 'filled' ? 'дорисую' : 'нет');
      }
    }
    renderLasers(ok, s);
    const can = ok && st.enabled && st.vanish && s.seg;
    const busy = s.vanish === 'dissolving' || s.vanish === 'forming';
    const bv = $('btnVanish');
    bv.disabled = !can || busy;
    bv.textContent = busy ? '…' : s.vanish === 'gone' ? 'Появиться' : 'Исчезнуть';
    $('btnPlate').disabled = !can || s.vanish !== 'visible';
    $('plateNote').textContent = !ok ? 'Кнопки работают только на вкладке Meet.'
      : !s.seg ? 'Нет модели сегментации, смотри папку models/.'
      : s.plate === 'clean' ? 'Фон снят. Исчезнешь без следа.'
      : 'Выйди из кадра на пару секунд, и фон снимется сам.';
  }

  // ===================== лазеры =====================
  function renderLasers(ok, s) {
    const lz = s.lasers || {};
    const th = lz.th || 0.35;
    const B = $('frownLive');
    if (!B.firstChild) {
      const top = el('div', 'top');
      top.append(el('span', 'lbl', 'Хмурость'), el('span', 'now'));
      const meter = el('div', 'meter');
      for (let k = 0; k < 20; k++) meter.append(el('i'));
      B.append(top, meter);
    }
    // шкала до 1.6 порога: метка порога — на 13-м делении
    const full = th * 1.6;
    const lit = ok && lz.face ? Math.round(Math.min(1, (lz.frown || 0) / full) * 20) : 0;
    const thIdx = Math.min(19, Math.max(0, Math.round((th / full) * 20) - 1));
    B.classList.toggle('hit', !!lz.on);
    B.querySelector('.now').textContent = !ok ? 'нет вкладки Meet'
      : lz.on ? 'горят' : !lz.face ? 'лица нет' : lz.learning ? 'запоминаю лицо' : `${(lz.frown || 0).toFixed(2)} / ${th}`;
    [...B.querySelector('.meter').children].forEach((d, k) => {
      d.classList.toggle('on', k < lit);
      d.classList.toggle('th', k === thIdx);
    });
    const bl = $('btnLasers');
    bl.disabled = !ok || !st.enabled || st.lasers === false || (!lz.on && !lz.face);
    bl.textContent = lz.on ? 'Погасить' : 'Пиу';
    $('laserNote').textContent = !ok ? 'Работает только на вкладке Meet.'
      : lz.on ? 'Горят. Поворачивай голову, чтобы целиться.'
      : !lz.face ? 'Лицо не видно. Сядь в кадр.'
      : lz.learning ? 'Пару секунд запоминаю твоё обычное лицо, чтобы не стрелять случайно.'
      : 'Нахмурься и держи: погаснут, когда расслабишься. Если смотришь в камеру, лучи летят прямо в зрителя.';
  }

  // ===================== связь с вкладкой =====================
  async function poll() {
    if (tabId == null) {
      try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = t ? t.id : null;
      } catch (_) { tabId = null; }
    }
    if (tabId == null) { link = { ok: false, state: null }; render(); return; }
    try {
      const r = await chrome.tabs.sendMessage(tabId, { memecam: 'status' });
      link = { ok: !!(r && r.ok), state: r && r.state };
    } catch (_) {
      link = { ok: false, state: null };   // в этой вкладке нет Meet
    }
    // пока печатаешь в поле — не перерисовываем всё, чтобы не сбить ввод
    if (document.activeElement && document.activeElement.classList.contains('text')) renderLink();
    else render();
  }
  async function cmd(name, arg) {
    if (tabId == null) return;
    try { await chrome.tabs.sendMessage(tabId, { memecam: 'cmd', cmd: name, arg }); } catch (_) {}
    setTimeout(poll, 150);
  }
  $('btnVanish').addEventListener('click', () => cmd('vanish'));
  $('btnPlate').addEventListener('click', () => {
    cmd('plate');
    const b = $('btnPlate');
    b.textContent = 'Отойди · 3';
    setTimeout(() => { b.textContent = 'Отойди · 2'; }, 1000);
    setTimeout(() => { b.textContent = 'Отойди · 1'; }, 2000);
    setTimeout(() => { b.textContent = 'Снять фон'; }, 3100);
  });

  // ===================== превью частиц =====================
  // Тот же полёт, что и в звонке: волна слева направо, вправо-вверх, тают.
  const cv = $('dust');
  const g = cv.getContext('2d');
  const LIFE = 1.0;
  let W = 0, H = 0, parts = [], maxD = 0, size = 3, animOn = false;
  const t0 = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fitCanvas() {
    const r = cv.getBoundingClientRect();
    if (!r.width) return;                 // вкладка скрыта
    const dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function buildDust() {
    if (!W) fitCanvas();
    if (!W) return;
    size = Math.max(1.5, st.dustSize * 0.7);
    parts = []; maxD = 0;
    const cx = W * 0.5, hy = H * 0.42, hr = H * 0.2;
    for (let y = 0; y < H; y += size) {
      for (let x = 0; x < W; x += size) {
        const head = (x - cx) ** 2 + (y - hy) ** 2 < hr * hr;
        const body = y > H * 0.66 && ((x - cx) / (H * 0.5)) ** 2 + ((y - H * 1.05) / (H * 0.42)) ** 2 < 1;
        if (!head && !body) continue;
        const nx = (x - (cx - H * 0.5)) / H;
        const d = nx * 0.7 + Math.random() * 0.5;
        if (d > maxD) maxD = d;
        // голова — тёплый белый, плечи — сигнальный оранжевый с лёгким разбросом
        const col = head ? `hsl(40 ${12 + Math.random() * 10}% ${84 + Math.random() * 8}%)`
          : `hsl(${14 + nx * 8 + Math.random() * 4} 100% ${52 + Math.random() * 8}%)`;
        parts.push({ x, y, d, vx: 30 + Math.random() * 80, vy: -(6 + Math.random() * 34), w: Math.random() * 6.28, col });
      }
    }
  }
  function frame(now) {
    const HOLD = 0.8, OUT = maxD + LIFE, GAP = 0.5, IN = maxD + LIFE, END = 0.6;
    const cycle = HOLD + OUT + GAP + IN + END;
    const t = reduce ? 0 : ((now - t0) / 1000) % cycle;
    if (W) {
      g.clearRect(0, 0, W, H);
      for (const p of parts) {
        let x = p.x, y = p.y, a = 1, s = size;
        if (t < HOLD) {
          // стоит целиком
        } else if (t < HOLD + OUT) {
          const u = t - HOLD - p.d;
          if (u >= LIFE) continue;
          if (u > 0) {
            const k = u / LIFE;
            x += p.vx * u + Math.sin(p.w + u * 7) * 4 * k;
            y += p.vy * u - 26 * u * u;
            a = (1 - k) * (1 - k);
            s = size * (1 - 0.6 * k);
          }
        } else if (t < HOLD + OUT + GAP) {
          continue;
        } else if (t < HOLD + OUT + GAP + IN) {
          const u = t - HOLD - OUT - GAP - (maxD - p.d);
          if (u <= 0) continue;
          const k = Math.min(1, u / LIFE), e = 1 - (1 - k) ** 3, r = 1 - e, uu = LIFE * r;
          x += p.vx * uu + Math.sin(p.w + uu * 7) * 4 * r;
          y += p.vy * uu - 26 * uu * uu;
          a = e;
          s = size * (1 - 0.6 * r);
        }
        g.globalAlpha = a;
        g.fillStyle = p.col;
        g.fillRect(x, y, s, s);
      }
      g.globalAlpha = 1;
    }
    if (!reduce && animOn) requestAnimationFrame(frame);
  }

  // ===================== превью лазеров =====================
  // Голова поворачивается туда-сюда, лучи уходят вбок; прямо в камеру —
  // только вспышка. Те же цвета, что в звонке.
  const LCOL = {
    red:   { glow: '255,36,24',  mid: '255,84,60',   core: '255,238,228' },
    green: { glow: '36,255,96',  mid: '110,255,140', core: '232,255,236' },
    blue:  { glow: '40,160,255', mid: '96,196,255',  core: '228,244,255' },
  };
  const lv = $('laserPrev');
  const lg = lv.getContext('2d');
  let LW = 0, LH = 0, laserOn = false, headPx = [];
  function fitLaser() {
    const r = lv.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    LW = r.width; LH = r.height;
    lv.width = Math.round(LW * dpr); lv.height = Math.round(LH * dpr);
    lg.setTransform(dpr, 0, 0, dpr, 0, 0);
    // голова и плечи из квадратиков, как в превью пепла
    headPx = [];
    const sz = 3, cx = LW * 0.5, hy = LH * 0.46, hr = LH * 0.24;
    for (let y = 0; y < LH; y += sz) {
      for (let x = 0; x < LW; x += sz) {
        const head = (x - cx) ** 2 + (y - hy) ** 2 < hr * hr;
        const body = y > LH * 0.78 && ((x - cx) / (LH * 0.55)) ** 2 + ((y - LH * 1.15) / (LH * 0.42)) ** 2 < 1;
        if (head || body) headPx.push([x, y, head ? 0.16 + Math.random() * 0.06 : 0.1 + Math.random() * 0.05]);
      }
    }
  }
  function laserFrame(now) {
    if (!LW) fitLaser();
    if (LW) {
      const C = LCOL[st.laserColor] || LCOL.red;
      const t = reduce ? 1.2 : now / 1000;
      const cyc = t % 3.4;                                 // 2.6 с горят, 0.8 с пауза
      const a = cyc < 2.6 ? Math.min(1, cyc / 0.15) : Math.max(0, 1 - (cyc - 2.6) / 0.25);
      const yaw = Math.sin(t * 1.1) * 0.75;
      lg.clearRect(0, 0, LW, LH);
      lg.fillStyle = '#ecebe6';
      for (const [x, y, o] of headPx) { lg.globalAlpha = o; lg.fillRect(x, y, 2.4, 2.4); }
      lg.globalAlpha = 1;
      const cx = LW * 0.5 + yaw * LH * 0.08, ey = LH * 0.44, d = LH * 0.11;
      const eyes = [[cx - d, ey], [cx + d, ey]];
      const s = Math.abs(Math.sin(yaw)), dir = Math.sign(yaw) || 1;
      const front = 1 - Math.min(1, s / 0.28);
      if (a > 0) {
        lg.save();
        lg.globalCompositeOperation = 'lighter';
        lg.globalAlpha = a;
        const len = s * LW * 1.6;
        for (const [x, y] of eyes) {
          if (len > 2) {
            const w0 = 1.2, w1 = 1.2 + s * 9;
            for (const [k, col] of [[3, `rgba(${C.glow},0.22)`], [1, `rgba(${C.mid},0.85)`], [0.35, `rgba(${C.core},0.95)`]]) {
              lg.fillStyle = col;
              lg.beginPath();
              lg.moveTo(x, y - w0 * k / 2);
              lg.lineTo(x + dir * len, y + len * 0.12 - w1 * k / 2);
              lg.lineTo(x + dir * len, y + len * 0.12 + w1 * k / 2);
              lg.lineTo(x, y + w0 * k / 2);
              lg.closePath();
              lg.fill();
            }
          }
          const r = 5 + front * 6;
          const rg = lg.createRadialGradient(x, y, 0, x, y, r * 2.2);
          rg.addColorStop(0, `rgba(${C.core},1)`);
          rg.addColorStop(0.25, `rgba(${C.mid},0.9)`);
          rg.addColorStop(1, `rgba(${C.glow},0)`);
          lg.fillStyle = rg;
          lg.fillRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4);
          lg.fillStyle = `rgba(${C.core},0.8)`;
          lg.fillRect(x - 10 - front * 12, y - 0.6, 20 + front * 24, 1.2);
        }
        lg.restore();
      }
    }
    if (!reduce && laserOn) requestAnimationFrame(laserFrame);
  }

  // ===================== старт =====================
  let firstTab = 'memes';
  try { firstTab = localStorage.getItem('memecam.tab') || 'memes'; } catch (_) {}
  if (!['memes', 'gest', 'vanish', 'lasers', 'more'].includes(firstTab)) firstTab = 'memes';

  S.onChange((s) => { st = s; render(); });   // хоткеи в Meet тоже меняют настройки
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.memeImages) images = ch.memeImages.newValue || {};
    if (ch.customGestures) gestures = ch.customGestures.newValue || [];
    render();
  });
  Promise.all([S.load(), S.getLocal('memeImages', {}), S.getLocal('customGestures', [])]).then(([s, im, gs]) => {
    st = s; images = im; gestures = gs;
    render();
    showTab(firstTab);
  });
  poll();
  setInterval(poll, 1000);
})();
