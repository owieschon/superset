import type { ChatRouter } from "@superset/chat-runtime";
import { CLIError } from "@superset/cli-framework";
import type { AppRouter as HostServiceRouter } from "@superset/host-service/trpc";
import { getHostId } from "@superset/shared/host-info";
import { buildHostRoutingKey } from "@superset/shared/host-routing";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import SuperJSON from "superjson";
import type { ApiClient } from "../api-client";
import { isProcessAlive, readManifest } from "../host/manifest";
import { getRelayUrl } from "../host/relay-url";

export type HostServiceClient = ReturnType<
	typeof createTRPCClient<HostServiceRouter>
>;

/**
 * chat-v3 is mounted as its own tRPC server at `/chat-v3/trpc`
 * (see host-service/src/chat-v3/mount.ts), separate from the main
 * `HostServiceRouter` at `/trpc` — so it needs its own typed client.
 */
export type ChatServiceClient = ReturnType<typeof createTRPCClient<ChatRouter>>;

/** Base WebSocket origin + auth token for the host's WS routes (terminals, CDP). */
export interface HostWsEndpoint {
	/** e.g. `ws://127.0.0.1:5123` (local) or `wss://relay/hosts/<key>` (remote). */
	baseWsUrl: string;
	/** Passed as the `?token=` query param on WS routes. */
	token: string;
}

export type ResolvedHostTarget =
	| {
			kind: "local";
			hostId: string;
			client: HostServiceClient;
			chat: ChatServiceClient;
			ws: HostWsEndpoint;
	  }
	| {
			kind: "remote";
			hostId: string;
			client: HostServiceClient;
			chat: ChatServiceClient;
			ws: HostWsEndpoint;
	  };

export interface ResolveHostTargetOptions {
	/**
	 * Always a concrete host id — callers decide explicitly (requireHostTarget,
	 * a resource's hostId, or getHostId() when local is the documented
	 * behavior). There is deliberately no implicit local fallback.
	 */
	requestedHostId: string;
	organizationId: string;
	userJwt: string;
	/** Resolves the relay a remote host is on; unused for local targets. */
	api: ApiClient;
}

export async function resolveHostTarget(
	options: ResolveHostTargetOptions,
): Promise<ResolvedHostTarget> {
	const localHostId = getHostId();
	const targetHostId = options.requestedHostId;

	if (targetHostId === localHostId) {
		const manifest = readManifest(options.organizationId);
		if (!manifest) {
			throw new CLIError(
				"Host service for this machine isn't running",
				"Run: superset start",
			);
		}
		if (!isProcessAlive(manifest.pid)) {
			throw new CLIError(
				"Host service manifest is stale (recorded PID is dead)",
				"Run: superset start",
			);
		}
		return {
			kind: "local",
			hostId: localHostId,
			client: createTRPCClient<HostServiceRouter>({
				links: [
					httpBatchLink({
						url: `${manifest.endpoint}/trpc`,
						transformer: SuperJSON,
						headers: {
							Authorization: `Bearer ${manifest.authToken}`,
							"x-superset-client-machine-id": localHostId,
						},
					}),
				],
			}),
			// No `transformer` here: unlike HostServiceRouter, ChatRouter's
			// `initTRPC.create()` (chat-runtime/src/router/router/router.ts)
			// doesn't declare superjson, so the client must not either — every
			// chat-v3 schema is already plain JSON (no Date/Map/etc).
			chat: createTRPCClient<ChatRouter>({
				links: [
					httpBatchLink({
						url: `${manifest.endpoint}/chat-v3/trpc`,
						headers: {
							Authorization: `Bearer ${manifest.authToken}`,
							"x-superset-client-machine-id": localHostId,
						},
					}),
				],
			}),
			ws: {
				baseWsUrl: manifest.endpoint.replace(/^http/, "ws"),
				token: manifest.authToken,
			},
		};
	}

	const routingKey = buildHostRoutingKey(options.organizationId, targetHostId);
	const relayUrl = await getRelayUrl(options.api);
	return {
		kind: "remote",
		hostId: targetHostId,
		client: createTRPCClient<HostServiceRouter>({
			links: [
				httpBatchLink({
					url: `${relayUrl}/hosts/${routingKey}/trpc`,
					transformer: SuperJSON,
					headers: {
						Authorization: `Bearer ${options.userJwt}`,
						"x-superset-client-machine-id": localHostId,
					},
				}),
			],
		}),
		// See the local branch above: ChatRouter has no transformer declared.
		chat: createTRPCClient<ChatRouter>({
			links: [
				httpBatchLink({
					url: `${relayUrl}/hosts/${routingKey}/chat-v3/trpc`,
					headers: {
						Authorization: `Bearer ${options.userJwt}`,
						"x-superset-client-machine-id": localHostId,
					},
				}),
			],
		}),
		ws: {
			baseWsUrl: `${relayUrl.replace(/^http/, "ws")}/hosts/${routingKey}`,
			token: options.userJwt,
		},
	};
}
