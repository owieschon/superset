// src/tools.ts
var ENDPOINT = "https://api.linear.app/graphql";
var ISSUE_FIELDS = `
	id
	identifier
	title
	description
	url
	priority
	createdAt
	updatedAt
	state { id name type }
	assignee { id name email }
	team { id key name }
`;
function getTools() {
  return [
    {
      name: "linear_list_teams",
      description: "List the teams in the Linear workspace. Call this first when you need a teamId.",
      inputSchema: { type: "object", properties: {} },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    {
      name: "linear_search_issues",
      description: "Search issues by text, optionally narrowed to a team. Returns up to `limit` matches.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search titles and descriptions for"
          },
          teamId: {
            type: "string",
            description: "Restrict results to this team"
          },
          limit: {
            type: "number",
            description: "Maximum results (default 25, max 100)",
            minimum: 1,
            maximum: 100
          }
        },
        required: ["query"]
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    {
      name: "linear_get_issue",
      description: "Fetch one issue by its id or identifier (for example ENG-123).",
      inputSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue id or identifier such as ENG-123"
          }
        },
        required: ["issueId"]
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    {
      name: "linear_create_issue",
      description: "Create an issue in a team.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          teamId: {
            type: "string",
            description: "Team to create the issue in"
          },
          description: {
            type: "string",
            description: "Body, markdown supported"
          },
          assigneeId: { type: "string", description: "User to assign it to" },
          priority: {
            type: "number",
            description: "0 none, 1 urgent, 2 high, 3 medium, 4 low",
            minimum: 0,
            maximum: 4
          }
        },
        required: ["title", "teamId"]
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    {
      name: "linear_update_issue",
      description: "Update fields on an existing issue.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue to update" },
          title: { type: "string" },
          description: { type: "string" },
          stateId: { type: "string", description: "Workflow state id" },
          assigneeId: { type: "string" },
          priority: { type: "number", minimum: 0, maximum: 4 }
        },
        required: ["issueId"]
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true
      }
    }
  ];
}
async function query(accessToken, document, variables = {}) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: accessToken,
      "content-type": "application/json"
    },
    body: JSON.stringify({ query: document, variables })
  });
  if (!response.ok) {
    throw new Error(`Linear API returned ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }
  if (!payload.data) {
    throw new Error("Linear API returned no data");
  }
  return payload.data;
}
function ok(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
async function callTool(name, args, accessToken) {
  if (!accessToken) {
    return {
      content: [
        {
          type: "text",
          text: "No Linear access token; connect the plugin first."
        }
      ],
      isError: true
    };
  }
  try {
    switch (name) {
      case "linear_list_teams": {
        const data = await query(accessToken, `query { teams(first: 100) { nodes { id key name description } } }`);
        return ok(data.teams.nodes);
      }
      case "linear_search_issues": {
        const limit = Math.min(Number(args.limit ?? 25), 100);
        const filter = {};
        if (args.teamId)
          filter.team = { id: { eq: args.teamId } };
        const data = await query(accessToken, `query Search($term: String!, $first: Int!, $filter: IssueFilter) {
						searchIssues(term: $term, first: $first, filter: $filter) {
							nodes { ${ISSUE_FIELDS} }
						}
					}`, {
          term: args.query,
          first: limit,
          filter: Object.keys(filter).length ? filter : undefined
        });
        return ok(data.searchIssues.nodes);
      }
      case "linear_get_issue": {
        const data = await query(accessToken, `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: args.issueId });
        return ok(data.issue);
      }
      case "linear_create_issue": {
        const data = await query(accessToken, `mutation Create($input: IssueCreateInput!) {
						issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
					}`, {
          input: {
            title: args.title,
            teamId: args.teamId,
            description: args.description,
            assigneeId: args.assigneeId,
            priority: args.priority
          }
        });
        return ok(data.issueCreate.issue);
      }
      case "linear_update_issue": {
        const { issueId, ...fields } = args;
        const data = await query(accessToken, `mutation Update($id: String!, $input: IssueUpdateInput!) {
						issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
					}`, { id: issueId, input: fields });
        return ok(data.issueUpdate.issue);
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }
      ],
      isError: true
    };
  }
}

// src/types.ts
var PluginEventType = {
  SYNC: "sync",
  GET_TOOLS: "get-tools",
  CALL_TOOL: "call-tool"
};

// src/index.ts
async function run(event) {
  switch (event.event) {
    case PluginEventType.GET_TOOLS:
      return getTools();
    case PluginEventType.CALL_TOOL:
      return await callTool(event.eventBody.name, event.eventBody.arguments ?? {}, event.config?.access_token);
    default:
      return { message: `Unhandled event: ${event.event}` };
  }
}
export {
  run
};
