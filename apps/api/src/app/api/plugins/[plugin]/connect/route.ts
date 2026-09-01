import { auth } from "@superset/auth/server";
import {
	installedManifest,
	installedPlugin,
	manifestAuth,
	pluginErrorResponse,
	upsertConnection,
} from "@/lib/plugins/connections";
import { authMethod } from "@/lib/plugins/manifest";
import {
	buildAuthorizationUrl,
	createPluginState,
	resolveIdentity,
} from "@/lib/plugins/oauth";

/**
 * Starts an OAuth2 connection by redirecting to the provider.
 *
 * Inputs travel through the signed state so the callback can re-resolve
 * `${inputs.site}` when exchanging the code against a per-tenant token_url.
 * Only non-secret inputs belong here — a credential in a query string lands in
 * browser history, proxy access logs, and the Referer header, so api_key
 * connections go through POST instead.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ plugin: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { plugin } = await params;
	const url = new URL(request.url);
	const organizationId = url.searchParams.get("organizationId");

	let manifest: Awaited<ReturnType<typeof installedManifest>>;
	try {
		manifest = await installedManifest(session.user.id, plugin);
	} catch (error) {
		const response = pluginErrorResponse(error);
		if (!response) throw error;
		return response;
	}
	if (!manifest) {
		return Response.json(
			{ error: `Plugin "${plugin}" is not installed` },
			{ status: 404 },
		);
	}

	const requested = url.searchParams.get("method") ?? undefined;
	const authSpec = authMethod(manifestAuth(manifest), requested);
	if (!authSpec) {
		return Response.json(
			{
				error: requested
					? `Plugin "${plugin}" declares no "${requested}" auth method`
					: `Plugin "${plugin}" needs a method: it offers more than one`,
			},
			{ status: 400 },
		);
	}

	const inputs: Record<string, string> = {};
	for (const input of authSpec.inputs ?? []) {
		const value = url.searchParams.get(input.name);
		if (value) inputs[input.name] = value;
		else if (input.required) {
			return Response.json(
				{ error: `Missing required input "${input.name}"` },
				{ status: 400 },
			);
		}
	}

	if (authSpec.type === "api_key") {
		return Response.json(
			{
				error:
					"api_key plugins connect with POST and a JSON body, so the credential never enters a URL.",
			},
			{ status: 405 },
		);
	}

	const state = createPluginState({
		userId: session.user.id,
		organizationId,
		pluginName: plugin,
		authMethod: authSpec.type,
		inputs,
	});

	try {
		return Response.redirect(
			buildAuthorizationUrl(plugin, authSpec, { inputs }, state),
		);
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		);
	}
}

/**
 * Creates an api_key connection. POST with a JSON body of inputs, so the
 * credential never reaches a URL — and so a cross-site GET cannot plant a
 * connection backed by an attacker's credential in someone else's account.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ plugin: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { plugin } = await params;
	const organizationId =
		new URL(request.url).searchParams.get("organizationId") ?? null;

	// installedPlugin, not installedManifest: the connection records which
	// install granted it, so dispatch never has to resolve by name again.
	let install: Awaited<ReturnType<typeof installedPlugin>>;
	try {
		install = await installedPlugin(session.user.id, plugin);
	} catch (error) {
		const response = pluginErrorResponse(error);
		if (!response) throw error;
		return response;
	}
	if (!install) {
		return Response.json(
			{ error: `Plugin "${plugin}" is not installed` },
			{ status: 404 },
		);
	}

	const authSpec = authMethod(manifestAuth(install.manifest), "api_key");
	if (!authSpec) {
		return Response.json(
			{ error: `Plugin "${plugin}" does not use api_key auth` },
			{ status: 400 },
		);
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Body must be JSON" }, { status: 400 });
	}

	const inputs: Record<string, string> = {};
	for (const input of authSpec.inputs ?? []) {
		const value = body[input.name];
		if (typeof value === "string" && value) inputs[input.name] = value;
		else if (input.required) {
			return Response.json(
				{ error: `Missing required input "${input.name}"` },
				{ status: 400 },
			);
		}
	}

	const credentialName = authSpec.credential_input ?? "api_key";
	const credential = inputs[credentialName];
	if (!credential) {
		return Response.json(
			{ error: `Missing "${credentialName}"` },
			{ status: 400 },
		);
	}

	let identity: { id: string; label: string | null };
	try {
		identity = await resolveIdentity(
			authSpec.identity,
			{ config: { access_token: credential }, inputs },
			authSpec.type,
		);
	} catch (error) {
		return Response.json(
			{
				error: `Could not verify the credential: ${error instanceof Error ? error.message : String(error)}`,
			},
			{ status: 400 },
		);
	}

	const connection = await upsertConnection({
		userId: session.user.id,
		organizationId,
		pluginName: plugin,
		installId: install.id,
		authMethod: authSpec.type,
		accessToken: credential,
		inputs,
		secretInputs: (authSpec.inputs ?? [])
			.filter((input) => input.secret)
			.map((input) => input.name),
		externalAccountId: identity.id,
		externalAccountLabel: identity.label,
	});

	return Response.json({
		connectionId: connection.id,
		plugin,
		account: connection.externalAccountLabel,
	});
}
