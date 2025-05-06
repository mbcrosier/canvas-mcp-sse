// @ts-ignore: process is Node.js global
// The MCP logic has been migrated to Cloudflare Workers (src/worker.ts) and src/mcpCore.ts.
// This file is now deprecated.

// Declare process for Node.js environments
// eslint-disable-next-line no-var
// @ts-ignore
declare var process: any;

console.error('This MCP server now runs as a Cloudflare Worker. Please use src/worker.ts and deploy with Wrangler.');
// Only exit if running in Node.js
if (typeof process !== 'undefined' && process.exit) {
  process.exit(1);
}