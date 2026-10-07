# Connect Codex to Meal Companion

The app exposes a remote MCP server at the deployment's `/api/mcp` endpoint. Access is per user:
an administrator mints an `api_tokens` row for the intended account and scopes it to the required
read or write operations.

Store the token in ZS Vault, expose it to the Codex process under a local name, and reference only
that environment-variable name in Codex config:

```toml
[mcp_servers.meal_companion]
url = "https://<deployment-host>/api/mcp"
bearer_token_env_var = "MEAL_COMPANION_MCP_TOKEN"
```

Restart Codex, then confirm `codex mcp list` shows `meal_companion`. A token can read or mutate only
the account named by its own database row; there is no singleton account environment variable.
