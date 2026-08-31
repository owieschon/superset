import { db } from "@superset/db/client";
import {
	pluginConnections,
	pluginInstalls,
	type SelectPluginConnection,
} from "@superset/db/schema";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
	decryptOptional,
	decryptSecret,
	encryptOptional,
	encryptSecret,
} from "./crypto";
import {
	type PluginManifest,
	supersetExtension,
	type TemplateScope,
} from "./manifest";

export interface ConnectionSecrets {
	accessToken: string;
	refreshToken: string | null;
	inputs: Record<string, unknown>;
}

export interface UpsertConnectionInput {
	userId: string;
	organizationId: string | null;
	pluginName: string;
	authMethod: string;
	accessToken: string;
	refreshToken?: string | null;
	tokenExpiresAt?: Date | null;
	scopes?: string[] | null;
	inputs?: Record<string, unknown>;
	secretInputs?: string[];
	externalAccountId: string;
	externalAccountLabel?: string | null;
}

/**
 * Secret input values are encrypted individually so a `config` blob can be
 * returned to the UI with them stripped rather than decrypted wholesale.
 */
async function encryptInputs(
	inputs: Record<string, unknown>,
	secretNames: string[],
): Promise<Record<string, unknown>> {
	const secrets = new Set(secretNames);
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(inputs)) {
		out[name] =
			secrets.has(name) && typeof value === "string"
				? { __encrypted: await encryptSecret(value) }
				: value;
	}
	return out;
}

async function decryptInputs(
	config: unknown,
): Promise<Record<string, unknown>> {
	if (!config || typeof config !== "object") return {};
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(
		config as Record<string, unknown>,
	)) {
		if (value && typeof value === "object" && "__encrypted" in value) {
			out[name] = await decryptSecret(
				(value as { __encrypted: string }).__encrypted,
			);
		} else {
			out[name] = value;
		}
	}
	return out;
}

export async function upsertConnection(
	input: UpsertConnectionInput,
): Promise<SelectPluginConnection> {
	const values = {
		userId: input.userId,
		organizationId: input.organizationId,
		pluginName: input.pluginName,
		authMethod: input.authMethod,
		accessToken: await encryptSecret(input.accessToken),
		refreshToken: await encryptOptional(input.refreshToken),
		tokenExpiresAt: input.tokenExpiresAt ?? null,
		scopes: input.scopes ?? null,
		config: await encryptInputs(input.inputs ?? {}, input.secretInputs ?? []),
		externalAccountId: input.externalAccountId,
		externalAccountLabel: input.externalAccountLabel ?? null,
	};

	const [row] = await db
		.insert(pluginConnections)
		.values(values)
		.onConflictDoUpdate({
			target: [
				pluginConnections.userId,
				pluginConnections.pluginName,
				pluginConnections.externalAccountId,
			],
			targetWhere: isNull(pluginConnections.disconnectedAt),
			set: {
				authMethod: values.authMethod,
				accessToken: values.accessToken,
				refreshToken: values.refreshToken,
				tokenExpiresAt: values.tokenExpiresAt,
				scopes: values.scopes,
				config: values.config,
				externalAccountLabel: values.externalAccountLabel,
				organizationId: values.organizationId,
			},
		})
		.returning();

	if (!row) throw new Error("Failed to persist connection");
	return row;
}

export async function listConnections(
	userId: string,
	pluginName?: string,
): Promise<SelectPluginConnection[]> {
	return await db
		.select()
		.from(pluginConnections)
		.where(
			and(
				eq(pluginConnections.userId, userId),
				isNull(pluginConnections.disconnectedAt),
				pluginName ? eq(pluginConnections.pluginName, pluginName) : undefined,
			),
		)
		.orderBy(desc(pluginConnections.createdAt));
}

export async function getConnection(
	userId: string,
	connectionId: string,
): Promise<SelectPluginConnection | null> {
	const [row] = await db
		.select()
		.from(pluginConnections)
		.where(
			and(
				eq(pluginConnections.id, connectionId),
				eq(pluginConnections.userId, userId),
				isNull(pluginConnections.disconnectedAt),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function disconnect(
	userId: string,
	connectionId: string,
	reason = "user_disconnected",
): Promise<boolean> {
	const result = await db
		.update(pluginConnections)
		.set({ disconnectedAt: new Date(), disconnectReason: reason })
		.where(
			and(
				eq(pluginConnections.id, connectionId),
				eq(pluginConnections.userId, userId),
				isNull(pluginConnections.disconnectedAt),
			),
		)
		.returning({ id: pluginConnections.id });
	return result.length > 0;
}

export async function connectionSecrets(
	connection: SelectPluginConnection,
): Promise<ConnectionSecrets> {
	return {
		accessToken: await decryptSecret(connection.accessToken),
		refreshToken: await decryptOptional(connection.refreshToken),
		inputs: await decryptInputs(connection.config),
	};
}

export async function templateScope(
	connection: SelectPluginConnection,
): Promise<TemplateScope> {
	const secrets = await connectionSecrets(connection);
	return {
		config: { access_token: secrets.accessToken },
		inputs: secrets.inputs,
	};
}

/**
 * The manifest supplies the mcp url a credential gets sent to, so resolving it
 * must be deterministic. The unique index is (user, marketplace, plugin), so
 * filtering on user+plugin alone can match two rows; order by marketplace and
 * take the first rather than letting the database choose.
 */
export async function installedManifest(
	userId: string,
	pluginName: string,
	marketplace?: string,
): Promise<PluginManifest | null> {
	const rows = await db
		.select({
			manifest: pluginInstalls.manifest,
			marketplace: pluginInstalls.marketplace,
		})
		.from(pluginInstalls)
		.where(
			and(
				eq(pluginInstalls.userId, userId),
				eq(pluginInstalls.pluginName, pluginName),
				eq(pluginInstalls.enabled, true),
				marketplace ? eq(pluginInstalls.marketplace, marketplace) : undefined,
			),
		)
		.orderBy(asc(pluginInstalls.marketplace))
		.limit(1);
	return (rows[0]?.manifest as PluginManifest | undefined) ?? null;
}

export function manifestAuth(manifest: PluginManifest) {
	return supersetExtension(manifest)?.auth;
}

export interface PluginContext {
	manifest: PluginManifest;
	scope: TemplateScope;
	connectionId: string | null;
	/** Which declared method the held token came from; null when no auth. */
	authMethod: string | null;
}

/**
 * Everything a tool call needs for one plugin, whether or not it has auth.
 *
 * A plugin with no `auth` never has a connection row, so keying dispatch on a
 * connection id alone left those plugins unreachable. Auth plugins resolve the
 * caller's single connection; more than one is ambiguous and must be addressed
 * by id instead.
 */
export async function pluginContext(
	userId: string,
	pluginName: string,
): Promise<
	| { ok: true; context: PluginContext }
	| { ok: false; status: number; error: string }
> {
	const manifest = await installedManifest(userId, pluginName);
	if (!manifest) {
		return {
			ok: false,
			status: 404,
			error: `Plugin "${pluginName}" is not installed`,
		};
	}

	if (!manifestAuth(manifest)) {
		return {
			ok: true,
			context: { manifest, scope: {}, connectionId: null, authMethod: null },
		};
	}

	const rows = await listConnections(userId, pluginName);
	if (rows.length === 0) {
		return {
			ok: false,
			status: 409,
			error: `"${pluginName}" is not connected. Connect an account first.`,
		};
	}
	if (rows.length > 1) {
		return {
			ok: false,
			status: 409,
			error: `"${pluginName}" has ${rows.length} connected accounts; call it through /api/plugins/connections/<id>/tools to choose one.`,
		};
	}

	const connection = rows[0];
	if (!connection) {
		return {
			ok: false,
			status: 409,
			error: `"${pluginName}" is not connected.`,
		};
	}
	return {
		ok: true,
		context: {
			manifest,
			scope: await templateScope(connection),
			connectionId: connection.id,
			authMethod: connection.authMethod,
		},
	};
}
