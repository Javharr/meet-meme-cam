# Models

Three MediaPipe models, bundled so the extension works right after cloning.
They are loaded only from this folder — the extension never downloads anything.

| File | Size | Used for |
|---|---|---|
| `face_landmarker.task` | 3.8 MB | facial expressions (blendshapes) and 478 face points for laser eyes |
| `gesture_recognizer.task` | 8.4 MB | 7 built-in hand gestures + 21 hand points for your own gestures |
| `selfie_segmenter_landscape.tflite` | 0.25 MB | person/background mask for the vanish effect |

Without the segmenter, memes and lasers still work; only the vanish effect is off.

To update them (file names must stay the same):

```sh
cd extension/models
curl -LO https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
curl -LO https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task
curl -LO https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite
```

License: Apache License 2.0 (see `LICENSE`).
