// Custom Clerk types. The admin gate keys off `publicMetadata.role === "admin"`,
// set from the Clerk Dashboard on the user record.

export {};

declare global {
	/** Server-side: shape of the custom claims baked into the session JWT. */
	interface CustomJwtSessionClaims {
		/** Included in the session token by default; no customization needed. */
		public_metadata?: {
			role?: string;
		};
		/** Fallback for a custom-mapped `{ "metadata": "{{user.public_metadata}}" }` claim. */
		metadata?: {
			role?: string;
		};
	}

	/** Client-side: shape of `user.publicMetadata`. */
	interface UserPublicMetadata {
		role?: string;
	}
}
