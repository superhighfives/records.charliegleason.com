import { env } from "cloudflare:workers";

/**
 * Last.fm — top albums for the configured user, used to suggest records to buy.
 * https://www.last.fm/api/show/user.getTopAlbums
 */

const BASE = "https://ws.audioscrobbler.com/2.0/";

export interface LastfmAlbum {
	artist: string;
	title: string;
	playcount: number;
	url: string;
	image: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: untyped Last.fm JSON
function pickImage(images: Array<any> | undefined): string | null {
	if (!images) return null;
	const best =
		images.find((i) => i.size === "extralarge") ??
		images.find((i) => i.size === "large") ??
		images[images.length - 1];
	const url = best?.["#text"];
	return url && url.length > 0 ? url : null;
}

export async function getTopAlbums(
	period = "1month",
	limit = 50,
): Promise<Array<LastfmAlbum>> {
	const url = new URL(BASE);
	url.searchParams.set("method", "user.gettopalbums");
	url.searchParams.set("user", env.LASTFM_USER);
	url.searchParams.set("api_key", env.LASTFM_API_KEY);
	url.searchParams.set("format", "json");
	url.searchParams.set("period", period);
	url.searchParams.set("limit", String(limit));

	const res = await fetch(url);
	if (!res.ok) return [];

	const data = (await res.json()) as {
		// biome-ignore lint/suspicious/noExplicitAny: untyped Last.fm JSON
		topalbums?: { album?: Array<any> };
	};
	return (data.topalbums?.album ?? [])
		.map((a) => ({
			artist: String(a.artist?.name ?? ""),
			title: String(a.name ?? ""),
			playcount: Number(a.playcount ?? 0),
			url: String(a.url ?? ""),
			image: pickImage(a.image),
		}))
		.filter((a) => a.artist && a.title);
}
