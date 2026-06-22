/**
 * Pure base64 / data-URL helpers. No Cloudflare bindings here on purpose: this
 * module is safe to pull into either the client or server bundle (the capture
 * server fn reads a data URL; the queue consumer encodes R2 bytes for Claude).
 */

/** Strip a `data:<type>;base64,` prefix if present, returning the raw base64. */
export function stripDataUrl(b64: string): string {
	const comma = b64.indexOf(",");
	return b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Encode bytes to base64 in chunks (avoids arg-count limits on big covers). */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
