/**
 * Browser-side uploads to `/api/admin/capture`. The photo goes up as the raw
 * request body (metadata in the query string) rather than base64-in-JSON
 * through a server fn — the base64 route buffered several copies of the photo
 * in the worker and hit the isolate memory limit whenever the payload was an
 * unshrunk original.
 */

async function postCapture(
	blob: Blob,
	mediaType: string,
	params: URLSearchParams,
): Promise<Response> {
	const query = params.size > 0 ? `?${params}` : "";
	return fetch(`/api/admin/capture${query}`, {
		method: "POST",
		headers: { "content-type": mediaType },
		body: blob,
	});
}

/** Capture a new record. Resolves to the created row's id. */
export async function uploadCapture(vars: {
	blob: Blob;
	mediaType: string;
	context: string;
	colorId: string;
}): Promise<{ id: number }> {
	const params = new URLSearchParams();
	if (vars.context) params.set("context", vars.context);
	if (vars.colorId) params.set("colorId", vars.colorId);
	const res = await postCapture(vars.blob, vars.mediaType, params);
	if (!res.ok) throw new Error(`Capture upload failed (${res.status})`);
	return res.json();
}

/**
 * Replace an existing record's source capture. Resolves to null when the
 * record no longer exists (mirrors the old server fn's null return).
 */
export async function uploadReplacementCapture(vars: {
	recordId: number;
	blob: Blob;
	mediaType: string;
}): Promise<{ id: number } | null> {
	const params = new URLSearchParams({ recordId: String(vars.recordId) });
	const res = await postCapture(vars.blob, vars.mediaType, params);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Capture upload failed (${res.status})`);
	return res.json();
}
