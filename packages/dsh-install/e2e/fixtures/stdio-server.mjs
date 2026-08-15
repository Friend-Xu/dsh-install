/**
 * A real MCP server over stdio for spawn-dependent e2e: one `echo` tool.
 * Launched as `node e2e/fixtures/stdio-server.mjs` by the test — no npm
 * download, no network, a genuine stdio subprocess.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
  { name: 'stdio-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)
server.registerTool('echo', {
  description: 'Echo a message.',
  inputSchema: { message: z.string().describe('Message to echo') },
}, async args => ({
  content: [{ type: 'text', text: `echo: ${String(args.message)}` }],
}))
await server.connect(new StdioServerTransport())
