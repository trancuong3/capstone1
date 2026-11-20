"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {parseIssue, reconcileIssues, compareLegacy} = require("./roadmap-core.js");

function issue(id, status, number) {
  return {
    number, title: "[" + id + "] Test title",
    html_url: "https://github.com/trancuong3/capstone1/issues/" + number,
    updated_at: "2026-11-20T12:00:00Z",
    body: "<!-- viread-roadmap:v1\nid: " + id + "\nstatus: " + status +
      "\npriority: P1\ncategory: Android\n-->\n## Mô tả\nTest description\n" +
      "## Evidence\n- https://github.com/trancuong3/capstone1/pull/143\n"
  };
}
test("read status, stable ID, timestamp and evidence from a GitHub issue", () => {
  const task = parseIssue(issue("p3", "blocked", 152));
  assert.equal(task.id, "p3");
  assert.equal(task.status, "blocked");
  assert.equal(task.detail, "Test description");
  assert.equal(task.evidenceUrl, "https://github.com/trancuong3/capstone1/pull/143");
});
test("ignore GitHub pull requests and unrelated issues", () => {
  assert.equal(parseIssue({...issue("p1", "done", 150), pull_request: {url:"https://api.github.com"}}), null);
  assert.equal(parseIssue({number:4, title:"other", body:"No metadata"}), null);
  assert.equal(parseIssue(issue("task11-phase0", "in_progress", 149)), null);
});
test("reject unknown or corrupted shared states rather than silently marking done", () => {
  assert.throws(() => parseIssue(issue("p1", "completed", 150)), /Invalid roadmap status/);
  assert.throws(() => reconcileIssues([issue("p1", "done", 150)], ["p1", "p2"]), /Missing roadmap issues: p2/);
});
test("reject duplicate stable IDs and retain the original roadmap order", () => {
  assert.throws(() => reconcileIssues([issue("p1", "done", 150), issue("p1", "done", 170)], ["p1"]), /Duplicate roadmap/);
  assert.deepEqual(reconcileIssues([issue("p2", "todo", 151), issue("p1", "done", 150)], ["p1","p2"]).map(t=>t.id), ["p1","p2"]);
});
test("detect old local-only differences without mutating shared status", () => {
  const shared = reconcileIssues([issue("p1", "done", 150),issue("p2","review",151)],["p1","p2"]);
  const result = compareLegacy([{id:"p1",status:"blocked"},{id:"p2",status:"review"},{id:"custom-1",status:"todo"}],shared);
  assert.deepEqual(result,{changed:1,personal:1});
  assert.equal(shared[0].status,"done");
});
