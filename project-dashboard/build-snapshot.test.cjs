"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {buildSnapshot,fetchRoadmapIssues,githubGetJson}=require("./build-snapshot.cjs");
const {validateSnapshot}=require("./roadmap-core.js");

function issue(n,status="todo") {
  return {
    number:149+n,title:"[p"+n+"] Kiểm tra tiếng Việt "+n,
    html_url:"https://github.com/trancuong3/capstone1/issues/"+(149+n),
    updated_at:new Date().toISOString(),
    body:"<!-- viread-roadmap:v1\nid: p"+n+"\nstatus: "+status+
      "\npriority: P2\ncategory: Android\n-->\n## Mô tả\nKiểm tra Đà Nẵng\n## Evidence\n- https://github.com/trancuong3/capstone1/pull/164\n"
  };
}
function fixture(overrides={}) {
  const issues=overrides.issues||Array.from({length:14},(_,i)=>issue(i+1,i===0?"done":"todo"));
  const calls=[];
  const getJson=async endpoint=>{
    calls.push(endpoint);
    if(endpoint.startsWith("/issues?state=all"))return issues;
    if(overrides.failEndpoint && endpoint.startsWith(overrides.failEndpoint))throw new Error("Test upstream failed");
    if(endpoint==="")return {full_name:"trancuong3/capstone1"};
    if(endpoint.startsWith("/commits"))return [{sha:"a".repeat(40),commit:{message:"commit",author:{date:"2026-11-20T00:00:00Z"}},html_url:"https://github.com/trancuong3/capstone1/commit/a"}];
    if(endpoint.startsWith("/pulls"))return [{number:123,title:"PR <script>alert(1)</script>",html_url:"https://github.com/trancuong3/capstone1/pull/123"}];
    if(endpoint.startsWith("/issues?state=open"))return issues.concat([{number:164,pull_request:{url:"secret"},body:"SECRET_VALUE"}]);
    if(endpoint.startsWith("/actions/runs"))return {workflow_runs:[]};
    if(endpoint.startsWith("/releases"))return [];
    if(endpoint.startsWith("/branches/main"))return {protected:false};
    throw new Error("Unexpected path "+endpoint);
  };
  return {issues,calls,getJson};
}
test("builds exactly 14 stable tasks and safe public activity, preserving Vietnamese",async()=>{
  const {getJson,calls}=fixture();
  const snapshot=await buildSnapshot(getJson,{now:new Date(),sha:"a".repeat(40)});
  assert.equal(snapshot.schemaVersion,1);
  assert.equal(snapshot.repository,"trancuong3/capstone1");
  assert.deepEqual(snapshot.roadmap.map(t=>t.id),Array.from({length:14},(_,i)=>"p"+(i+1)));
  assert.match(snapshot.roadmap[0].title,/Kiểm tra tiếng Việt/);
  assert.match(snapshot.roadmap[0].detail,/Đà Nẵng/);
  assert.equal(snapshot.roadmap[0].status,"done");
  assert.equal(snapshot.activity.issues.length,14);
  assert.equal(snapshot.activity.prs.length,1);
  assert.ok(calls.some(x=>x.includes("issues?state=all")));
  assert.equal(snapshot.warnings.length,0);
  const serialized=JSON.stringify(snapshot);
  assert.ok(!serialized.includes("SECRET_VALUE"));
  assert.ok(!serialized.includes("Authorization"));
  assert.ok(!serialized.includes("Bearer"));
  assert.ok(!serialized.includes("body:"));
  validateSnapshot(snapshot);
});

test("fails closed if the issue set is incomplete",async()=>{
  const {getJson}=fixture({issues:Array.from({length:13},(_,i)=>issue(i+1))});
  await assert.rejects(buildSnapshot(getJson),/Missing roadmap issues: p14/);
});
test("fails closed on duplicate task IDs",async()=>{
  const items=Array.from({length:14},(_,i)=>issue(i+1));
  items.push({...issue(1),number:177,html_url:"https://github.com/trancuong3/capstone1/issues/177"});
  await assert.rejects(buildSnapshot(fixture({issues:items}).getJson),/Duplicate roadmap task ID/);
});
test("fails closed on corrupted statuses",async()=>{
  const items=Array.from({length:14},(_,i)=>issue(i+1));
  items[3]=issue(4,"invented");
  await assert.rejects(buildSnapshot(fixture({issues:items}).getJson),/Invalid roadmap status/);
});
test("optional activity API failures do not invent empty results",async()=>{
  const snapshot=await buildSnapshot(fixture({failEndpoint:"/releases"}).getJson);
  assert.equal(snapshot.activity.releases,null);
  assert.deepEqual(snapshot.warnings,["GitHub releases feed unavailable"]);
  assert.equal(snapshot.roadmap.length,14);
  validateSnapshot(snapshot);
});
test("rejects tampered JSON fields or missing activity before browser render",async()=>{
  const snapshot=await buildSnapshot(fixture().getJson);
  assert.throws(()=>validateSnapshot({...snapshot,repository:"evil/repo"}),/Unsupported/);
  assert.throws(()=>validateSnapshot({...snapshot,roadmap:snapshot.roadmap.slice(1)}),/Incomplete/);
  assert.throws(()=>validateSnapshot({...snapshot,activity:{}}),/Incomplete/);
  const altered=JSON.parse(JSON.stringify(snapshot));
  altered.roadmap[0].url="https://evil.example/steal";
  assert.throws(()=>validateSnapshot(altered),/Invalid snapshot roadmap item/);
});
test("server-only API caller requires token and never prints it in errors",async()=>{
  await assert.rejects(githubGetJson("/issues",{token:"",fetchImpl:async()=>({ok:true})}),/GITHUB_TOKEN is required/);
  let url="",opts;
  const out=await githubGetJson("/issues?state=all",{
    token:"TEST_TOKEN_DO_NOT_PUBLISH",
    fetchImpl:async (u,o)=>{url=u;opts=o;return {ok:true,json:async()=>({hello:"world"})};}
  });
  assert.equal(out.hello,"world");
  assert.match(url,/^https:\/\/api\.github\.com\/repos\/trancuong3\/capstone1\/issues/);
  assert.equal(opts.headers.Authorization,"Bearer TEST_TOKEN_DO_NOT_PUBLISH");
  assert.ok(!JSON.stringify(out).includes("TEST_TOKEN_DO_NOT_PUBLISH"));
});
