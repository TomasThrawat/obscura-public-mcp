# Obscura Remote MCP

Public Streamable HTTP adapter for the Obscura browser automation MCP server.

Endpoint after deployment: https://obscura-public-mcp-hyouka1.vercel.app/mcp

Protocol: MCP Streamable HTTP with JSON-RPC over POST. A GET request returns a health response. The adapter lazily downloads the prebuilt Obscura Linux binary to /tmp on first MCP POST, then starts the native MCP HTTP server on loopback.

The default binary is a CircleCI artifact. Configure OBSCURA_BINARY_URL in Vercel if that artifact expires or a newer build should be used, then redeploy.

Security: private and loopback network access is disabled by the adapter. The endpoint itself has no client authentication, so anyone with the URL can invoke the browser automation tools; do not use it for sensitive accounts or authenticated sessions. Rate limiting is per warm function instance and is not a global quota.

Hosting limitation: Vercel Functions may recycle or scale instances. Browser state lives only in one warm instance, so long multi-step sessions are not guaranteed to stay on the same instance. A persistent single-instance service is the better host for reliable stateful sessions.
