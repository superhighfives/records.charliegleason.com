import { ErrorScreen } from "#/components/error-screen";

export function NotFound() {
	return (
		<ErrorScreen
			// 💿 optical disc
			emoji="%F0%9F%92%BF"
			code="Error 404"
			heading="Off the record"
			message="This one skipped a groove — the page you're looking for isn't in the collection."
		/>
	);
}
