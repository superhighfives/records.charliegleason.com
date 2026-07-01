// Custom Clerk types. The admin gate keys off `publicMetadata.role === "admin"`,
// set from the Clerk Dashboard on the user record.
//
// `metadata` reaches the session token via Dashboard → Sessions → Customize
// session token: `{ "metadata": "{{user.public_metadata}}" }`.

export {};

declare global {
	/** Server-side: shape of the custom claims baked into the session JWT. */
	interface CustomJwtSessionClaims {
		metadata?: {
			role?: string;
		};
	}

	/** Client-side: shape of `user.publicMetadata`. */
	interface UserPublicMetadata {
		role?: string;
	}
}
