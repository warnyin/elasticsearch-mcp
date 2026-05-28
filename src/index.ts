#!/usr/bin/env node
/**
 * @warnyin/elasticsearch-mcp
 *
 * MCP server exposing the Elasticsearch SQL REST API as a set of tools that
 * MCP clients (Claude Desktop, Claude Code, etc.) can call.
 *
 * Transport: stdio.
 *
 * Configuration via environment variables:
 *   ES_URL              Base URL of the Elasticsearch cluster (default: http://localhost:9200)
 *   ES_USERNAME         Optional basic-auth username
 *   ES_PASSWORD         Optional basic-auth password
 *   ES_API_KEY          Optional API key (base64-encoded "id:api_key" pair, sent as `ApiKey ...`)
 *   ES_BEARER_TOKEN     Optional bearer token (sent as `Bearer ...`)
 *   ES_CA_CERT          Optional path to a CA certificate (PEM)
 *   ES_INSECURE         If "true"/"1", disables TLS certificate verification (dev only)
 *   ES_DEFAULT_FETCH    Default page size for SQL queries (default: 1000)
 *   ES_REQUEST_TIMEOUT  Request timeout in ms (default: 30000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Agent, fetch as undiciFetch, type RequestInit } from "undici";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ES_URL = (process.env.ES_URL ?? "http://localhost:9200").replace(/\/+$/, "");
const ES_USERNAME = process.env.ES_USERNAME;
const ES_PASSWORD = process.env.ES_PASSWORD;
const ES_API_KEY = process.env.ES_API_KEY;
const ES_BEARER_TOKEN = process.env.ES_BEARER_TOKEN;
const ES_CA_CERT = process.env.ES_CA_CERT;
const ES_INSECURE = ["true", "1", "yes"].includes(
  (process.env.ES_INSECURE ?? "").toLowerCase(),
);
const ES_DEFAULT_FETCH = parseInt(process.env.ES_DEFAULT_FETCH ?? "1000", 10);
const ES_REQUEST_TIMEOUT = parseInt(process.env.ES_REQUEST_TIMEOUT ?? "30000", 10);

function buildAuthHeader(): Record<string, string> {
  if (ES_API_KEY) return { Authorization: `ApiKey ${ES_API_KEY}` };
  if (ES_BEARER_TOKEN) return { Authorization: `Bearer ${ES_BEARER_TOKEN}` };
  if (ES_USERNAME) {
    const pass = ES_PASSWORD ?? "";
    const token = Buffer.from(`${ES_USERNAME}:${pass}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

const tlsAgent = (() => {
  const needsAgent = ES_INSECURE || ES_CA_CERT || ES_URL.startsWith("https://");
  if (!needsAgent) return undefined;
  const ca = ES_CA_CERT ? readFileSync(ES_CA_CERT) : undefined;
  return new Agent({
    connect: {
      rejectUnauthorized: !ES_INSECURE,
      ...(ca ? { ca } : {}),
    },
  });
})();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface EsRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface EsResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

async function esRequest(opts: EsRequestOptions): Promise<EsResponse> {
  const method = opts.method ?? "GET";
  const url = new URL(`${ES_URL}${opts.path.startsWith("/") ? "" : "/"}${opts.path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...buildAuthHeader(),
  };
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ES_REQUEST_TIMEOUT);

  const init: RequestInit = {
    method,
    headers,
    body: bodyStr,
    signal: controller.signal,
  };
  if (tlsAgent) (init as RequestInit & { dispatcher?: Agent }).dispatcher = tlsAgent;

  try {
    const res = await undiciFetch(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep as text
      }
    }
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function asToolError(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function asToolText(data: unknown): { content: { type: "text"; text: string }[] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

async function callEs(opts: EsRequestOptions) {
  const res = await esRequest(opts);
  if (!res.ok) {
    return asToolError(
      `Elasticsearch ${opts.method ?? "GET"} ${opts.path} returned HTTP ${res.status}: ${
        typeof res.body === "string" ? res.body : JSON.stringify(res.body)
      }`,
    );
  }
  return asToolText(res.body);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "ping",
    description:
      "Check the Elasticsearch cluster is reachable. Returns the cluster's root info (name, version, tagline).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cluster_health",
    description:
      "Get cluster health via `GET /_cluster/health`. Useful for diagnosing connectivity, shard, or node issues.",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["cluster", "indices", "shards"],
          description: "Granularity of the health report.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_indices",
    description:
      "List indices using `GET /_cat/indices?format=json`. Returns index names, health, docs.count, store.size, etc.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Optional index pattern (e.g. `logs-*`). Defaults to all indices.",
        },
        include_hidden: {
          type: "boolean",
          description: "Include hidden/system indices (those starting with `.`). Default false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_mapping",
    description:
      "Get the mapping (schema) of one or more indices via `GET /{index}/_mapping`. Use this to discover columns/types before writing SQL.",
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "string",
          description:
            "Index name or comma-separated names/patterns (e.g. `logs-*,events`). Required.",
        },
      },
      required: ["index"],
      additionalProperties: false,
    },
  },
  {
    name: "sql_query",
    description:
      "Run a SQL query against Elasticsearch via `POST /_sql`. Use standard ES SQL syntax (e.g. `SELECT * FROM \"logs-*\" WHERE level = 'ERROR' LIMIT 10`). Supports paging via `cursor`, parameterized queries via `params`, and async execution via `wait_for_completion_timeout` + `keep_on_completion`. Response includes `columns`, `rows`, optional `cursor`, and (for async) `id`, `is_partial`, `is_running`.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The SQL statement to execute. Required unless `cursor` is supplied.",
        },
        cursor: {
          type: "string",
          description:
            "Pagination cursor returned from a previous `sql_query` call. If provided, `query` is ignored.",
        },
        fetch_size: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: `Maximum rows per page. Default ${ES_DEFAULT_FETCH}.`,
        },
        params: {
          type: "array",
          description:
            "Positional parameters for `?` placeholders in the query (e.g. `[\"ERROR\", 100]`).",
          items: {},
        },
        time_zone: {
          type: "string",
          description: "ISO-8601 time zone ID used for date functions (e.g. `Asia/Bangkok`). Default UTC.",
        },
        format: {
          type: "string",
          enum: ["json", "csv", "tsv", "txt", "yaml", "cbor", "smile"],
          description: "Response format. Default `json`.",
        },
        filter: {
          type: "object",
          description: "Optional Elasticsearch Query DSL filter to AND with the SQL WHERE clause.",
        },
        catalog: {
          type: "string",
          description: "Default catalog (cluster) for cross-cluster SQL.",
        },
        columnar: {
          type: "boolean",
          description: "Return results in columnar (column-of-values) form instead of rows.",
        },
        field_multi_value_leniency: {
          type: "boolean",
          description: "If true, return the first value when a field is multi-valued.",
        },
        runtime_mappings: {
          type: "object",
          description:
            "Runtime fields, mapped per the Query DSL. Take precedence over indexed fields of the same name.",
        },
        request_timeout: {
          type: "string",
          description: "How long the request waits before failing (e.g. `30s`, `2m`).",
        },
        page_timeout: {
          type: "string",
          description: "Minimum time the server retains the cursor page (e.g. `45s`).",
        },
        wait_for_completion_timeout: {
          type: "string",
          description:
            "If set, the request waits up to this duration for completion; if exceeded, the query becomes async and an `id` is returned (e.g. `5s`).",
        },
        keep_on_completion: {
          type: "boolean",
          description:
            "If true and `wait_for_completion_timeout` is set, store the result so it can be retrieved via `sql_async_get` even after completion.",
        },
        keep_alive: {
          type: "string",
          description: "How long to keep an async/saved search around (e.g. `5d`).",
        },
        allow_partial_search_results: {
          type: "boolean",
          description: "Return partial results when shards time out instead of failing.",
        },
        index_using_frozen: {
          type: "boolean",
          description: "Include frozen indices in the search.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sql_translate",
    description:
      "Translate a SQL query into the equivalent Elasticsearch Query DSL via `POST /_sql/translate`. Useful for understanding/optimizing what SQL produces under the hood.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The SQL statement to translate. Required." },
        fetch_size: { type: "integer", minimum: 1, maximum: 10000 },
        params: { type: "array", items: {} },
        time_zone: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "sql_clear_cursor",
    description:
      "Close a SQL cursor via `POST /_sql/close`. Call this when you've finished paging through a result set to free server-side resources.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", description: "The cursor to close. Required." },
      },
      required: ["cursor"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_index",
    description:
      "Describe the columns of an index as SQL sees them, by running `DESCRIBE \"<index>\"`. Use this before writing queries to know the available columns and their SQL types.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "string", description: "Index name or pattern. Required." },
      },
      required: ["index"],
      additionalProperties: false,
    },
  },
  {
    name: "show_tables",
    description:
      "List the tables (indices) visible to the SQL engine by running `SHOW TABLES`. Accepts an optional LIKE pattern.",
    inputSchema: {
      type: "object",
      properties: {
        like: {
          type: "string",
          description: "Optional LIKE pattern (e.g. `logs-%`).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "sql_async_get",
    description:
      "Retrieve the result of an async SQL search via `GET /_sql/async/{id}`. Use this when a previous `sql_query` returned an `id` because it didn't finish within `wait_for_completion_timeout`.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The async search ID. Required." },
        wait_for_completion_timeout: {
          type: "string",
          description: "How long this call will wait for the search to finish (e.g. `5s`).",
        },
        keep_alive: {
          type: "string",
          description: "Extend the result retention period (e.g. `5d`).",
        },
        format: {
          type: "string",
          enum: ["json", "csv", "tsv", "txt", "yaml", "cbor", "smile"],
          description: "Response format. Default `json`.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "sql_async_status",
    description:
      "Get the status of an async SQL search via `GET /_sql/async/status/{id}`. Returns `is_running`, `is_partial`, `start_time_in_millis`, `expiration_time_in_millis`, and (if finished) `completion_status`.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The async search ID. Required." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "sql_async_delete",
    description:
      "Delete an async SQL search and free its resources via `DELETE /_sql/async/delete/{id}`.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The async search ID. Required." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

async function handlePing() {
  return callEs({ method: "GET", path: "/" });
}

async function handleClusterHealth(args: ToolArgs) {
  const level = typeof args.level === "string" ? args.level : undefined;
  return callEs({ method: "GET", path: "/_cluster/health", query: { level } });
}

async function handleListIndices(args: ToolArgs) {
  const pattern = typeof args.pattern === "string" && args.pattern.length > 0 ? args.pattern : "*";
  const includeHidden = args.include_hidden === true;
  return callEs({
    method: "GET",
    path: `/_cat/indices/${encodeURIComponent(pattern)}`,
    query: {
      format: "json",
      expand_wildcards: includeHidden ? "all" : "open",
    },
  });
}

async function handleGetMapping(args: ToolArgs) {
  const index = String(args.index ?? "").trim();
  if (!index) return asToolError("`index` is required.");
  return callEs({ method: "GET", path: `/${encodeURIComponent(index)}/_mapping` });
}

async function handleSqlQuery(args: ToolArgs) {
  const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
  const query = typeof args.query === "string" ? args.query : undefined;
  if (!cursor && !query) {
    return asToolError("Either `query` or `cursor` must be provided.");
  }
  const format = typeof args.format === "string" ? args.format : "json";
  const body: Record<string, unknown> = {
    fetch_size:
      typeof args.fetch_size === "number" && args.fetch_size > 0
        ? args.fetch_size
        : ES_DEFAULT_FETCH,
  };
  if (cursor) {
    body.cursor = cursor;
  } else {
    body.query = query;
    if (Array.isArray(args.params)) body.params = args.params;
    if (typeof args.time_zone === "string") body.time_zone = args.time_zone;
    if (args.filter && typeof args.filter === "object") body.filter = args.filter;
    if (typeof args.catalog === "string") body.catalog = args.catalog;
    if (typeof args.columnar === "boolean") body.columnar = args.columnar;
    if (typeof args.field_multi_value_leniency === "boolean") {
      body.field_multi_value_leniency = args.field_multi_value_leniency;
    }
    if (args.runtime_mappings && typeof args.runtime_mappings === "object") {
      body.runtime_mappings = args.runtime_mappings;
    }
    if (typeof args.request_timeout === "string") body.request_timeout = args.request_timeout;
    if (typeof args.page_timeout === "string") body.page_timeout = args.page_timeout;
    if (typeof args.wait_for_completion_timeout === "string") {
      body.wait_for_completion_timeout = args.wait_for_completion_timeout;
    }
    if (typeof args.keep_on_completion === "boolean") {
      body.keep_on_completion = args.keep_on_completion;
    }
    if (typeof args.keep_alive === "string") body.keep_alive = args.keep_alive;
    if (typeof args.allow_partial_search_results === "boolean") {
      body.allow_partial_search_results = args.allow_partial_search_results;
    }
    if (typeof args.index_using_frozen === "boolean") {
      body.index_using_frozen = args.index_using_frozen;
    }
  }
  return callEs({ method: "POST", path: "/_sql", query: { format }, body });
}

async function handleSqlAsyncGet(args: ToolArgs) {
  const id = String(args.id ?? "").trim();
  if (!id) return asToolError("`id` is required.");
  const query: Record<string, string> = {};
  if (typeof args.wait_for_completion_timeout === "string") {
    query.wait_for_completion_timeout = args.wait_for_completion_timeout;
  }
  if (typeof args.keep_alive === "string") query.keep_alive = args.keep_alive;
  if (typeof args.format === "string") query.format = args.format;
  return callEs({
    method: "GET",
    path: `/_sql/async/${encodeURIComponent(id)}`,
    query,
  });
}

async function handleSqlAsyncStatus(args: ToolArgs) {
  const id = String(args.id ?? "").trim();
  if (!id) return asToolError("`id` is required.");
  return callEs({ method: "GET", path: `/_sql/async/status/${encodeURIComponent(id)}` });
}

async function handleSqlAsyncDelete(args: ToolArgs) {
  const id = String(args.id ?? "").trim();
  if (!id) return asToolError("`id` is required.");
  return callEs({ method: "DELETE", path: `/_sql/async/delete/${encodeURIComponent(id)}` });
}

async function handleSqlTranslate(args: ToolArgs) {
  const query = typeof args.query === "string" ? args.query : undefined;
  if (!query) return asToolError("`query` is required.");
  const body: Record<string, unknown> = { query };
  if (typeof args.fetch_size === "number") body.fetch_size = args.fetch_size;
  if (Array.isArray(args.params)) body.params = args.params;
  if (typeof args.time_zone === "string") body.time_zone = args.time_zone;
  return callEs({ method: "POST", path: "/_sql/translate", body });
}

async function handleSqlClearCursor(args: ToolArgs) {
  const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
  if (!cursor) return asToolError("`cursor` is required.");
  return callEs({ method: "POST", path: "/_sql/close", body: { cursor } });
}

async function handleDescribeIndex(args: ToolArgs) {
  const index = String(args.index ?? "").trim();
  if (!index) return asToolError("`index` is required.");
  const safe = index.replace(/"/g, '""');
  return callEs({
    method: "POST",
    path: "/_sql",
    query: { format: "json" },
    body: { query: `DESCRIBE "${safe}"` },
  });
}

async function handleShowTables(args: ToolArgs) {
  const like = typeof args.like === "string" && args.like.length > 0 ? args.like : undefined;
  const safe = like ? like.replace(/'/g, "''") : undefined;
  const query = safe ? `SHOW TABLES LIKE '${safe}'` : "SHOW TABLES";
  return callEs({ method: "POST", path: "/_sql", query: { format: "json" }, body: { query } });
}

const HANDLERS: Record<string, (args: ToolArgs) => Promise<unknown>> = {
  ping: handlePing,
  cluster_health: handleClusterHealth,
  list_indices: handleListIndices,
  get_mapping: handleGetMapping,
  sql_query: handleSqlQuery,
  sql_translate: handleSqlTranslate,
  sql_clear_cursor: handleSqlClearCursor,
  describe_index: handleDescribeIndex,
  show_tables: handleShowTables,
  sql_async_get: handleSqlAsyncGet,
  sql_async_status: handleSqlAsyncStatus,
  sql_async_delete: handleSqlAsyncDelete,
};

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main() {
  const server = new Server(
    {
      name: "@warnyin/elasticsearch-mcp",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as ToolArgs;
    const handler = HANDLERS[name];
    if (!handler) return asToolError(`Unknown tool: ${name}`);
    try {
      const result = await handler(args);
      return result as never;
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return asToolError(`Tool '${name}' threw: ${msg}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't corrupt stdio JSON-RPC.
  process.stderr.write(
    `[@warnyin/elasticsearch-mcp] ready (ES_URL=${ES_URL})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `[@warnyin/elasticsearch-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
