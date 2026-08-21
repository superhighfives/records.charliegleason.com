/* @ts-self-types="./sleeve_detect.d.ts" */
import wasmModule from "./sleeve_detect_bg.wasm";
import * as imports from "./sleeve_detect_bg.js";
import { __wbg_set_wasm } from "./sleeve_detect_bg.js";

const instance = new WebAssembly.Instance(wasmModule, {
	"./sleeve_detect_bg.js": imports,
});
__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();
export {
    detectSleeveCorners, detectSleeveCornersScored, init
} from "./sleeve_detect_bg.js";
