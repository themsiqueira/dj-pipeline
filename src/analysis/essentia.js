import { createRequire } from "module";

/**
 * Essentia is a WASM build, not a native binary, which is the whole reason it was
 * chosen: no per-platform download, no code signing, no quarantine attribute, and
 * nothing for Windows Defender to scan on first run.
 *
 * The package's own `index.js` also pulls in a plotting module that expects a
 * browser, so the two modules we need are required directly.
 */
const require = createRequire(import.meta.url);

let instance = null;
let loadError = null;

/**
 * Instantiating the WASM module costs ~200ms, so it is done once and shared.
 * Essentia is single-threaded and stateless across calls, so one instance serves
 * the whole analysis pass.
 *
 * @returns {object | null} null when Essentia is unavailable, so analysis can be
 *   skipped without taking down the run
 */
export function getEssentia() {
  if (instance) return instance;
  if (loadError) return null;

  try {
    const wasmModule = require("essentia.js/dist/essentia-wasm.umd");
    const coreModule = require("essentia.js/dist/essentia.js-core.umd");

    const backend = wasmModule.EssentiaWASM ?? wasmModule;
    const Ctor = coreModule.Essentia ?? coreModule.default ?? coreModule;

    instance = new Ctor(backend);
    return instance;
  } catch (err) {
    loadError = err;
    return null;
  }
}

export function getEssentiaLoadError() {
  return loadError;
}
