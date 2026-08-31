import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./auth";

/**
 * One plugin a user installed from a marketplace.
 *
 * `pluginName` and `marketplace` are text, never enums: adding a plugin is a
 * marketplace edit, not a migration. That is the whole point of the format,
 * and it is why these do not live in `integration_connections`, whose
 * `provider` enum costs a migration per provider.
 *
 * `manifest` is the resolved plugin.json. Storing it means a remote plugin's
 * tool calls need nothing on disk — the mcp url and the bind map are already
 * on the row.
 */
export const pluginInstalls = pgTable(
	"plugin_installs",
	{
		id: uuid().primaryKey().defaultRandom(),
		// Nullable until org policy exists (phase 2). Present from the start so
		// adding policy never needs a backfill that cannot answer "which org?"
		// for someone in more than one.
		organizationId: uuid("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),

		marketplace: text().notNull(),
		pluginName: text("plugin_name").notNull(),
		version: text().notNull(),
		manifest: jsonb().notNull(),

		enabled: boolean().notNull().default(true),

		installedAt: timestamp("installed_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex("plugin_installs_user_plugin_unique").on(
			table.userId,
			table.marketplace,
			table.pluginName,
		),
		index("plugin_installs_user_idx").on(table.userId),
	],
);

export type InsertPluginInstall = typeof pluginInstalls.$inferInsert;
export type SelectPluginInstall = typeof pluginInstalls.$inferSelect;

/**
 * One authorization of one plugin, by one user, for one external account.
 *
 * Tokens are encrypted at rest with better-auth's symmetricEncrypt keyed off
 * BETTER_AUTH_SECRET; `integration_connections` stores them in cleartext and
 * should not be copied here.
 *
 * `externalAccountId` comes from the manifest's `auth.identity` block, or is a
 * generated uuid when the plugin declares none. It is part of the unique index
 * so one user can hold several connections to the same plugin — two Gmail
 * accounts — without a migration when that ships.
 */
export const pluginConnections = pgTable(
	"plugin_connections",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),

		pluginName: text("plugin_name").notNull(),
		/**
		 * Which declared auth method produced this token. A plugin can offer
		 * several and they are not interchangeable — Linear sends OAuth tokens as
		 * `Bearer <token>` and personal API keys raw — so dispatch needs to know
		 * which one it holds.
		 */
		authMethod: text("auth_method").notNull().default("oauth2"),

		// Encrypted. Never select these into a response.
		accessToken: text("access_token").notNull(),
		refreshToken: text("refresh_token"),
		tokenExpiresAt: timestamp("token_expires_at"),
		scopes: text().array(),

		/** Values for the manifest's `auth.inputs`; secret ones encrypted. */
		config: jsonb(),

		externalAccountId: text("external_account_id").notNull(),
		externalAccountLabel: text("external_account_label"),

		disconnectedAt: timestamp("disconnected_at"),
		disconnectReason: text("disconnect_reason"),

		createdAt: timestamp("created_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		// Reconnecting the same account replaces the live row; a disconnected
		// row stays for audit, so the index is partial rather than a constraint.
		uniqueIndex("plugin_connections_account_active_unique")
			.on(table.userId, table.pluginName, table.externalAccountId)
			.where(sql`${table.disconnectedAt} IS NULL`),
		index("plugin_connections_user_plugin_idx").on(
			table.userId,
			table.pluginName,
		),
	],
);

export type InsertPluginConnection = typeof pluginConnections.$inferInsert;
export type SelectPluginConnection = typeof pluginConnections.$inferSelect;

/**
 * A marketplace a user has added. Held server-side rather than only in
 * ~/.superset so the set follows the user across machines: the CLI and the
 * desktop app both read it from here and reconcile local content to match.
 *
 * The first-party marketplace is not a row — it is compiled into the clients,
 * so it is present before any request succeeds and cannot be removed.
 */
export const pluginMarketplaces = pgTable(
	"plugin_marketplaces",
	{
		id: uuid().primaryKey().defaultRandom(),
		organizationId: uuid("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),

		/** Marketplace id, from its manifest. Plugins are addressed <plugin>@<name>. */
		name: text().notNull(),
		/** "github" or "path"; a path source is local to one machine. */
		sourceKind: text("source_kind").notNull(),
		repo: text(),
		/** Branch or tag for a github source; null means its default branch. */
		ref: text(),
		path: text(),

		addedAt: timestamp("added_at").notNull().defaultNow(),
		updatedAt: timestamp("updated_at")
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex("plugin_marketplaces_user_name_unique").on(
			table.userId,
			table.name,
		),
		index("plugin_marketplaces_user_idx").on(table.userId),
	],
);

export type InsertPluginMarketplace = typeof pluginMarketplaces.$inferInsert;
export type SelectPluginMarketplace = typeof pluginMarketplaces.$inferSelect;
