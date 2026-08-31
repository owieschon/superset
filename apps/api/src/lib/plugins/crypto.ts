import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { env } from "@/env";

/**
 * Plugin credentials are encrypted at rest. `integration_connections` stores
 * tokens in cleartext (the `secrets` table that held encrypted values was
 * dropped in migration 0067); that is a known gap and is not repeated here.
 *
 * Keyed off BETTER_AUTH_SECRET rather than a new variable, so no deployment
 * gains a required secret it can forget to set. Rotating that secret makes
 * existing connections undecryptable — they fail closed and the user
 * reconnects.
 */
function key(): string {
	return env.BETTER_AUTH_SECRET;
}

export async function encryptSecret(value: string): Promise<string> {
	return await symmetricEncrypt({ key: key(), data: value });
}

export async function decryptSecret(value: string): Promise<string> {
	return await symmetricDecrypt({ key: key(), data: value });
}

export async function encryptOptional(
	value: string | null | undefined,
): Promise<string | null> {
	return value ? await encryptSecret(value) : null;
}

export async function decryptOptional(
	value: string | null | undefined,
): Promise<string | null> {
	return value ? await decryptSecret(value) : null;
}
