# Vendor

`@mediapipe/tasks-vision` **0.10.18**, copied unmodified from npm:

- `vision_bundle.mjs` — the ES module
- `wasm/` — WebAssembly runtime (SIMD and non-SIMD builds)

It is bundled because Manifest V3 extensions cannot load remote code.

To update:

```sh
npm pack @mediapipe/tasks-vision@<version>
tar xzf mediapipe-tasks-vision-<version>.tgz
cp package/vision_bundle.mjs extension/vendor/
cp package/wasm/* extension/vendor/wasm/
```

License: Apache License 2.0 (see `LICENSE`).
