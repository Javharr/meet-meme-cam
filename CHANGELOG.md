# Changelog

All notable changes to this project. Details and the debugging story behind
each version are in the [development log](docs/devlog.ru.md) (Russian).

## [1.4.0] — 2026-10-05

### Added
- Laser eyes: frown to fire, turn your head to aim. Flare, glow and sparks, in red, green or blue.
- Adaptive frown threshold that learns your resting face, plus a fifth calibration step (frown).
- Panel tab *04 Laser* with a live frown meter, colour picker and a *Pew* button. New hotkey `Ctrl+Shift+L`.
- Extension name and description localized (English, Russian).

## [1.3.0] — 2026-10-04

### Changed
- The panel was redesigned as a hardware control surface: warm paper or graphite, one signal orange, monospaced labels and square LEDs.
- Memes became numbered pads, custom gestures show sample-count meters, and the recognizer has a 20-segment confidence meter.
- Fonts (Onest, IBM Plex Mono, Unbounded) are bundled. New icon.

## [1.2.0] — 2026-10-04

### Added
- Your own pictures and GIFs for every meme, and custom captions.
- Custom hand gestures with few-shot kNN on 3D hand landmarks.
- Expression calibration.
- New `track` camera engine (MediaStreamTrackProcessor/Generator): full frame rate in a background tab.

### Fixed
- The detector message queue could grow without bound on slow machines. An ack-based back-pressure protocol and dropping of stale frames fix it.
- The popup no longer re-decodes images every second or animates hidden tabs.

## [1.1.0]

### Added
- Control panel with tabs to switch every effect on and off.
- Smaller vanish particles with adjustable size.

### Changed
- Your preview is mirrored only for you. Others see you unmirrored, as without the extension.

## [1.0.0]

### Added
- Vanish: two claps turn you into pixel dust, two more bring you back, with background reconstruction.

## [0.9.0]

### Changed
- Face and hand models alternate, and recognition pauses while a meme is shown, to reduce lag.

## [0.8.0] / [0.7.0]

### Fixed
- MediaPipe moved into an extension-origin iframe after `ModuleFactory not set.` (isolated world) and `Failed to construct 'Worker'`.

## [0.6.0]

### Added
- Recognition of facial expressions and hand gestures with MediaPipe.

## [0.2.0] – [0.5.0]

### Fixed
- Black or dark video after joining a call: Meet clones and stops tracks and calls `getUserMedia` repeatedly, so tracks are now reference-counted and the camera is opened once.

## [0.1.0]

### Added
- Proof of concept: a `getUserMedia` hook drawing memes into the outgoing video, triggered by hotkeys.
