# Browser Chinese frontend

NLP sources and dictionaries are copied from the user's `sbv2-onnx-server`
(`src/nlp/{chinese,english,mod.rs}`, `resources/`). Their GPL-3.0 license is
preserved in LICENSE. The adapter in src/lib.rs uses the same symbol mapping,
per-phone language/tone offsets, blank insertion and tokenizer byte-offset
alignment as that server. It has no native ONNX Runtime, network or audio dependency.

Build from the repository root: `npm run voice:build` (Rust wasm32 target and
wasm-pack required). Generated JS/WASM is ignored; build it before `npm run build`.
Run Rust regression tests with `cargo test --manifest-path voice-frontend/Cargo.toml`.
The tokenizer uses its WASM-compatible regex feature; verify fixture alignment
when updating tokenizer versions. Do not silently replace normalization or G2P
with a different browser library.
