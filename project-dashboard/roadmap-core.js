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
  return { parseIssue, reconcileIssues, compareLegacy };
});
