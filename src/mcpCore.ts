// Shared MCP core logic for both Node.js and Cloudflare Worker environments
// Contains:
// - Canvas API request logic (fetch-based, no Node.js-only APIs)
// - MCP tool/resource handler functions
// - Types/interfaces for Canvas data

// Types
export interface CanvasUser {
  id: number;
  name: string;
  email: string;
}

export interface CanvasCourse {
  id: number;
  name: string;
  term?: { name: string };
}

export interface CanvasAssignment {
  id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  points_possible: number;
  submission_types: string[];
  allowed_extensions: string[] | null;
  allowed_attempts: number | null;
  grading_type: string;
  lock_at: string | null;
  unlock_at: string | null;
  has_group_assignment: boolean;
  group_category_id: number | null;
  peer_reviews: boolean;
  word_count: number | null;
  external_tool_tag_attributes?: { url: string; new_tab: boolean };
  rubric: Array<{ id: string; points: number; description: string; long_description: string | null }> | null;
  use_rubric_for_grading: boolean;
  published: boolean;
  only_visible_to_overrides: boolean;
  locked_for_user: boolean;
  lock_explanation: string | null;
  turnitin_enabled: boolean;
  vericite_enabled: boolean;
  submission_draft_status?: string;
  annotatable_attachment_id?: number;
  anonymize_students: boolean;
  require_lockdown_browser: boolean;
}

// Helper: Canvas API request
export async function canvasApiRequest<T>(path: string, token: string, domain: string, method = 'GET', body?: any): Promise<T> {
  const url = `https://${domain}/api/v1${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Canvas API error: ${response.status} - ${error}`);
  }
  return response.json() as Promise<T>;
}

// Helper: HTML to plain text (simple, no JSDOM)
function htmlToPlainText(html: string | null): string {
  if (!html) return '';
  // Remove tags, decode entities (very basic)
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// Helper: HTML to Markdown (very basic)
function convertHtmlToMarkdown(html: string): string {
  if (!html) return '';
  let text = html;
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  text = text.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b>(.*?)<\/b>/gi, '**$1**');
  text = text.replace(/<em>(.*?)<\/em>/gi, '*$1*');
  text = text.replace(/<i>(.*?)<\/i>/gi, '*$1*');
  text = text.replace(/<ul>(.*?)<\/ul>/gis, (match) => match.replace(/<li>(.*?)<\/li>/gi, '- $1\n'));
  text = text.replace(/<ol>(.*?)<\/ol>/gis, (match) => {
    let index = 1;
    return match.replace(/<li>(.*?)<\/li>/gi, () => `${index++}. $1\n`);
  });
  text = text.replace(/<br\s*\/?>(?!\n)/gi, '\n');
  text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
  text = text.replace(/<[^>]+>/g, '');
  return text;
}

// Helper: Extract links from HTML (very basic)
function extractLinks(html: string | null): { text: string; href: string }[] {
  if (!html) return [];
  const linkRegex = /<a [^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  const links: { text: string; href: string }[] = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    links.push({ text: match[2], href: match[1] });
  }
  return links;
}

// Helper: Date formatting
function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'No date set';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 'Invalid date';
    return date.toLocaleString();
  } catch {
    return 'Invalid date';
  }
}

// Helper: Parse date
function parseDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  try {
    if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

// Helper: Date in range
function isDateInRange(date: string | null, before?: string, after?: string): boolean {
  if (!date) return true;
  const dueDate = parseDate(date);
  if (!dueDate) return true;
  if (before) {
    const beforeDate = parseDate(before);
    if (beforeDate) {
      beforeDate.setHours(23, 59, 59, 999);
      if (dueDate.getTime() > beforeDate.getTime()) return false;
    }
  }
  if (after) {
    const afterDate = parseDate(after);
    if (afterDate) {
      afterDate.setHours(0, 0, 0, 0);
      if (dueDate.getTime() < afterDate.getTime()) return false;
    }
  }
  return true;
}

// Handler: List Courses
export async function listCoursesHandler(params: { state: string }, token: string, domain: string): Promise<any> {
  const state = params.state || 'active';
  const courses = await canvasApiRequest<CanvasCourse[]>(`/courses?enrollment_state=${state}&include[]=term`, token, domain);
  if (courses.length === 0) {
    return { content: [{ type: 'text', text: `No ${state} courses found.` }] };
  }
  const courseList = courses.map((course) => {
    const termName = course.term ? `(${course.term.name})` : '';
    return `- ID: ${course.id} | ${course.name} ${termName}`;
  }).join('\n');
  return { content: [{ type: 'text', text: `Your ${state} courses:\n\n${courseList}` }] };
}

// Handler: Search Assignments
export async function searchAssignmentsHandler(params: any, token: string, domain: string): Promise<any> {
  const { query = '', dueBefore, dueAfter, includeCompleted, courseId } = params;
  let courses: CanvasCourse[];
  if (courseId) {
    courses = [await canvasApiRequest<CanvasCourse>(`/courses/${courseId}`, token, domain)];
  } else {
    const courseState = includeCompleted ? 'all' : 'active';
    courses = await canvasApiRequest<CanvasCourse[]>(`/courses?enrollment_state=${courseState}`, token, domain);
  }
  if (courses.length === 0) {
    return { content: [{ type: 'text', text: 'No courses found.' }] };
  }
  let allResults: any[] = [];
  for (const course of courses) {
    try {
      let assignmentsUrl = `/courses/${course.id}/assignments?per_page=50`;
      const paramsUrl = new URLSearchParams();
      if (dueAfter && !dueBefore) paramsUrl.append('bucket', 'future');
      else if (dueBefore && !dueAfter) paramsUrl.append('bucket', 'past');
      if (dueAfter) {
        const afterDate = parseDate(dueAfter);
        if (afterDate) {
          afterDate.setHours(0, 0, 0, 0);
          paramsUrl.append('due_after', afterDate.toISOString());
        }
      }
      if (dueBefore) {
        const beforeDate = parseDate(dueBefore);
        if (beforeDate) {
          beforeDate.setHours(23, 59, 59, 999);
          paramsUrl.append('due_before', beforeDate.toISOString());
        }
      }
      if (paramsUrl.toString()) assignmentsUrl += `&${paramsUrl.toString()}`;
      const assignments = await canvasApiRequest<CanvasAssignment[]>(assignmentsUrl, token, domain);
      const searchTerms = query.toLowerCase().split(/\s+/).filter((term: string) => term.length > 0);
      const matchingAssignments = searchTerms.length > 0 ? assignments.filter((assignment) => {
        const titleMatch = searchTerms.some((term: string) => assignment.name.toLowerCase().includes(term));
        const descriptionMatch = assignment.description ? searchTerms.some((term: string) => htmlToPlainText(assignment.description).toLowerCase().includes(term)) : false;
        return titleMatch || descriptionMatch;
      }) : assignments;
      const dateFilteredAssignments = matchingAssignments.filter((assignment) => {
        if ((dueAfter && !dueBefore && paramsUrl.has('bucket')) || (dueBefore && !dueAfter && paramsUrl.has('bucket'))) return true;
        return isDateInRange(assignment.due_at, dueBefore, dueAfter);
      });
      dateFilteredAssignments.forEach((assignment) => {
        allResults.push({ ...assignment, courseName: course.name, courseId: course.id });
      });
    } catch (error) {
      // Continue with other courses even if one fails
    }
  }
  allResults.sort((a, b) => {
    if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return 1;
    if (!b.due_at) return -1;
    const dateA = parseDate(a.due_at);
    const dateB = parseDate(b.due_at);
    if (!dateA || !dateB) return 0;
    return dateA.getTime() - dateB.getTime();
  });
  if (allResults.length === 0) {
    const dateRange = [];
    if (dueAfter) dateRange.push(`after ${dueAfter}`);
    if (dueBefore) dateRange.push(`before ${dueBefore}`);
    const dateStr = dateRange.length > 0 ? ` due ${dateRange.join(' and ')}` : '';
    const queryStr = query ? ` matching "${query}"` : '';
    return { content: [{ type: 'text', text: `No assignments found${queryStr}${dateStr}.` }] };
  }
  const resultsList = allResults.map((assignment) => {
    const dueDate = assignment.due_at ? new Date(assignment.due_at).toLocaleString() : 'No due date';
    return `- Course: ${assignment.courseName} (ID: ${assignment.courseId})\n  Assignment: ${assignment.name} (ID: ${assignment.id})\n  Due: ${dueDate}`;
  }).join('\n\n');
  return { content: [{ type: 'text', text: `Found ${allResults.length} assignments matching "${query}":\n\n${resultsList}` }] };
}

// Handler: Get Assignment Details
export async function getAssignmentHandler(params: any, token: string, domain: string): Promise<any> {
  const { courseId, assignmentId, formatType = 'markdown' } = params;
  const assignment = await canvasApiRequest<CanvasAssignment>(`/courses/${courseId}/assignments/${assignmentId}`, token, domain);
  let description: string;
  switch (formatType) {
    case 'full':
      description = assignment.description || 'No description available';
      break;
    case 'plain':
      description = htmlToPlainText(assignment.description) || 'No description available';
      break;
    case 'markdown':
    default:
      description = assignment.description ? convertHtmlToMarkdown(assignment.description) : 'No description available';
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
  return { content: [{ type: 'text', text: details }] };
}

// Handler: Assignment Content Resource
export async function assignmentContentHandler(params: any, token: string, domain: string): Promise<any> {
  const { courseId, assignmentId } = params;
  const assignment = await canvasApiRequest<CanvasAssignment>(`/courses/${courseId}/assignments/${assignmentId}`, token, domain);
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
  return { contents: [{ uri: '', text: content, mimeType: 'text/markdown' }] };
}

// Router: Dispatch tool/resource by name
export async function mcpRouter(tool: string, params: any, token: string, domain: string): Promise<any> {
  switch (tool) {
    case 'list_courses':
    case 'list-courses':
      return listCoursesHandler(params, token, domain);
    case 'search_assignments':
    case 'search-assignments':
      return searchAssignmentsHandler(params, token, domain);
    case 'get_assignment':
    case 'get-assignment':
      return getAssignmentHandler(params, token, domain);
    case 'assignment_content':
    case 'assignment-content':
      return assignmentContentHandler(params, token, domain);
    default:
      return { content: [{ type: 'text', text: `Unknown tool/resource: ${tool}` }], isError: true };
  }
}

// MCP Tool/Resource Manifest for client/host discovery
export const mcpManifest = {
  tools: [
    {
      name: 'list_courses',
      description: 'Lists all your Canvas courses. You can filter by active, completed, or all courses.',
      params: {
        state: {
          type: 'string',
          enum: ['active', 'completed', 'all'],
          default: 'active',
          description: 'Filter courses by state: active, completed, or all.'
        }
      }
    },
    {
      name: 'search_assignments',
      description: 'Searches for assignments across your courses by title, description, due date, and more.',
      params: {
        query: { type: 'string', description: 'Search term to find in assignment titles or descriptions.' },
        dueBefore: { type: 'string', description: 'Only include assignments due before this date (YYYY-MM-DD).', optional: true },
        dueAfter: { type: 'string', description: 'Only include assignments due after this date (YYYY-MM-DD).', optional: true },
        includeCompleted: { type: 'boolean', default: false, description: 'Include assignments from completed courses.' },
        courseId: { type: 'string', description: 'Optional: Limit search to a specific course ID.', optional: true }
      }
    },
    {
      name: 'get_assignment',
      description: 'Retrieves detailed information about a specific assignment, including its description and submission requirements.',
      params: {
        courseId: { type: 'string', description: 'Course ID.' },
        assignmentId: { type: 'string', description: 'Assignment ID.' },
        formatType: { type: 'string', enum: ['full', 'plain', 'markdown'], default: 'markdown', description: 'Format type: full (HTML), plain (text only), or markdown (formatted).' }
      }
    }
  ],
  resources: [
    {
      name: 'assignment_content',
      description: 'Retrieves the full content of an assignment in a standardized format.',
      params: {
        courseId: { type: 'string', description: 'Course ID.' },
        assignmentId: { type: 'string', description: 'Assignment ID.' }
      }
    }
  ]
}; 