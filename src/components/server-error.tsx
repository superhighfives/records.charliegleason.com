import { ErrorScreen } from "#/components/error-screen";

export function ServerError() {
	return (
		<ErrorScreen
			// 🫠 melting face
			emoji="%F0%9F%AB%A0"
			code="Error 500"
			heading="Something's warped"
			message="A server error knocked the needle off the groove. This one's on us — try again in a moment."
		/>
	);
}
