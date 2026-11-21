/* Shared-roadmap parser: no token, browser storage or network access. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ViReadRoadmapCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STATUSES = new Set(["todo", "in_progress", "review", "blocked", "not_tested", "done"]);
  function parseIssue(issue) {
    if (!issue || issue.pull_request || typeof issue.body !== "string") return null;
    const marker = issue.body.match(/<!--\s*viread-roadmap:v1\s*([\s\S]*?)-->/i);
    if (!marker) return null;
    const meta = {};
    for (const line of marker[1].split(/\r?\n/)) {
      const match = line.match(/^\s*([a-z_]+):\s*(.*?)\s*$/);
      if (match) meta[match[1]] = match[2];
    }
    if (!/^p[1-9][0-9]*$/.test(meta.id || "")) return null;
    if (!STATUSES.has(meta.status)) throw new Error("Invalid roadmap status in issue " + issue.number);
    if (!/^(P0|P1|P2|P3)$/.test(meta.priority || "")) throw new Error("Invalid roadmap priority in issue " + issue.number);
    const description = issue.body.match(/## Mô tả\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/);
    const evidence = issue.body.match(/## Evidence\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/);
    const urls = evidence ? (evidence[1].match(/https:\/\/[^\s)]+/g) || []) : [];
    return {
      id: meta.id,
      title: String(issue.title || "").replace(/^\[p\d+\]\s*/, ""),
      category: meta.category || "Project",
      priority: meta.priority,
      status: meta.status,
      detail: description ? description[1].trim() : "",
      url: issue.html_url || "",
      evidenceUrl: urls[0] || "",
      updatedAt: issue.updated_at || "",
      issueNumber: issue.number
    };
  }
  function reconcileIssues(issues, expectedIds) {
    if (!Array.isArray(issues)) throw new Error("GitHub issues payload is not an array");
    const found = new Map();
    for (const issue of issues) {
      const task = parseIssue(issue);
      if (!task) continue;
      if (found.has(task.id)) throw new Error("Duplicate roadmap task ID: " + task.id);
      found.set(task.id, task);
    }
    const missing = expectedIds.filter(id => !found.has(id));
    if (missing.length) throw new Error("Missing roadmap issues: " + missing.join(", "));
    return expectedIds.map(id => found.get(id));
  }
  function compareLegacy(legacyTasks, sharedTasks) {
    const byId = new Map(sharedTasks.map(task => [task.id, task]));
    const items = Array.isArray(legacyTasks) ? legacyTasks : [];
    return {
      changed: items.filter(task => byId.has(task.id) && byId.get(task.id).status !== task.status).length,
      personal: items.filter(task => !byId.has(task.id)).length
    };
  }
  const ROADMAP_IDS = Object.freeze(Array.from({length:14},(_,i)=>"p"+(i+1)));
  const REPO = "trancuong3/capstone1";
  function validateSnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.repository !== REPO) {
      throw new Error("Unsupported ViRead snapshot schema or repository");
    }
    const generatedAt = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(generatedAt) || generatedAt < Date.parse("2026-01-01T00:00:00Z") ||
        generatedAt > Date.now() + 10*60*1000) {
      throw new Error("Invalid snapshot generation time");
    }
    if (!Array.isArray(snapshot.roadmap) || snapshot.roadmap.length !== ROADMAP_IDS.length) {
      throw new Error("Incomplete shared roadmap snapshot");
    }
    snapshot.roadmap.forEach((task,i)=>{
      if (!task || task.id !== ROADMAP_IDS[i] || !STATUSES.has(task.status) ||
          !/^(P0|P1|P2|P3)$/.test(task.priority) ||
          typeof task.title !== "string" || typeof task.category !== "string" ||
          !/^https:\/\/github\.com\/trancuong3\/capstone1\/issues\/[0-9]+$/.test(task.url||"") ||
          !Number.isInteger(task.issueNumber) || task.issueNumber<1) {
        throw new Error("Invalid snapshot roadmap item: "+ROADMAP_IDS[i]);
      }
    });
    const activity=snapshot.activity;
    if (!activity || ["commits","prs","issues","runs","releases"].some(key=>activity[key] !== null && !Array.isArray(activity[key]))) {
      throw new Error("Incomplete public GitHub activity snapshot");
    }
    return snapshot;
  }
  /* Browser-only legacy data adapter. Never modifies live shared Issue status. */
  function normalizeLocalTasksAndNote(raw, fallbackNote="") {
    if (!raw || typeof raw!=="object" || Array.isArray(raw)) {
      throw new Error("Invalid local backup object");
    }
    if (raw.tasks!==undefined && !Array.isArray(raw.tasks)) {
      throw new Error("Invalid local task list");
    }
    if (raw.note!==undefined && typeof raw.note!=="string") {
      throw new Error("Invalid local note");
    }
    const tasks=raw.tasks===undefined?[]:raw.tasks;
    if (!tasks.every(task=>task && typeof task==="object" && !Array.isArray(task) &&
        typeof task.id==="string")) {
      throw new Error("Invalid local task entry");
    }
    return {...raw,tasks,note:raw.note===undefined?fallbackNote:raw.note};
  }
  function makeLocalExport(original, note, imports, sharedSnapshot, exportedAt) {
    const source=original===null?{}:original;
    const legacy=normalizeLocalTasksAndNote(source,note);
    return {
      format:"viread-local-export-v1",
      exportedAt,
      legacy,
      imports:Array.isArray(imports)?imports:[],
      sharedSnapshot
    };
  }
  function parseLocalImport(data) {
    if (!data || typeof data!=="object" || Array.isArray(data)) {
      throw new Error("Invalid local backup");
    }
    if ("format" in data && data.format!=="viread-local-export-v1") {
      throw new Error("Unknown local backup format");
    }
    const source=data.format==="viread-local-export-v1"?data.legacy:data;
    if (!source || typeof source!=="object" || Array.isArray(source) ||
        !("tasks" in source) && !("note" in source)) {
      throw new Error("Missing local tasks or note");
    }
    const legacy=normalizeLocalTasksAndNote(source);
    return {tasks:legacy.tasks,note:legacy.note};
  }
  return { parseIssue, reconcileIssues, compareLegacy, validateSnapshot, ROADMAP_IDS,
    makeLocalExport, parseLocalImport };


});
