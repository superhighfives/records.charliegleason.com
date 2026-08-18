/**
 * Detect the sleeve's four corners in an RGBA image.
 *
 * `rgba` is `width * height * 4` bytes (R,G,B,A per pixel — same layout as a canvas
 * `ImageData`/`Uint8ClampedArray`, which is what the TS caller already has in hand).
 *
 * Returns a flat `[x0,y0, x1,y1, x2,y2, x3,y3]` array of eight normalised (0..1)
 * coordinates in TL, TR, BR, BL order on success, or an empty array when no confident
 * quad was found — the TS wrapper maps that to `null`, matching the pure-TS detector's
 * return type (`NormalizedCorners | null`) so callers can't tell them apart.
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Float64Array}
 */
export function detectSleeveCorners(rgba, width, height) {
    const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detectSleeveCorners(ptr0, len0, width, height);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

export function init() {
    wasm.init();
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
