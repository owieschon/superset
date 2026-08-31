import { COMPANY } from "@superset/shared/constants";

/**
 * The Superset plugin manifest schema. Describes `plugin.json` in full,
 * including the parts Agent Plugins deliberately leaves undefined — auth,
 * credential binding, and the MCP server — which live under
 * `extensions.superset`.
 *
 * Keeping them namespaced rather than at the top level means the same file is
 * also a valid Agent Plugins manifest, so a plugin published for Superset
 * loads in other conformant clients without a second file.
 */
export function GET() {
	const base = COMPANY.MARKETING_URL;

	const authInput = {
		type: "object",
		required: ["name"],
		additionalProperties: false,
		properties: {
			name: {
				type: "string",
				pattern: "^[a-z][a-z0-9_]*$",
				description: "Referenced elsewhere as ${inputs.<name>}.",
			},
			label: { type: "string" },
			placeholder: { type: "string" },
			description: { type: "string" },
			required: { type: "boolean" },
			secret: {
				type: "boolean",
				description: "Encrypted at rest and never returned to a client.",
			},
		},
	};

	const identity = {
		type: "object",
		required: ["url", "id"],
		additionalProperties: false,
		description:
			"How to learn which external account a connection belongs to, run once after auth completes. Omit and the connection gets a generated id and no label.",
		properties: {
			url: { type: "string" },
			method: { enum: ["GET", "POST"], default: "GET" },
			headers: { type: "object", additionalProperties: { type: "string" } },
			body: {
				description: "Sent when method is POST. Present for GraphQL providers.",
			},
			id: {
				type: "string",
				pattern: "^\\$\\.",
				description:
					"JSONPath-lite ($.a.b[0].c) to the stable account id in the response.",
			},
			label: {
				type: "string",
				pattern: "^\\$\\.",
				description: "JSONPath-lite to a human-readable account name.",
			},
		},
	};

	const authMethod = {
		type: "object",
		required: ["type"],
		additionalProperties: false,
		properties: {
			type: { enum: ["oauth2", "api_key"] },
			label: {
				type: "string",
				description:
					"Shown in the picker when a plugin offers several methods.",
			},
			provider: {
				type: "string",
				description:
					"Slug of the upstream product, when Superset already models it as an integration.",
			},
			inputs: { type: "array", items: authInput },
			credential_input: {
				type: "string",
				description:
					"api_key only: which input holds the secret. It becomes ${config.access_token}, so `bind` is identical for both auth types.",
			},
			authorization_url: { type: "string" },
			token_url: { type: "string" },
			scopes: { type: "array", items: { type: "string" } },
			scope_separator: {
				type: "string",
				default: " ",
				description:
					"Linear separates with a comma; most providers use a space.",
			},
			token_request_auth_method: {
				enum: ["client_secret_post", "client_secret_basic"],
				default: "client_secret_post",
			},
			token_expiration_buffer: {
				type: "integer",
				minimum: 0,
				description: "Seconds subtracted from expires_in when storing.",
			},
			requires_env: {
				type: "array",
				items: { type: "string", pattern: "^PLUGIN_[A-Z0-9_]+$" },
				description:
					"Documentation only: the deployment variables an operator must set. Never read to resolve a value — the host derives variable names from the plugin name, so a manifest cannot point the credential lookup at an unrelated secret.",
			},
			identity,
			bind: {
				type: "object",
				additionalProperties: false,
				description:
					"How this method's credential reaches the server. Per method, not per plugin: two methods on one plugin can need different headers — Linear sends OAuth tokens as `Bearer <token>` and personal API keys raw.",
				properties: {
					headers: { type: "object", additionalProperties: { type: "string" } },
					env: { type: "object", additionalProperties: { type: "string" } },
				},
			},
		},
		allOf: [
			{
				if: { properties: { type: { const: "oauth2" } } },
				// biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword, not a thenable
				then: { required: ["authorization_url", "token_url"] },
			},
			{
				if: { properties: { type: { const: "api_key" } } },
				// biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword, not a thenable
				then: { required: ["inputs"] },
			},
		],
	};

	const schema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: `${base}/schemas/plugin/1.0.0.json`,
		title: "Superset plugin manifest",
		type: "object",
		required: ["name", "version"],
		properties: {
			$schema: { type: "string" },
			name: {
				type: "string",
				minLength: 1,
				maxLength: 64,
				pattern: "^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$",
			},
			version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+" },
			description: { type: "string" },
			author: {
				type: "object",
				properties: {
					name: { type: "string" },
					email: { type: "string" },
					url: { type: "string" },
				},
			},
			homepage: { type: "string" },
			repository: { type: "string" },
			license: { type: "string" },
			keywords: { type: "array", items: { type: "string" } },
			extensions: {
				type: "object",
				properties: {
					superset: {
						type: "object",
						additionalProperties: false,
						properties: {
							interface: {
								type: "object",
								required: ["displayName"],
								properties: {
									displayName: { type: "string" },
									category: { type: "string" },
									icon: { type: "string" },
								},
							},
							auth: {
								type: "array",
								minItems: 1,
								items: authMethod,
								description:
									"Ways to authenticate this plugin. A list because a plugin may offer more than one and they are not interchangeable.",
							},
							bind: {
								type: "object",
								additionalProperties: false,
								description:
									"How the credential reaches the server. No server key: a plugin has exactly one. Resolved inside the proxy, never written to a config file on disk.",
								properties: {
									headers: {
										type: "object",
										additionalProperties: { type: "string" },
									},
									env: {
										type: "object",
										additionalProperties: { type: "string" },
									},
								},
							},
							mcp: {
								type: "object",
								required: ["type", "url"],
								additionalProperties: false,
								description:
									"A single remote server, not a map: a plugin serves tools from exactly one place. Omit it when the plugin ships a bundled server instead. Streamable HTTP only \u2014 the legacy HTTP+SSE transport is not supported.",
								properties: {
									type: { const: "streamable-http" },
									url: { type: "string", format: "uri" },
									headers: {
										type: "object",
										additionalProperties: { type: "string" },
									},
								},
							},
						},
					},
				},
			},
		},
	};

	return Response.json(schema, {
		headers: {
			"Content-Type": "application/schema+json",
			"Cache-Control": "public, max-age=3600, s-maxage=86400",
		},
	});
}
