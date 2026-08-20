/* @ts-self-types="./sleeve_corner_net.d.ts" */
import wasmModule from "./sleeve_corner_net_bg.wasm";
import * as imports from "./sleeve_corner_net_bg.js";
import { __wbg_set_wasm } from "./sleeve_corner_net_bg.js";

const instance = new WebAssembly.Instance(wasmModule, {
	"./sleeve_corner_net_bg.js": imports,
});
__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();
export {
    detectSleeveCornersNet
} from "./sleeve_corner_net_bg.js";
