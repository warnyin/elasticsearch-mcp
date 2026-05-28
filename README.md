# @warnyin/elasticsearch-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets MCP clients (Claude Desktop, Claude Code, Cursor, etc.) run and manage **SQL** against an Elasticsearch cluster through the official [Elasticsearch SQL REST API](https://www.elastic.co/guide/en/elasticsearch/reference/current/sql-rest.html).

It exposes the SQL endpoints (`POST /_sql`, `POST /_sql/translate`, `POST /_sql/close`), the async-search endpoints (`GET /_sql/async/{id}`, `GET /_sql/async/status/{id}`, `DELETE /_sql/async/delete/{id}`), plus helpers for discovering indices and mappings.

## Run via npx

```bash
npx -y @warnyin/elasticsearch-mcp
```

That command starts the server on stdio. You normally launch it from an MCP-aware client (see configuration below) rather than by hand.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ES_URL` | `http://localhost:9200` | Base URL of the Elasticsearch cluster |
| `ES_USERNAME` | — | Basic-auth username |
| `ES_PASSWORD` | — | Basic-auth password |
| `ES_API_KEY` | — | API key (base64-encoded `id:api_key`), sent as `Authorization: ApiKey ...` |
| `ES_BEARER_TOKEN` | — | Bearer token, sent as `Authorization: Bearer ...` |
| `ES_CA_CERT` | — | Path to a PEM CA certificate |
| `ES_INSECURE` | `false` | If `true`, skip TLS certificate verification (dev only) |
| `ES_DEFAULT_FETCH` | `1000` | Default `fetch_size` for SQL queries |
| `ES_REQUEST_TIMEOUT` | `30000` | HTTP request timeout in ms |

Auth precedence: `ES_API_KEY` > `ES_BEARER_TOKEN` > `ES_USERNAME` / `ES_PASSWORD`.

## Tools

| Tool | Underlying call | Purpose |
| --- | --- | --- |
| `ping` | `GET /` | Verify connectivity |
| `cluster_health` | `GET /_cluster/health` | Cluster health summary |
| `list_indices` | `GET /_cat/indices` | List indices (with optional pattern / hidden) |
| `get_mapping` | `GET /{index}/_mapping` | Mapping (schema) of an index |
| `show_tables` | `POST /_sql` (`SHOW TABLES`) | Tables visible to the SQL engine |
| `describe_index` | `POST /_sql` (`DESCRIBE`) | SQL columns/types of an index |
| `sql_query` | `POST /_sql` | Run SQL — paging, params, runtime mappings, async, ... |
| `sql_translate` | `POST /_sql/translate` | Translate SQL to Elasticsearch Query DSL |
| `sql_clear_cursor` | `POST /_sql/close` | Close a SQL paging cursor |
| `sql_async_get` | `GET /_sql/async/{id}` | Fetch results of an async SQL search |
| `sql_async_status` | `GET /_sql/async/status/{id}` | Status of an async SQL search |
| `sql_async_delete` | `DELETE /_sql/async/delete/{id}` | Cancel/delete an async SQL search |

### `sql_query` parameters

Supports the full Elasticsearch `POST /_sql` body: `query`, `cursor`, `fetch_size`, `params`, `time_zone`, `filter`, `catalog`, `columnar`, `field_multi_value_leniency`, `runtime_mappings`, `request_timeout`, `page_timeout`, `wait_for_completion_timeout`, `keep_on_completion`, `keep_alive`, `allow_partial_search_results`, `index_using_frozen`, plus the `format` query string parameter.

## Client configuration

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "elasticsearch": {
      "command": "npx",
      "args": ["-y", "@warnyin/elasticsearch-mcp"],
      "env": {
        "ES_URL": "https://your-cluster.example.com:9200",
        "ES_API_KEY": "your-base64-api-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add elasticsearch -- npx -y @warnyin/elasticsearch-mcp
```

Then set env vars in the same shell (or in `~/.claude.json`):

```bash
ES_URL=https://your-cluster.example.com:9200 \
ES_API_KEY=your-base64-api-key \
claude mcp add elasticsearch -- npx -y @warnyin/elasticsearch-mcp
```

### Cursor / other MCP clients

Use the same `command` + `args` + `env` shape — the server is a generic stdio MCP server.

## Example prompts

- "List the indices that match `logs-*` and show me the mapping of `logs-2026.05`."
- "Run `SELECT level, COUNT(*) FROM \"logs-*\" WHERE \"@timestamp\" > NOW() - INTERVAL 1 HOUR GROUP BY level`."
- "Translate `SELECT * FROM events WHERE user_id = ? LIMIT 5` with `params=['u_42']` and show me the underlying DSL."
- "Page through the previous query using its cursor and close it when done."

## Development

```bash
git clone https://github.com/warnyin/elasticsearch-mcp.git
cd elasticsearch-mcp
npm install
npm run build
node dist/index.js
```

`npm run dev` starts `tsc --watch`.

## License

MIT © warnyin
