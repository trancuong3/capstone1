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

test("exports a note-only localStorage record with empty tasks, and accepts round trip", () => {
  const {makeLocalExport,parseLocalImport}=require("./roadmap-core.js");
  const original={note:"Ghi chú tiếng Việt — thử nghiệm"};
  const exported=makeLocalExport(original,original.note,[],{syncedAt:null,tasks:[]},"2026-11-21T00:00:00.000Z");
  assert.equal(exported.format,"viread-local-export-v1");
  assert.deepEqual(exported.legacy,{note:original.note,tasks:[]});
  assert.deepEqual(original,{note:"Ghi chú tiếng Việt — thử nghiệm"}); // don't mutate localStorage data
  assert.deepEqual(parseLocalImport(JSON.parse(JSON.stringify(exported))),{
    tasks:[],note:"Ghi chú tiếng Việt — thử nghiệm"
  });
});
test("accepts exact legacy shape of old exported files without legacy.tasks", () => {
  const {parseLocalImport}=require("./roadmap-core.js");
  const old={
    format:"viread-local-export-v1",
    exportedAt:"2026-11-21T01:30:31.954Z",
    legacy:{note:"Ví dụ ghi chú"},
    imports:[{importedAt:"2026-11-20T15:08:38.711Z",tasks:[],note:""}],
    sharedSnapshot:{syncedAt:"2026-11-20T22:41:27.420Z",tasks:[{id:"p1",status:"done"}]}
  };
  assert.deepEqual(parseLocalImport(old),{tasks:[],note:"Ví dụ ghi chú"});
  assert.deepEqual(parseLocalImport({note:"Chỉ có ghi chú"}),{tasks:[],note:"Chỉ có ghi chú"});
});
test("retains custom legacy task entries and doesn't alter shared snapshot", () => {
  const {makeLocalExport,parseLocalImport}=require("./roadmap-core.js");
  const existing={tasks:[{id:"custom",status:"blocked"}],note:"Private",customSetting:"preserved"};
  const shared={syncedAt:"2026-11-20T16:00:00.000Z",tasks:[{id:"p1",status:"done"}]};
  const exported=makeLocalExport(existing,"ignored",[],shared,"2026-11-21T00:00:00.000Z");
  assert.equal(exported.legacy.customSetting,"preserved");
  assert.equal(exported.legacy.note,"Private");
  assert.deepEqual(parseLocalImport(exported).tasks,[{id:"custom",status:"blocked"}]);
  assert.equal(shared.tasks[0].status,"done");
});
test("rejects corrupted or unknown local backup formats and task types", () => {
  const {parseLocalImport}=require("./roadmap-core.js");
  assert.throws(()=>parseLocalImport({format:"unknown",legacy:{note:"text"}}),/Unknown local backup format/);
  assert.throws(()=>parseLocalImport({format:"viread-local-export-v1",legacy:{}}),/Missing local tasks or note/);
  assert.throws(()=>parseLocalImport({format:"viread-local-export-v1",legacy:{tasks:"not-array"}}),/Invalid local task list/);
  assert.throws(()=>parseLocalImport({tasks:[null]}),/Invalid local task entry/);
  assert.throws(()=>parseLocalImport({note:4}),/Invalid local note/);
});
