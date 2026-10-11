# Architecture

How Meme Cam gets effects into a Google Meet call, and why it is built this way.
Several of the decisions below came out of approaches that failed first; the
[development log](devlog.ru.md) (Russian) has the full story.

## Overview

```
popup.html/js ── chrome.storage.sync (settings) / chrome.storage.local (images, gestures)
      └── chrome.tabs.sendMessage (status, commands) ──┐
                                                       ▼
inject.js (MAIN world) ⇄ window.postMessage ⇄ detector.js (bridge, ISOLATED world)
                                                       ⇅ postMessage + transferable ImageBitmap
                                                 detector.html — hidden iframe, extension origin
                                                 (quiet.js, settings.js, detector.frame.js + MediaPipe)
```

| File | World | Role |
|---|---|---|
| `inject.js` | page (`MAIN`), `document_start`, all frames | wraps `getUserMedia`, runs the video pipeline, draws all effects, listens for claps |
| `detector.js` | isolated | bridge: inserts the iframe, relays messages, reads and writes `chrome.storage` |
| `detector.frame.js` | extension iframe | MediaPipe face, hand and segmentation models; custom-gesture kNN |
| `settings.js` | everywhere | defaults, meme catalogue, storage helpers |
| `popup.*` | extension popup | control panel |

## Getting into the call

`inject.js` runs in the page world before any Meet code and replaces
`navigator.mediaDevices.getUserMedia`. Audio-only requests pass through (a
clone of the audio track goes to the clap detector). Video requests open the
real camera once and return a processed track.

Two pipeline engines:

- **track** (default): `MediaStreamTrackProcessor → OffscreenCanvas →
  MediaStreamTrackGenerator`. It does not depend on page rendering, so the
  outgoing video keeps 20 of 20 fps when the Meet tab is in the background
  (the canvas engine dropped to 6.8 fps there). Camera timestamps are kept.
- **canvas** (fallback, *Old camera engine* in the panel): hidden `<video>` +
  `requestVideoFrameCallback` + `canvas.captureStream(0)`.

Things Meet does that the hook has to survive:

- **Meet clones the track when you join and stops the original.** Tracks are
  reference-counted through wrapped `clone()` and `stop()`, and the camera
  closes only when every handed-out track is stopped. Meet always receives a
  clone of the generator, so it can never stop the generator itself.
- **Meet calls `getUserMedia` several times.** The camera is opened once and
  later calls get clones.
- **Meet inspects the track.** `getSettings`, `getCapabilities` and
  `getConstraints` report the real camera's values; `applyConstraints` forwards
  only `frameRate` to the camera. Resolution is never changed, because that
  would reset the captured background.

## Why recognition lives in an iframe

| Where | Result |
|---|---|
| isolated content-script world | MediaPipe injects its loader with a `<script>` tag, which runs in the page world → `ModuleFactory not set.` |
| Web Worker started from a content script | inherits the page origin and cannot load a `chrome-extension://` script → `Failed to construct 'Worker'` |
| **iframe `detector.html` on the extension origin** | has a `document`, its own origin, and its own CSP with `wasm-unsafe-eval` ✔ |

`quiet.js` filters MediaPipe's glog `W`/`I` lines, which Chrome would
otherwise collect on the extension's *Errors* page.

## Message protocol

`window.postMessage` with `{ __memecam: 1, dir }`:

- `toAI`: `frame` (+ `fast`: face only), `seg`, `record`, `calib`
- `toPage`: `settings`, `media`, `gestures`, `cmd`, `fire`, `scores`, `eyes`,
  `mask`, `status`, `recorded`, `calibSample`, `ack`
- `toBridge`: `hello`, `state`, `save` (only `hud` and `previewMirror`), `saveTh`, `saveGesture`

The bridge accepts page messages only from `window` itself and iframe
messages only from its own iframe's `contentWindow`. Values coming from the
page are validated (known keys, numeric ranges, 63-number samples).

**Back-pressure.** Recognition is synchronous, so "busy, skip" alone does not
stop messages from piling up. The detector sends `ack` after every frame, and
the page sends nothing new until it arrives (1.5 s safety timeout). Frames
older than 400 ms are dropped. Before this, a slow machine built an endless
queue: a record command arrived 15 s late, and the popup, which shares the
extension process with the detector, would not open. Now the popup opens in
0.2 s with recognition running, even without a GPU.

**Scheduling.** Frames are scaled to 256×144 before shipping. Face and hands
alternate, and segmentation is sampled about once a second. While a meme is
on screen only the face is tracked, every 300 ms (needed for laser eyes).
After 4 s with nothing in view the rate drops to one frame every 300 ms.
Recording a gesture, calibrating and laser eyes switch to one frame every 60 ms
with a single model.

## Models

| File | Used for |
|---|---|
| `face_landmarker.task` | 52 blendshapes (expressions) + 478 landmarks (eyes, head direction) |
| `gesture_recognizer.task` | 7 built-in gestures + 21 3D hand landmarks |
| `selfie_segmenter_landscape.tflite` | person mask, 256×144 input |

All three use the GPU delegate when available and fall back to CPU.

## Memes

Face: shock = `jawOpen > 0.45` and `eyeWide > 0.20`, LOL = `mouthSmile > 0.55`,
hmm = `browInnerUp > 0.60` (defaults; calibration replaces them). Hands map
the recognizer's categories (`Thumb_Up` → like, and so on) at score ≥ 0.6.
Priority: custom gesture > built-in gesture > face, because a gesture is
deliberate and a facial expression can happen mid-sentence. A candidate must
hold for 3 analysed frames; the same meme has a 3.5 s cooldown, and any two
memes are at least 1.5 s apart.

Custom images live in `chrome.storage.local` as base64. Static images are
re-encoded to WebP at most 512 px; animations are kept as they are (≤ 5 MB).
On the page, `ImageDecoder` decodes GIFs into at most 150 frames, ≤ 480 px a
side, once.

## Custom gestures (few-shot)

- **Feature:** 21 `worldLandmarks` → 63 numbers, origin at the wrist, scaled
  by palm length (wrist → middle-finger base), left hand mirrored to right.
  This makes a pose look the same at any distance and with either hand, while
  👍 and 👎 stay different.
- **Classifier:** k-NN with k = 3 (mean distance). Each gesture gets its own
  rejection radius: the 90th percentile of its leave-one-out nearest-neighbour
  distance × 2.2, clamped to [0.15, 1.2]. If the best and second-best gestures
  are almost equally close (ratio > 0.8), nothing fires.
- **Recording:** 3 s after a countdown, hands only, ≤ 60 samples per take,
  ≤ 120 per gesture.
- **Synthetic test:** 100 % recognition, 100 % with the other hand, 94 % at
  double noise, 100 % rejection of four unrelated poses.

## Calibration

Five steps of 3.3 s each (1.2 s to settle into the expression): neutral,
shock, smile, eyebrows up, frown. Threshold = p90(neutral) + 0.45 ×
(median(expression) − p90(neutral)), applied only when the gap is > 0.08.

## Vanish

- **Trigger:** two claps. An `AnalyserNode` (fftSize 4096, ≈ 85 ms) polled every
  20 ms looks for a sharp peak with ≥ 350 ms of quiet before it, a second peak
  120–650 ms later, and quiet afterwards for at least max(450 ms, 1.2 × the
  gap). The last rule rejects typing and periodic sounds such as music or
  beeps. Sensitivity sets the minimum peak (0.42 / 0.28 / 0.17).
- **Mask:** segmentation at 20 Hz while vanishing, dilated by about 10 px. The
  first clap already switches segmentation to the fast rate, so a fresh mask is
  ready when the second clap comes.
- **Background:** a clean plate, captured automatically when the frame has
  been empty for three masks or on demand; otherwise a background accumulated
  piece by piece while you move, with remaining holes filled by row
  interpolation. An earlier push-pull inpainting left a blue ghost.
- **Particles:** squares of `dustSize` px (~8k), written straight into a
  `Uint32Array`; only the dirty rectangle is uploaded to the canvas. A
  left-to-right wave, drifting up and to the right and fading. 30 fps without
  a GPU.

## Laser eyes

- **Trigger:** frown = mean of `browDownLeft` and `browDownRight`, above the
  threshold for 2 consecutive face frames. The lasers stay on while you hold
  the frown, with hysteresis at max(0.75 × threshold, threshold − 0.1), and
  switch off 300 ms + 2 × the measured landmark interval after you relax
  (at least 0.9 s on). If the face is lost, they switch off after
  max(700 ms, 3 × interval). Timeouts scale with the interval so that slow
  machines don't flicker.
- **Adaptive threshold:** `browDown` at rest varies a lot between faces and
  lighting. One test face read 0.47 at rest, and its mirror image read 0.16,
  so a fixed 0.35 fired on its own. Without calibration, the threshold is the
  40th percentile of the last 90 samples (one per 250 ms, ≈ 20 s, collected
  only while the lasers are off) + 0.22, clamped to [0.3, 0.92]. Until 12
  samples exist, it does not fire.
- **Geometry** (`eyesOf` in the detector): iris centres 468/473, eye corners
  33/263, forehead 10, chin 152; y is converted to x units (× 144/256). The
  face normal is −(eye line × forehead→chin), flipped to face the camera.
  Its projection (nx, ny) is the beam direction, and its length sets the beam
  length (× 2.6 frame width). Looking straight into the camera gives a flare,
  turning the head gives long beams. Checked on a mirrored face: nx flips
  sign (+0.25 → −0.25).
- **Rendering:** glow is drawn into a quarter-size canvas with `blur()` and
  scaled up with `lighter` compositing. On top go a sharp coloured beam, a
  near-white core, a flare and a streak along the eye line, a star when facing
  the camera, and up to 180 sparks where a beam leaves the frame. Smoothing
  τ = 60 ms. About 12–22 ms per frame without a GPU.
- **Rate:** while the lasers are on, or the frown is within 0.1 of the
  threshold, the face is tracked every 60 ms with hands and mask skipped.
  Memes don't fire while the lasers are on.

## Preview mirror

Meet mirrors your self-view. The outgoing video is never mirrored, so others
see you correctly. To keep your own preview looking like a mirror, Meme Cam
finds the `<video>` elements showing its tracks (a `WeakSet`), computes the
effective flip from `transform` and `scale` on the element and its ancestors,
and adds CSS `scale: -1 1` where needed. Effects are drawn unmirrored, so text
reads correctly for everyone; only the debug overlay is pre-mirrored for you.

## Performance notes

- Two models on every frame caused lag, so they alternate, and recognition
  pauses while a meme is on screen.
- An empty frame used to extend fast segmentation forever, starving face and
  hand detection. Fast segmentation is now extended only while there is no
  fresh clean plate, and recording and calibration take priority.
- The popup used to re-decode base64 images every second and animate hidden
  tabs, in the same process as the detector. It now memoizes images and
  animates only the visible preview.

## Testing without a human

Chromium + Playwright with `channel='chromium'`, because the headless shell
cannot load extensions. The test uses `launch_persistent_context` with
`--load-extension`, and `page.route` (not `context.route`, which breaks
`chrome-extension://`) to fake `meet.google.com`. The camera and microphone are
fake devices fed from files (`--use-file-for-fake-video-capture` with a y4m
video, `--use-file-for-fake-audio-capture` with a wav). Outgoing fps is
measured through a loopback `RTCPeerConnection` and `framesEncoded`. An
unpacked extension's ID is sha256(path)[:32] with hex digits mapped to a–p.
Popup height is measured with `body.getBoundingClientRect()`, since Chrome
caps popups at 600 px.
