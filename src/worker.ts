// Cloudflare Worker entry point for MCP over SSE
import {
  listCoursesHandler,
  searchAssignmentsHandler,
  getAssignmentHandler,
  assignmentContentHandler,
  mcpManifest
} from './mcpCore.js';

// Helper: Validate that the domain is a plausible Canvas domain (not IP, localhost, or empty)
function isValidCanvasDomain(domain: string): boolean {
  if (!domain) return false;
  // Disallow localhost, IPs, and empty
  if (/^(localhost|127\.|0\.|::1|\d+\.\d+\.\d+\.\d+)$/.test(domain)) return false;
  // Must be at least two segments and contain only valid domain chars
  if (!/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(domain)) return false;
  return true;
}

// Map tool/resource name to handler
const toolHandlers: Record<string, (params: any, token: string, domain: string) => Promise<any>> = {
  'list_courses': listCoursesHandler,
  'search_assignments': searchAssignmentsHandler,
  'get_assignment': getAssignmentHandler,
  'assignment_content': assignmentContentHandler,
};

// Safe JSON parsing utility
async function safeJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let token = request.headers.get('Authorization');
    if (token && token.startsWith('Bearer ')) {
      token = token.replace('Bearer ', '').trim();
    } else {
      token = url.searchParams.get('token');
    }
    if (!token) {
      return new Response('Missing Canvas API token (provide as Authorization header or ?token= query param)', { status: 401 });
    }
    let domain = url.searchParams.get('canvas_domain') || request.headers.get('X-Canvas-Domain');
    domain = domain || '';
    if (!isValidCanvasDomain(domain)) {
      return new Response('Missing or invalid Canvas domain', { status: 400 });
    }
    // /manifest endpoint for tool/resource discovery
    if (url.pathname === '/manifest') {
      return new Response(JSON.stringify(mcpManifest), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // Only /sse endpoint is supported for tool/resource calls
    if (url.pathname !== '/sse' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }
    const body = await safeJson(request);
    if (!body || typeof body !== 'object' || !body.tool || typeof body.tool !== 'string') {
      return new Response('Invalid request: must include tool and params', { status: 400 });
    }
    const handler = toolHandlers[body.tool];
    if (!handler) {
      return new Response('Unknown tool/resource', { status: 400 });
    }
    // Type checks for courseId/assignmentId if needed
    if ((body.tool === 'get_assignment' || body.tool === 'assignment_content')) {
      if (!body.params || (typeof body.params.courseId !== 'number' && typeof body.params.courseId !== 'string')) {
        return new Response('Missing or invalid courseId', { status: 400 });
      }
      if (!body.params || (typeof body.params.assignmentId !== 'number' && typeof body.params.assignmentId !== 'string')) {
        return new Response('Missing or invalid assignmentId', { status: 400 });
      }
    }
    let result;
    try {
      result = await handler(body.params, token, domain);
    } catch (err: any) {
      // Do not leak internal errors or tokens
      result = { content: [{ type: 'text', text: 'An error occurred while processing your request.' }], isError: true };
    }
    // Stream result as SSE
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify(result)}\n\n`);
        controller.close();
      }
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  }
}; 