import { ErrorScreen } from "#/components/error-screen";

export function NotFound() {
	return (
		<ErrorScreen
			// 💿 optical disc, turning slowly on its spindle
			emoji="%F0%9F%92%BF"
			spin
			code="Error 404"
			heading="Off the record"
			message="This one skipped a groove — the page you're looking for isn't in the collection."
		/>
	);
}
