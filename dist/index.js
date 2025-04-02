import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
// Create the MCP server
const server = new McpServer({
    name: "Canvas-Assignment-Assistant",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {},
    }
});
// Load credentials from environment variables
let canvasApiToken = process.env.CANVAS_API_TOKEN || null;
let canvasDomain = process.env.CANVAS_DOMAIN || null;
// Base URL for Canvas API
const getBaseUrl = () => {
    if (!canvasDomain) {
        throw new Error("Canvas domain not set. Please check CANVAS_DOMAIN environment variable.");
    }
    return `https://${canvasDomain}/api/v1`;
};
// Helper function for API requests with proper typing
async function canvasApiRequest(path, method = 'GET', body) {
    if (!canvasApiToken) {
        throw new Error("Canvas API token not set. Please check CANVAS_API_TOKEN environment variable.");
    }
    const url = `${getBaseUrl()}${path}`;
    const response = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${canvasApiToken}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Canvas API error: ${response.status} - ${error}`);
    }
    return response.json();
}
// Parse HTML to plain text
function htmlToPlainText(html) {
    if (!html)
        return '';
    const dom = new JSDOM(html);
    return dom.window.document.body.textContent || '';
}
// Validate environment setup and print info
(async function validateSetup() {
    if (!canvasApiToken) {
        console.error("Warning: CANVAS_API_TOKEN not set. Server will not function correctly.");
    }
    if (!canvasDomain) {
        console.error("Warning: CANVAS_DOMAIN not set. Server will not function correctly.");
    }
    if (canvasApiToken && canvasDomain) {
        console.error(`Environment configured correctly for domain: ${canvasDomain}`);
        try {
            const user = await canvasApiRequest('/users/self');
            console.error(`Successfully authenticated as ${user.name} (${user.email})`);
        }
        catch (error) {
            console.error(`Authentication failed: ${error.message}`);
        }
    }
})();
// List courses tool
server.tool("list-courses", {
    state: z.enum(['active', 'completed', 'all']).default('active')
        .describe("Filter courses by state: active, completed, or all"),
}, async ({ state }) => {
    try {
        const courses = await canvasApiRequest(`/courses?enrollment_state=${state}&include[]=term`);
        if (courses.length === 0) {
            return {
                content: [{
                        type: "text",
                        text: `No ${state} courses found.`
                    }]
            };
        }
        const courseList = courses.map((course) => {
            const termName = course.term ? `(${course.term.name})` : '';
            return `- ID: ${course.id} | ${course.name} ${termName}`;
        }).join('\n');
        return {
            content: [{
                    type: "text",
                    text: `Your ${state} courses:\n\n${courseList}`
                }]
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Failed to fetch courses: ${error.message}`
                }],
            isError: true
        };
    }
});
// Search assignments tool (across courses)
server.tool("search-assignments", {
    query: z.string().describe("Search term to find in assignment titles or descriptions"),
    dueBefore: z.string().optional().describe("Only include assignments due before this date (YYYY-MM-DD)"),
    dueAfter: z.string().optional().describe("Only include assignments due after this date (YYYY-MM-DD)"),
    includeCompleted: z.boolean().default(false).describe("Include assignments from completed courses"),
    courseId: z.string().or(z.number()).optional().describe("Optional: Limit search to specific course ID"),
}, async ({ query, dueBefore, dueAfter, includeCompleted, courseId }) => {
    try {
        let courses;
        // If courseId is provided, only search that course
        if (courseId) {
            courses = [await canvasApiRequest(`/courses/${courseId}`)];
        }
        else {
            // Otherwise, get all courses based on state
            const courseState = includeCompleted ? 'all' : 'active';
            courses = await canvasApiRequest(`/courses?enrollment_state=${courseState}`);
        }
        if (courses.length === 0) {
            return {
                content: [{
                        type: "text",
                        text: "No courses found."
                    }]
            };
        }
        // Search assignments in each course
        let allResults = [];
        for (const course of courses) {
            try {
                let url = `/courses/${course.id}/assignments?per_page=50`;
                if (dueAfter)
                    url += `&bucket=due_after&due_after=${dueAfter}`;
                if (dueBefore)
                    url += `&bucket=due_before&due_before=${dueBefore}`;
                const assignments = await canvasApiRequest(url);
                // Filter by search term
                const searchTerms = query.toLowerCase().split(/\s+/);
                const matchingAssignments = assignments.filter((assignment) => {
                    // Search in title
                    const titleMatch = searchTerms.some(term => assignment.name.toLowerCase().includes(term));
                    // Search in description (if available)
                    let descriptionMatch = false;
                    if (assignment.description) {
                        const plainText = htmlToPlainText(assignment.description).toLowerCase();
                        descriptionMatch = searchTerms.some(term => plainText.includes(term));
                    }
                    return titleMatch || descriptionMatch;
                });
                // Add course information to each matching assignment
                matchingAssignments.forEach((assignment) => {
                    allResults.push({
                        ...assignment,
                        courseName: course.name,
                        courseId: course.id
                    });
                });
            }
            catch (error) {
                console.error(`Error searching in course ${course.id}: ${error.message}`);
                // Continue with other courses even if one fails
            }
        }
        // Sort results by due date (closest first)
        allResults.sort((a, b) => {
            if (!a.due_at && !b.due_at)
                return 0;
            if (!a.due_at)
                return 1;
            if (!b.due_at)
                return -1;
            return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
        });
        if (allResults.length === 0) {
            return {
                content: [{
                        type: "text",
                        text: `No assignments found matching "${query}".`
                    }]
            };
        }
        const resultsList = allResults.map((assignment) => {
            const dueDate = assignment.due_at
                ? new Date(assignment.due_at).toLocaleString()
                : 'No due date';
            return `- Course: ${assignment.courseName} (ID: ${assignment.courseId})\n  Assignment: ${assignment.name} (ID: ${assignment.id})\n  Due: ${dueDate}`;
        }).join('\n\n');
        return {
            content: [{
                    type: "text",
                    text: `Found ${allResults.length} assignments matching "${query}":\n\n${resultsList}`
                }]
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Search failed: ${error.message}`
                }],
            isError: true
        };
    }
});
// Get assignment details tool
server.tool("get-assignment", {
    courseId: z.string().or(z.number()).describe("Course ID"),
    assignmentId: z.string().or(z.number()).describe("Assignment ID"),
    formatType: z.enum(['full', 'plain', 'markdown']).default('markdown')
        .describe("Format type: full (HTML), plain (text only), or markdown (formatted)"),
}, async ({ courseId, assignmentId, formatType }) => {
    try {
        const assignment = await canvasApiRequest(`/courses/${courseId}/assignments/${assignmentId}`);
        let description;
        switch (formatType) {
            case 'full':
                description = assignment.description || 'No description available';
                break;
            case 'plain':
                description = htmlToPlainText(assignment.description) || 'No description available';
                break;
            case 'markdown':
            default:
                // Simple HTML to markdown conversion (not perfect but works for basic content)
                description = assignment.description || 'No description available';
                // Replace some HTML elements with markdown
                description = description
                    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
                    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
                    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
                    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
                    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
                    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
                    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
                    .replace(/<ul>(.*?)<\/ul>/gis, (match) => {
                    return match.replace(/<li>(.*?)<\/li>/gi, '- $1\n');
                })
                    .replace(/<ol>(.*?)<\/ol>/gis, (match) => {
                    let index = 1;
                    return match.replace(/<li>(.*?)<\/li>/gi, () => {
                        return `${index++}. $1\n`;
                    });
                })
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
                // Finally, remove any remaining HTML tags
                description = description.replace(/<[^>]*>/g, '');
                break;
        }
        const details = [
            `# ${assignment.name}`,
            ``,
            `**Course ID:** ${courseId}`,
            `**Assignment ID:** ${assignment.id}`,
            `**Due Date:** ${assignment.due_at ? new Date(assignment.due_at).toLocaleString() : 'No due date'}`,
            `**Points Possible:** ${assignment.points_possible}`,
            `**Submission Type:** ${assignment.submission_types?.join(', ') || 'Not specified'}`,
            ``,
            `## Description`,
            ``,
            description
        ].join('\n');
        return {
            content: [{
                    type: "text",
                    text: details
                }]
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Failed to fetch assignment details: ${error.message}`
                }],
            isError: true
        };
    }
});
// Assignment content resource
server.resource("assignment-content", new ResourceTemplate("canvas://courses/{courseId}/assignments/{assignmentId}", { list: undefined }), async (uri, { courseId, assignmentId }) => {
    try {
        const assignment = await canvasApiRequest(`/courses/${courseId}/assignments/${assignmentId}`);
        // Format the content nicely
        const content = [
            `# ${assignment.name}`,
            ``,
            `**Due Date:** ${assignment.due_at ? new Date(assignment.due_at).toLocaleString() : 'No due date'}`,
            `**Points Possible:** ${assignment.points_possible}`,
            `**Submission Type:** ${assignment.submission_types?.join(', ') || 'Not specified'}`,
            ``,
            `## Description`,
            ``,
            assignment.description || 'No description available'
        ].join('\n');
        return {
            contents: [{
                    uri: uri.href,
                    text: content,
                    mimeType: "text/markdown"
                }]
        };
    }
    catch (error) {
        throw new Error(`Failed to fetch assignment content: ${error.message}`);
    }
});
// Start the server
(async () => {
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("Canvas MCP Server started on stdio");
    }
    catch (error) {
        console.error("Server failed to start:", error);
        process.exit(1);
    }
})();
