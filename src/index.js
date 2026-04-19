// === scanbim-health patch: security headers + /health + favicon ===
const __SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://developer.api.autodesk.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://*.autodesk.com https://uptime.scanbimlabs.io https://developer.api.autodesk.com"
};
const __FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f97316"/><text x="16" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-size="18" font-weight="800" fill="#fff">S</text></svg>`;
const __BUILD = globalThis.__BUILD__ || 'dev';
const __START = Date.now();
const __SLUG = "acc-mcp";
const __VERSION = "1.0.0";
async function __handleHealth(env) {
  const deps = {};
  try { const r = await fetch('https://developer.api.autodesk.com/authentication/v2/token', { method: 'HEAD' }); deps.aps = r.status < 500 ? 'ok' : 'degraded'; } catch { deps.aps = 'down'; }
  if (env && env.CACHE) { try { await env.CACHE.get('_hc'); deps.kv = 'ok'; } catch { deps.kv = 'degraded'; } }
  if (env && env.DB)    { try { await env.DB.prepare('SELECT 1').first(); deps.d1 = 'ok'; } catch { deps.d1 = 'degraded'; } }
  const worst = Object.values(deps).reduce((w, v) => v === 'down' ? 'down' : v === 'degraded' && w !== 'down' ? 'degraded' : w, 'ok');
  return Response.json({ status: worst, service: __SLUG, version: (env && env.VERSION) || __VERSION, build: __BUILD, ts: new Date().toISOString(), uptime_s: Math.floor((Date.now() - __START) / 1000), deps });
}
function __applySec(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(__SEC_HEADERS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
// === end patch header ===

// ACC MCP Worker v1.0.1 — APS-Backed ACC/BIM 360 Tools
// ScanBIM Labs LLC | Ian Martin

const APS_BASE = 'https://developer.api.autodesk.com';

const SERVER_INFO = {
  name: "acc-mcp",
  version: "1.0.1",
  description: "Autodesk Construction Cloud integration via APS. Manage projects, issues, RFIs, documents, and submittals.",
  author: "ScanBIM Labs LLC"
};

async function getAPSToken(env, scope = 'data:read data:write data:create') {
  const cacheKey = `aps_token_${scope.replace(/\s/g,'_')}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return cached;
  }
  const resp = await fetch(`${APS_BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.APS_CLIENT_ID,
      client_secret: env.APS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope
    })
  });
  if (!resp.ok) throw new Error(`APS auth failed`);
  const data = await resp.json();
  const token = data.access_token;
  if (env.CACHE) await env.CACHE.put(cacheKey, token, { expirationTtl: data.expires_in - 60 });
  return token;
}

async function listHubs(token) {
  const resp = await fetch(`${APS_BASE}/project/v1/hubs`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`List hubs failed`);
  return await resp.json();
}

async function listProjects(token, hubId) {
  const resp = await fetch(`${APS_BASE}/project/v1/hubs/${hubId}/projects`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`List projects failed`);
  return await resp.json();
}

const TOOLS = [
  {
    name: "acc_list_projects",
    description: "Enumerate every ACC and BIM 360 project the authenticated APS app can see by walking all accessible hubs and their project lists.\n\nWhen to use: The agent needs to discover project IDs before calling any other tool (e.g. the user says 'show me my projects' or 'find issues in the Tower project' and no project_id is known yet). Also useful to confirm hub membership for a project.\n\nWhen NOT to use: Do not call this repeatedly in a loop — cache the result; if the user already supplied a project_id starting with 'b.', skip discovery.\n\nAPS scopes: data:read account:read. No write scope needed.\n\nRate limits: APS default ~50 req/min per app per endpoint; BIM 360 hubs endpoints are pageable (limit 200). This tool fans out 1 hubs call + N project calls (one per hub) so call it sparingly on tenants with many hubs.\n\nErrors: 401 (APS token expired — refresh and retry once); 403 (app not provisioned in the BIM 360/ACC account — ask user to have an account admin add the APS client_id); 404 (rare, indicates hub deleted mid-call); 429 (rate limit — back off 60s); 5xx (ACC upstream — retry with jitter).\n\nSide effects: None. Read-only and idempotent.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "acc_create_issue",
    description: "Create a new ACC issue (field observation, coordination clash, safety, quality, etc.) in the target project via the APS Construction Issues API.\n\nWhen to use: The user wants to log a new issue — e.g. 'open a high-priority issue about the leaking valve on level 3' or a downstream agent detected a defect during a model review and needs to record it for the project team.\n\nWhen NOT to use: Do not use to modify an existing issue (use acc_update_issue) and do not use for RFIs (use acc_create_rfi).\n\nAPS scopes: data:read data:write account:read.\n\nRate limits: ACC Issues API limited to ~100 req/min per app; APS default ~50 req/min per endpoint — batch creations with backoff.\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks 'Create Issues' permission on the project or scope insufficient — surface to user); 404 (project_id not found — verify the 'b.' prefix and that the project belongs to a hub the app can see via acc_list_projects); 422 (validation — required field like title/description missing or priority enum invalid); 429 (rate limit — retry after 60s); 5xx (ACC upstream — retry with jitter, do not double-create).\n\nSide effects: Creates a persistent issue record visible to all project members. NOT idempotent — a retry on a 5xx may create duplicates; dedupe by title before retrying.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use the 'b.' prefix literal (e.g. 'b.a1b2c3d4-...'). The worker strips the prefix internally for the Issues endpoint. Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        title: { type: "string", description: "Short issue title, 1–255 chars. Required.", examples: ["Leaking valve on Level 3 mech room"] },
        description: { type: "string", description: "Detailed issue description / body. Plain text, up to ~10,000 chars. Required.", examples: ["Observed active drip at VAV-312 supply connection during 2026-04-18 walkthrough. Photos attached in linked RFI."] },
        priority: { type: "string", enum: ["critical","high","medium","low"], description: "Issue priority. Defaults to 'medium' if omitted.", examples: ["high"] },
        assigned_to: { type: "string", description: "Optional APS user ID (oxygen ID / ACC user UUID) of the assignee. Leave null for unassigned.", examples: ["ABC123XYZ456"] },
        due_date: { type: "string", description: "Optional due date in ISO 8601 date format (YYYY-MM-DD).", examples: ["2026-05-01"] }
      },
      required: ["project_id", "title", "description"]
    }
  },
  {
    name: "acc_update_issue",
    description: "Patch an existing ACC issue — change status, priority, assignee, or description via the APS Construction Issues API.\n\nWhen to use: The user asks to close/reopen/escalate an issue, reassign it, or edit its body. Typical agent flow: acc_list_issues → pick an id → acc_update_issue.\n\nWhen NOT to use: Do not use to create issues (acc_create_issue) or to add comments (not supported by this server).\n\nAPS scopes: data:read data:write account:read.\n\nRate limits: ACC Issues API ~100 req/min per app; APS default ~50 req/min per endpoint.\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks edit permission or status transition not allowed by project workflow); 404 (project_id or issue_id not found — verify 'b.' prefix on project_id and that issue_id belongs to that project); 422 (validation — invalid status/priority enum or illegal state transition); 429 (rate limit — back off 60s); 5xx (ACC upstream — retry with jitter).\n\nSide effects: Mutates the issue record. Idempotent when the same body is resent (PATCH semantics) — safe to retry.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use the 'b.' prefix literal. Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        issue_id: { type: "string", description: "UUID of the issue to update, as returned by acc_list_issues or acc_create_issue.", examples: ["7f3e2a1b-4c5d-6e7f-8a9b-0c1d2e3f4a5b"] },
        status: { type: "string", enum: ["open","in_review","closed","draft"], description: "New status. Project workflow may forbid certain transitions (e.g. draft → closed).", examples: ["closed"] },
        priority: { type: "string", enum: ["critical","high","medium","low"], description: "New priority.", examples: ["critical"] },
        assigned_to: { type: "string", description: "APS user ID of the new assignee. Omit to leave unchanged.", examples: ["ABC123XYZ456"] },
        description: { type: "string", description: "Replacement description body. Plain text.", examples: ["Root cause confirmed as cracked fitting; scheduling replacement."] }
      },
      required: ["project_id", "issue_id"]
    }
  },
  {
    name: "acc_list_issues",
    description: "List and filter issues from a single ACC project (limit 50 per call) via the APS Construction Issues API.\n\nWhen to use: The user or upstream agent needs to review open issues, count issues by status/priority, or look up an issue_id before calling acc_update_issue. E.g. 'show me all critical open issues on the Tower project'.\n\nWhen NOT to use: Do not use to fetch RFIs (use acc_list_rfis) or to search documents.\n\nAPS scopes: data:read account:read. No write scope required.\n\nRate limits: ACC Issues API ~100 req/min per app; results pageable (limit 50 here, max 200 upstream). For large projects, call once and filter client-side instead of looping.\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks 'View Issues' permission on project or scope insufficient); 404 (project_id not found — verify 'b.' prefix and hub membership via acc_list_projects); 422 (invalid filter value — check status/priority spelling); 429 (rate limit — back off 60s); 5xx (ACC upstream — retry with jitter).\n\nSide effects: None. Read-only and idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use 'b.' prefix literal. Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        status: { type: "string", description: "Optional status filter. Typical values: open, in_review, closed, draft.", examples: ["open"] },
        priority: { type: "string", description: "Optional priority filter. Typical values: critical, high, medium, low.", examples: ["critical"] },
        assigned_to: { type: "string", description: "Optional assignee APS user ID filter. Accepted but not currently forwarded as a URL filter by this server — filter client-side if needed.", examples: ["ABC123XYZ456"] }
      },
      required: ["project_id"]
    }
  },
  {
    name: "acc_create_rfi",
    description: "Create a new Request For Information (RFI) in an ACC project via the APS Construction RFIs API. RFI is created in 'draft' status — the project workflow owner typically transitions it to 'submitted'.\n\nWhen to use: The user needs a formal question-of-record to the design or GC team — e.g. 'raise an RFI asking for clarification on the Level 2 beam schedule'. RFIs are the auditable channel for clarifications; issues are for field observations.\n\nWhen NOT to use: Do not use for informal observations (use acc_create_issue) or to answer an existing RFI (not supported here).\n\nAPS scopes: data:read data:write account:read.\n\nRate limits: APS default ~50 req/min per endpoint per app. RFIs share the Construction API umbrella with issues (~100 req/min combined).\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks RFI create permission on project); 404 (project_id not found — verify 'b.' prefix and hub membership); 422 (validation — subject/question missing or priority enum invalid); 429 (rate limit — back off 60s); 5xx (ACC upstream — retry with jitter, check for duplicate before retrying).\n\nSide effects: Creates a persistent RFI record. NOT idempotent — retry on 5xx risks duplicates; dedupe by subject before retrying.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use 'b.' prefix literal. Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        subject: { type: "string", description: "Short RFI subject/title, 1–255 chars. Required.", examples: ["Clarification on Level 2 beam schedule"] },
        question: { type: "string", description: "Full RFI question body. Plain text, up to ~10,000 chars. Required.", examples: ["Drawing S-201 shows W14x22 but schedule lists W14x26 for gridline C/4. Please confirm which is correct."] },
        assigned_to: { type: "string", description: "Optional APS user ID of the person the RFI is directed to.", examples: ["ABC123XYZ456"] },
        priority: { type: "string", enum: ["critical","high","medium","low"], description: "RFI priority. Defaults to 'medium' if omitted.", examples: ["high"] }
      },
      required: ["project_id", "subject", "question"]
    }
  },
  {
    name: "acc_list_rfis",
    description: "List and filter RFIs from a single ACC project (limit 50 per call) via the APS Construction RFIs API.\n\nWhen to use: The user wants to review open RFIs, count outstanding ones, or look up an RFI ID. E.g. 'how many RFIs are still open on the Tower project?'\n\nWhen NOT to use: Do not use for issues (use acc_list_issues) or document search (use acc_search_documents).\n\nAPS scopes: data:read account:read. No write scope required.\n\nRate limits: APS default ~50 req/min per endpoint; ACC Construction API shared ~100 req/min cap. Pageable (limit 50 here; upstream max 200).\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks RFI view permission); 404 (project_id not found — verify 'b.' prefix and hub membership); 422 (invalid filter value); 429 (rate limit — back off 60s); 5xx (ACC upstream — retry).\n\nSide effects: None. Read-only and idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use 'b.' prefix literal. Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        status: { type: "string", description: "Optional RFI status filter. Typical values: draft, submitted, open, answered, closed, void.", examples: ["open"] }
      },
      required: ["project_id"]
    }
  },
  {
    name: "acc_search_documents",
    description: "Full-text search the ACC Docs repository of a project for drawings, specs, submittals, and other files via the APS Data Management search endpoint.\n\nWhen to use: The user wants to find a document by keyword (filename, sheet number, or metadata match). E.g. 'find the latest A-201 sheet' or 'search for mechanical specs on Tower project'.\n\nWhen NOT to use: Do not use to upload a file (use acc_upload_file); do not use to fetch issues/RFIs. If you already have a document URN, fetch it directly with an agent that has Data Management folder/item access.\n\nAPS scopes: data:read account:read. No write scope required.\n\nRate limits: APS Data Management ~50 req/min per app per endpoint; pageable (limit 200 upstream). Avoid tight query loops.\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks Docs view permission on the project); 404 (project_id not found — verify 'b.' prefix and hub membership); 422 (invalid filter syntax — simplify query text); 429 (rate limit — back off 60s); 5xx (ACC upstream — retry with jitter).\n\nSide effects: None. Read-only and idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use 'b.' prefix literal. The worker re-adds the prefix for Data Management URL formatting. Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        query: { type: "string", description: "Free-text search string matched against filenames, titles, and indexed metadata. 1–500 chars.", examples: ["A-201 floor plan"] },
        document_type: { type: "string", description: "Optional APS document type filter (e.g. 'items:autodesk.bim360:File', 'items:autodesk.bim360:Document').", examples: ["items:autodesk.bim360:Document"] }
      },
      required: ["project_id", "query"]
    }
  },
  {
    name: "acc_upload_file",
    description: "Upload a file from a public source URL into an ACC project folder. Runs the full four-step APS Data Management flow: top-folder discovery → storage object creation → OSS PUT of bytes → first-version item creation.\n\nWhen to use: The user wants to push a document/photo/model into ACC Docs — e.g. 'upload this site photo to the Tower project Photos folder' or an automation needs to archive an exported report into Project Files.\n\nWhen NOT to use: Do not use for files already in ACC; do not use for files behind auth-gated URLs (fetch step is an unauthenticated GET). For very large files (>100MB), prefer the chunked/signed-S3 upload flow, not this single-PUT implementation.\n\nAPS scopes: data:read data:write data:create account:read.\n\nRate limits: APS Data Management ~50 req/min per endpoint; OSS upload bandwidth typically 100 MB/min per app. This tool issues 3–5 APS calls per upload, so budget accordingly.\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks folder write permission — ask account admin to grant 'Edit' on folder); 404 (project_id not found or folder_path does not match any top folder — verify 'b.' prefix, hub membership, and folder name); 422 (invalid file_name or conflicting version); 429 (rate limit — back off 60s); 5xx (ACC/OSS upstream — retry with jitter BUT be cautious: storage object may already be created so reuse, do not re-create). Also: if source file_url returns non-2xx, the tool throws before touching ACC.\n\nSide effects: Creates a storage object, uploads bytes, and creates a versioned item in the target folder. NOT idempotent — a retry may create a duplicate item with a new version. Surface the returned item_id to the user to avoid re-uploads.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use 'b.' prefix literal. Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        file_url: { type: "string", description: "Publicly fetchable HTTPS URL of the source file. Must return 2xx to an unauthenticated GET. Max practical size ~100MB for this single-PUT implementation.", examples: ["https://cdn.example.com/photos/site-2026-04-18.jpg"] },
        file_name: { type: "string", description: "Destination filename in ACC, including extension. 1–255 chars. Avoid path separators.", examples: ["site-2026-04-18.jpg"] },
        folder_path: { type: "string", description: "Case-insensitive substring of the target top-level folder's display name. Defaults to 'Project Files'. Common values: 'Project Files', 'Plans', 'Photos', 'Submittals'.", examples: ["Photos"] }
      },
      required: ["project_id", "file_url", "file_name"]
    }
  },
  {
    name: "acc_project_summary",
    description: "Fetch the full ACC project metadata record (name, type, status, dates, extension attributes) for a single project via APS Data Management. If hub_id is omitted the tool picks the first accessible hub, which may be wrong on multi-hub tenants.\n\nWhen to use: The user asks 'tell me about project X' or an agent needs project metadata (start/end dates, type, Forma/BIM 360 flavor) before deciding which downstream tool to call.\n\nWhen NOT to use: Do not use as a cheap existence check — prefer acc_list_projects which returns hub_id with every project and is one call regardless of tenant size.\n\nAPS scopes: data:read account:read. Forma / BIM 360 hubs endpoints only require data:read.\n\nRate limits: APS default ~50 req/min per endpoint; BIM 360 hubs endpoints pageable (limit 200). Cache results for the session.\n\nErrors: 401 (APS token expired — refresh); 403 (user lacks project view or app not in account); 404 (project not in the chosen hub — supply the correct hub_id, or call acc_list_projects first); 422 (malformed project_id — confirm 'b.' prefix); 429 (rate limit — back off 60s); 5xx (ACC upstream — retry).\n\nSide effects: None. Read-only and idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ACC project ID. MUST use 'b.' prefix literal (this endpoint — unlike Issues/RFIs — wants the prefixed form). Obtain via acc_list_projects.", examples: ["b.a1b2c3d4-1234-5678-9abc-def012345678"] },
        hub_id: { type: "string", description: "Optional ACC/BIM 360 hub ID. Also uses the 'b.' prefix literal. If omitted, the first hub returned by APS is used — prefer supplying this explicitly on multi-hub tenants to avoid 404s.", examples: ["b.abcdef01-2345-6789-abcd-ef0123456789"] }
      },
      required: ["project_id"]
    }
  }
];

async function handleTool(name, args, env) {
  if (env.DB) {
    try { await env.DB.prepare("INSERT INTO usage_log (tool_name, model_id, created_at) VALUES (?, ?, ?)").bind(name, args.project_id || null, new Date().toISOString()).run(); } catch (e) {}
  }

  switch (name) {
    case "acc_list_projects": {
      const token = await getAPSToken(env, 'data:read');
      const hubs = await listHubs(token);
      const results = [];
      for (const hub of (hubs.data || [])) {
        const projects = await listProjects(token, hub.id);
        for (const p of (projects.data || [])) {
          results.push({ hub_id: hub.id, hub_name: hub.attributes?.name, project_id: p.id, project_name: p.attributes?.name, type: p.attributes?.extension?.type });
        }
      }
      return { status: "success", project_count: results.length, projects: results };
    }

    case "acc_create_issue": {
      const token = await getAPSToken(env, 'data:read data:write');
      const cleanId = args.project_id.replace(/^b\./, '');
      const resp = await fetch(`${APS_BASE}/construction/issues/v1/projects/${cleanId}/issues`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: args.title,
          description: args.description,
          status: 'open',
          priority: args.priority || 'medium',
          assignedTo: args.assigned_to || null,
          dueDate: args.due_date || null
        })
      });
      if (!resp.ok) throw new Error(`Create issue failed: ${await resp.text()}`);
      const issue = await resp.json();
      return { status: "success", issue_id: issue.data?.id || issue.id, title: args.title, priority: args.priority || 'medium', project_id: args.project_id };
    }

    case "acc_update_issue": {
      const token = await getAPSToken(env, 'data:read data:write');
      const cleanId = args.project_id.replace(/^b\./, '');
      const updateBody = {};
      if (args.status) updateBody.status = args.status;
      if (args.priority) updateBody.priority = args.priority;
      if (args.assigned_to) updateBody.assignedTo = args.assigned_to;
      if (args.description) updateBody.description = args.description;
      const resp = await fetch(`${APS_BASE}/construction/issues/v1/projects/${cleanId}/issues/${args.issue_id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody)
      });
      if (!resp.ok) throw new Error(`Update issue failed: ${await resp.text()}`);
      const issue = await resp.json();
      return { status: "success", issue_id: args.issue_id, updated_fields: Object.keys(updateBody) };
    }

    case "acc_list_issues": {
      const token = await getAPSToken(env, 'data:read');
      const cleanId = args.project_id.replace(/^b\./, '');
      let url = `${APS_BASE}/construction/issues/v1/projects/${cleanId}/issues?limit=50`;
      if (args.status) url += `&filter[status]=${args.status}`;
      if (args.priority) url += `&filter[priority]=${args.priority}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`List issues failed: ${await resp.text()}`);
      const data = await resp.json();
      const issues = (data.data || data.results || []).map(function(i) {
        return {
          id: i.id,
          title: i.attributes ? i.attributes.title : i.title,
          status: i.attributes ? i.attributes.status : i.status,
          priority: i.attributes ? i.attributes.priority : i.priority,
          due_date: i.attributes ? i.attributes.dueDate : i.due_date
        };
      });
      return { status: "success", project_id: args.project_id, issue_count: issues.length, issues: issues };
    }

    case "acc_create_rfi": {
      const token = await getAPSToken(env, 'data:read data:write');
      const cleanId = args.project_id.replace(/^b\./, '');
      const resp = await fetch(`${APS_BASE}/construction/rfis/v1/projects/${cleanId}/rfis`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: args.subject,
          question: args.question,
          assignedTo: args.assigned_to || null,
          priority: args.priority || 'medium',
          status: 'draft'
        })
      });
      if (!resp.ok) throw new Error(`Create RFI failed: ${await resp.text()}`);
      const rfi = await resp.json();
      return { status: "success", rfi_id: rfi.data?.id || rfi.id, subject: args.subject, project_id: args.project_id };
    }

    case "acc_list_rfis": {
      const token = await getAPSToken(env, 'data:read');
      const cleanId = args.project_id.replace(/^b\./, '');
      let url = `${APS_BASE}/construction/rfis/v1/projects/${cleanId}/rfis?limit=50`;
      if (args.status) url += `&filter[status]=${args.status}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`List RFIs failed: ${await resp.text()}`);
      const data = await resp.json();
      const rfis = (data.data || data.results || []).map(function(r) {
        return {
          id: r.id,
          subject: r.attributes ? r.attributes.subject : r.subject,
          status: r.attributes ? r.attributes.status : r.status
        };
      });
      return { status: "success", project_id: args.project_id, rfi_count: rfis.length, rfis: rfis };
    }

    case "acc_search_documents": {
      const token = await getAPSToken(env, 'data:read');
      const cleanId = args.project_id.replace(/^b\./, '');
      let url = `${APS_BASE}/data/v1/projects/b.${cleanId}/search?filter[text]=${encodeURIComponent(args.query)}`;
      if (args.document_type) url += `&filter[type]=${args.document_type}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`Document search failed: ${await resp.text()}`);
      const data = await resp.json();
      return { status: "success", project_id: args.project_id, query: args.query, results: data.data || [] };
    }

    case "acc_upload_file": {
      const token = await getAPSToken(env, 'data:read data:write data:create');
      const cleanId = args.project_id.replace(/^b\./, '');
      const projectId = `b.${cleanId}`;
      const folderPath = args.folder_path || "Project Files";

      // Step 1: Get top-level folder for the project
      const foldersResp = await fetch(
        `${APS_BASE}/project/v1/hubs/b.${cleanId.split('.')[0] || cleanId}/projects/${projectId}/topFolders`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Fallback: try listing hubs first to get the correct hub ID
      let folderId = null;
      if (foldersResp.ok) {
        const foldersData = await foldersResp.json();
        const targetFolder = (foldersData.data || []).find(function(f) {
          const name = f.attributes?.displayName || f.attributes?.name || '';
          return name.toLowerCase().includes(folderPath.toLowerCase());
        });
        if (targetFolder) folderId = targetFolder.id;

        // If no match, use the first folder (usually "Project Files")
        if (!folderId && foldersData.data && foldersData.data.length > 0) {
          folderId = foldersData.data[0].id;
        }
      }

      if (!folderId) {
        // Try alternate hub discovery
        const hubs = await listHubs(token);
        for (const hub of (hubs.data || [])) {
          const tfResp = await fetch(
            `${APS_BASE}/project/v1/hubs/${hub.id}/projects/${projectId}/topFolders`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (tfResp.ok) {
            const tfData = await tfResp.json();
            const match = (tfData.data || []).find(function(f) {
              const name = f.attributes?.displayName || f.attributes?.name || '';
              return name.toLowerCase().includes(folderPath.toLowerCase());
            });
            folderId = match ? match.id : (tfData.data?.[0]?.id || null);
            if (folderId) break;
          }
        }
      }

      if (!folderId) {
        return { status: "error", message: "Could not find target folder in project. Verify project_id and folder_path." };
      }

      // Step 2: Create storage location
      const storageResp = await fetch(`${APS_BASE}/data/v1/projects/${projectId}/storage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' },
        body: JSON.stringify({
          jsonapi: { version: "1.0" },
          data: {
            type: "objects",
            attributes: { name: args.file_name },
            relationships: {
              target: {
                data: { type: "folders", id: folderId }
              }
            }
          }
        })
      });

      if (!storageResp.ok) {
        const errText = await storageResp.text();
        throw new Error(`Storage creation failed (${storageResp.status}): ${errText}`);
      }

      const storageData = await storageResp.json();
      const objectId = storageData.data?.id;

      if (!objectId) {
        throw new Error("No storage object ID returned");
      }

      // Extract the signed upload URL from the storage object ID
      // Format: urn:adsk.objects:os.object:wip.dm.prod/GUID
      const bucketKey = objectId.split(':').pop().split('/')[0];
      const objectKey = objectId.split('/').slice(1).join('/');
      const uploadUrl = `${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}`;

      // Step 3: Fetch file from source URL and upload to APS storage
      const fileResp = await fetch(args.file_url);
      if (!fileResp.ok) {
        throw new Error(`Cannot fetch source file from ${args.file_url}`);
      }
      const fileBytes = await fileResp.arrayBuffer();
      const fileSizeMB = (fileBytes.byteLength / 1048576).toFixed(2);

      const ossResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileBytes.byteLength.toString()
        },
        body: fileBytes
      });

      if (!ossResp.ok) {
        const errText = await ossResp.text();
        throw new Error(`File upload failed (${ossResp.status}): ${errText}`);
      }

      // Step 4: Create first version (item) in the folder
      const itemResp = await fetch(`${APS_BASE}/data/v1/projects/${projectId}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' },
        body: JSON.stringify({
          jsonapi: { version: "1.0" },
          data: {
            type: "items",
            attributes: {
              displayName: args.file_name,
              extension: {
                type: "items:autodesk.bim360:File",
                version: "1.0"
              }
            },
            relationships: {
              tip: {
                data: { type: "versions", id: "1" }
              },
              parent: {
                data: { type: "folders", id: folderId }
              }
            }
          },
          included: [{
            type: "versions",
            id: "1",
            attributes: {
              name: args.file_name,
              extension: {
                type: "versions:autodesk.bim360:File",
                version: "1.0"
              }
            },
            relationships: {
              storage: {
                data: { type: "objects", id: objectId }
              }
            }
          }]
        })
      });

      if (!itemResp.ok) {
        const errText = await itemResp.text();
        throw new Error(`Item creation failed (${itemResp.status}): ${errText}`);
      }

      const itemData = await itemResp.json();
      const itemId = itemData.data?.id;
      const versionId = itemData.included?.[0]?.id;

      return {
        status: "success",
        project_id: args.project_id,
        folder_id: folderId,
        folder_path: folderPath,
        file_name: args.file_name,
        file_size_mb: fileSizeMB,
        item_id: itemId,
        version_id: versionId,
        storage_object_id: objectId,
        upload_status: "complete",
        timestamp: new Date().toISOString()
      };
    }

    case "acc_project_summary": {
      const token = await getAPSToken(env, 'data:read');
      const hubs = await listHubs(token);
      const hubId = args.hub_id || (hubs.data && hubs.data[0] ? hubs.data[0].id : null);
      if (!hubId) return { status: "error", message: "No hubs found" };
      const resp = await fetch(`${APS_BASE}/project/v1/hubs/${hubId}/projects/${args.project_id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!resp.ok) throw new Error(`Project summary failed: ${await resp.text()}`);
      const summary = await resp.json();
      return { status: "success", project: summary.data?.attributes || summary, hub_id: hubId };
    }

    default:
      return { status: "error", message: "Unknown tool: " + name };
  }
}

async function handleMCP(req, env) {
  const body = await req.json();
  var method = body.method;
  var params = body.params;
  var id = body.id;
  var respond = function(result) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: id, result: result }), { headers: { 'Content-Type': 'application/json' } }); };
  var error = function(code, msg) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: id, error: { code: code, message: msg } }), { headers: { 'Content-Type': 'application/json' } }); };

  if (method === 'initialize') return respond({ protocolVersion: "2024-11-05", serverInfo: SERVER_INFO, capabilities: { tools: {} } });
  if (method === 'tools/list') return respond({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      var result = await handleTool(params.name, params.arguments || {}, env);
      return respond({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return respond({ content: [{ type: "text", text: JSON.stringify({ status: "error", message: e.message }) }] });
    }
  }
  if (method === 'ping') return respond({});
  return error(-32601, "Method not found");
}

const __origHandler = {
  async fetch(req, env) {
    var url = new URL(req.url);
    var cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/mcp' && req.method === 'POST') {
      var resp = await handleMCP(req, env);
      Object.entries(cors).forEach(function(e) { resp.headers.set(e[0], e[1]); });
      return resp;
    }

    if (url.pathname === '/info' || url.pathname === '/') {
      return new Response(JSON.stringify({ name: SERVER_INFO.name, version: SERVER_INFO.version, description: SERVER_INFO.description, tools_count: TOOLS.length }, null, 2), { headers: Object.assign({}, cors, { 'Content-Type': 'application/json' }) });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: "ok", version: SERVER_INFO.version, aps_configured: !!(env.APS_CLIENT_ID && env.APS_CLIENT_SECRET) }), { headers: Object.assign({}, cors, { 'Content-Type': 'application/json' }) });
    }

    return new Response('ACC MCP v1.0.1 by ScanBIM Labs', { headers: cors });
  }
};

// === scanbim-health patch: export default wrapper ===
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return __applySec(await __handleHealth(env));
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      return __applySec(new Response(__FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' } }));
    }
    const resp = await __origHandler.fetch(req, env, ctx);
    return __applySec(resp);
  },
  async scheduled(event, env, ctx) {
    if (__origHandler.scheduled) return __origHandler.scheduled(event, env, ctx);
  }
};
