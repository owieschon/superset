import { db } from "@superset/db/client";
import {
	pluginConnections,
	pluginInstalls,
	pluginMarketplaces,
	type SelectPluginConnection,
} from "@superset/db/schema";
import {
	DEFAULT_MARKETPLACE,
	DEFAULT_MARKETPLACE_REF,
	DEFAULT_MARKETPLACE_REPO,
} from "@superset/shared/plugins";
import { and, asc, countDistinct, desc, eq, isNull } from "drizzle-orm";
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
	/** The install this token is granted against; resolved by the caller. */
	installId?: string | null;
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
		installId: input.installId ?? null,
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
				pluginConnections.installId,
				pluginConnections.externalAccountId,
			],
			targetWhere: isNull(pluginConnections.disconnectedAt),
			set: {
				installId: values.installId,
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
export interface InstalledPlugin {
	id: string;
	manifest: PluginManifest;
	marketplace: string;
}

export class AmbiguousPluginError extends Error {
	constructor(
		readonly pluginName: string,
		readonly marketplaces: string[],
	) {
		super(
			`"${pluginName}" is installed from more than one marketplace (${marketplaces.join(", ")}). Name one with plugin@marketplace.`,
		);
	}
}

/**
 * The manifest to resolve a plugin against, for this user.
 *
 * Refuses rather than picks when a name is installed from several
 * marketplaces. The manifest decides the token_url and the proxy target, and a
 * connection is keyed by plugin *name* — so silently answering with the
 * alphabetically-first install is how a credential granted for one
 * marketplace's plugin ends up bound to another's URL. Callers that know which
 * one they mean pass `marketplace` and never see this.
 */
export async function installedPlugin(
	userId: string,
	pluginName: string,
	marketplace?: string,
): Promise<InstalledPlugin | null> {
	const rows = await db
		.select({
			id: pluginInstalls.id,
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
		.limit(2);

	if (rows.length > 1) {
		throw new AmbiguousPluginError(
			pluginName,
			rows.map((entry) => entry.marketplace),
		);
	}

	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		manifest: row.manifest as PluginManifest,
		marketplace: row.marketplace,
	};
}

/**
 * The install a lifecycle request names, enabled or not.
 *
 * `installedPlugin` is for resolving a manifest to send a credential through,
 * so it only ever answers with an enabled install. Uninstalling and toggling
 * have to reach a disabled one, and they still must not act on two rows at
 * once — a DELETE matched by name alone revokes the credential of every
 * marketplace that carries it.
 */
export async function installRecord(
	userId: string,
	pluginName: string,
	marketplace?: string,
): Promise<{ id: string; marketplace: string; siblings: number } | null> {
	const rows = await db
		.select({
			id: pluginInstalls.id,
			marketplace: pluginInstalls.marketplace,
		})
		.from(pluginInstalls)
		.where(
			and(
				eq(pluginInstalls.userId, userId),
				eq(pluginInstalls.pluginName, pluginName),
				marketplace ? eq(pluginInstalls.marketplace, marketplace) : undefined,
			),
		)
		.orderBy(asc(pluginInstalls.marketplace));

	if (rows.length > 1) {
		throw new AmbiguousPluginError(
			pluginName,
			rows.map((entry) => entry.marketplace),
		);
	}

	const row = rows[0];
	if (!row) return null;

	// Only when this is the user's single install of the name can a connection
	// that predates install_id be attributed to it.
	const [{ count } = { count: 0 }] = await db
		.select({ count: countDistinct(pluginInstalls.id) })
		.from(pluginInstalls)
		.where(
			and(
				eq(pluginInstalls.userId, userId),
				eq(pluginInstalls.pluginName, pluginName),
			),
		);

	return { id: row.id, marketplace: row.marketplace, siblings: count };
}

/**
 * The install a connection was granted against, by id.
 *
 * This is the path that cannot be ambiguous: the connection names one row, so
 * no marketplace has to be guessed from a plugin name. Connections written
 * before install_id existed have none, and fall back to resolving by name.
 */
export async function installById(
	userId: string,
	installId: string,
): Promise<InstalledPlugin | null> {
	const [row] = await db
		.select({
			id: pluginInstalls.id,
			manifest: pluginInstalls.manifest,
			marketplace: pluginInstalls.marketplace,
		})
		.from(pluginInstalls)
		.where(
			and(
				eq(pluginInstalls.id, installId),
				eq(pluginInstalls.userId, userId),
				eq(pluginInstalls.enabled, true),
			),
		)
		.limit(1);

	if (!row) return null;
	return {
		id: row.id,
		manifest: row.manifest as PluginManifest,
		marketplace: row.marketplace,
	};
}

/**
 * The install backing a connection: by id where the connection records one,
 * by name otherwise, which is where ambiguity can still arise.
 */
export async function installForConnection(
	userId: string,
	connection: Pick<SelectPluginConnection, "installId" | "pluginName">,
): Promise<InstalledPlugin | null> {
	return connection.installId
		? await installById(userId, connection.installId)
		: await installedPlugin(userId, connection.pluginName);
}

export async function installedManifest(
	userId: string,
	pluginName: string,
	marketplace?: string,
): Promise<PluginManifest | null> {
	return (
		(await installedPlugin(userId, pluginName, marketplace))?.manifest ?? null
	);
}

export interface BundledSource {
	repo: string;
	ref: string;
}

/**
 * Where to download a plugin's bundled server from.
 *
 * The marketplace the plugin was installed from decides this, so an install
 * always resolves against the repo it came from. A `path` marketplace is one
 * machine's working tree and is unreachable from here, so it yields null and
 * the caller reports that rather than silently falling back to a repo the user
 * never chose.
 */
export async function bundledSource(
	userId: string,
	marketplace: string,
): Promise<BundledSource | null> {
	const [row] = await db
		.select()
		.from(pluginMarketplaces)
		.where(
			and(
				eq(pluginMarketplaces.userId, userId),
				eq(pluginMarketplaces.name, marketplace),
			),
		)
		.limit(1);

	if (!row) {
		// The first-party marketplace ships with the app, so an account that
		// never explicitly added one still resolves.
		return marketplace === DEFAULT_MARKETPLACE
			? { repo: DEFAULT_MARKETPLACE_REPO, ref: DEFAULT_MARKETPLACE_REF }
			: null;
	}
	if (row.sourceKind !== "github" || !row.repo) return null;
	return { repo: row.repo, ref: row.ref ?? "HEAD" };
}

/**
 * Turns an ambiguous-plugin refusal into a response. Returns null for anything
 * else, so a route can rethrow what it does not own.
 */
export function pluginErrorResponse(error: unknown): Response | null {
	return error instanceof AmbiguousPluginError
		? Response.json({ error: error.message }, { status: 409 })
		: null;
}

export function manifestAuth(manifest: PluginManifest) {
	return supersetExtension(manifest)?.auth;
}

export interface PluginContext {
	manifest: PluginManifest;
	/** Where a bundled server is downloaded from; null for a local marketplace. */
	bundled: BundledSource | null;
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
	try {
		return await resolvePluginContext(userId, pluginName);
	} catch (error) {
		if (error instanceof AmbiguousPluginError) {
			return { ok: false, status: 409, error: error.message };
		}
		throw error;
	}
}

async function resolvePluginContext(
	userId: string,
	pluginName: string,
): Promise<
	| { ok: true; context: PluginContext }
	| { ok: false; status: number; error: string }
> {
	const install = await installedPlugin(userId, pluginName);
	if (!install) {
		return {
			ok: false,
			status: 404,
			error: `Plugin "${pluginName}" is not installed`,
		};
	}
	const { manifest } = install;
	const bundled = await bundledSource(userId, install.marketplace);

	if (!manifestAuth(manifest)) {
		return {
			ok: true,
			context: {
				manifest,
				bundled,
				scope: {},
				connectionId: null,
				authMethod: null,
			},
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
			bundled,
			scope: await templateScope(connection),
			connectionId: connection.id,
			authMethod: connection.authMethod,
		},
	};
}
