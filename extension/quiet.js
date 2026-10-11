/*
 * quiet.js — глушим служебный лог MediaPipe
 * ---------------------------------------------------------------------------
 * MediaPipe собран из C++ и пишет свой внутренний лог (формат glog:
 * "W1004 16:36:34.319000 1905760 face_landmarker_graph.cc:180] …")
 * через console.warn / console.error. Это не ошибки, но Chrome складывает
 * их на страницу «Ошибки» расширения, и выглядит это тревожно.
 *
 * Подключается в detector.html ДО MediaPipe: её загрузчик запоминает
 * console.* при старте, поэтому фильтр должен стоять раньше.
 * Отсеиваем только предупреждения (W) и инфо (I); настоящие ошибки (E)
 * и наши собственные сообщения проходят как есть.
 */
(() => {
  'use strict';
  const NOISE = [
    /^[WI]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+\s+\S+:\d+\]/,   // glog: W… и I…
    /^INFO: Created TensorFlow Lite/,
    /^Graph successfully started running/,
  ];
  const isNoise = (args) => typeof args[0] === 'string' && NOISE.some((r) => r.test(args[0]));
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[k].bind(console);
    console[k] = (...args) => { if (!isNoise(args)) orig(...args); };
  }
})();
