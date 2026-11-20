"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const core = require("./roadmap-core.js");
const html = readFileSync(path.join(__dirname, "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function fakeIssues() {
  return Array.from({length:14}, (_, i) => {
    const id = "p" + (i+1);
    return {
      number:150+i, title:"[" + id + "] Task " + id,
      html_url:"https://github.com/trancuong3/capstone1/issues/" + (150+i),
      updated_at:"2026-11-20T14:00:00Z",
      body:"<!-- viread-roadmap:v1\nid: " + id + "\nstatus: " + (i===2?"blocked":i===0?"done":"todo")+
        "\npriority: P1\ncategory: Android\n-->\n## Mô tả\nIssue task " + id + "\n## Evidence\n- https://github.com/trancuong3/capstone1/pull/143\n"
    };
  });
}
function boot(options={}) {
  const nodes=new Map(), handlers=new Map(), store=new Map(Object.entries(options.storage||{}));
  function getElementById(id){
    if (!nodes.has(id)) nodes.set(id,{
      value:"",textContent:"",innerHTML:"",style:{},disabled:false,className:"",
      classList:{add(){},remove(){}},
      addEventListener(type,handler){handlers.set(id+":"+type,handler);}
    });
    return nodes.get(id);
  }
  const localStorage={
    getItem(key){return store.has(key)?store.get(key):null;},
    setItem(key,value){store.set(key,String(value));},
    removeItem(key){store.delete(key);}
  };
  const data=options.issues||fakeIssues();
  async function fetch(url){
    if(options.fail)return {ok:false,status:403,headers:{get:()=>null}};
    let response={};
    if(url.includes("/issues?state=all"))response=data;
    else if(url.includes("/issues?state=open"))response=data;
    else if(url.includes("/actions/runs"))response={workflow_runs:[]};
    else if(url.endsWith("/branches/main"))response={protected:false};
    else if(url.endsWith("/capstone1"))response={};
    else response=[];
    return {ok:true,status:200,headers:{get:()=>null},json:async()=>response};
  }
  const document={getElementById,querySelectorAll:()=>[],addEventListener(){},hidden:false};
  const window={ViReadRoadmapCore:core,scrollTo(){}};
  const sandbox={document,window,ViReadRoadmapCore:core,localStorage,fetch,
    setInterval(){},clearTimeout(){},setTimeout(){},console};
  vm.runInNewContext(script,sandbox,{timeout:3000});
  return {nodes,store,handlers,element:getElementById};
}
async function flush(){await new Promise(resolve=>setImmediate(resolve));}

test("renders authoritative Issue status and caches it separately from legacy notes",async()=>{
  const original={tasks:[{id:"p3",title:"Local changed",status:"done"},{id:"custom-x",status:"todo"}],note:"My private note"};
  const app=boot({storage:{"viread-project-hub-v1":JSON.stringify(original)}});
  await flush();
  const html=app.element("taskGrid").innerHTML;
  assert.match(html,/p3 · Task p3/);
  assert.match(html,/Bị chặn/);
  assert.match(html,/GitHub Issue/);
  assert.equal(app.element("projectNote").value,"My private note");
  assert.match(app.element("legacyConflictNotice").textContent,/1 trạng thái khác GitHub/);
  assert.match(app.element("legacyConflictNotice").textContent,/1 task cá nhân/);
  assert.deepEqual(JSON.parse(app.store.get("viread-project-hub-v1")),original);
  const cached=JSON.parse(app.store.get("viread-shared-roadmap-v1"));
  assert.equal(cached.tasks.length,14);
  assert.equal(cached.tasks[2].status,"blocked");
  assert.match(app.element("roadmapSyncNotice").textContent,/GitHub Issues/);
});

test("API failure shows a truthful error while retaining last successful shared snapshot",async()=>{
  const cached={syncedAt:"2026-11-20T11:00:00Z",tasks:fakeIssues().map(core.parseIssue)};
  const app=boot({fail:true,storage:{"viread-shared-roadmap-v1":JSON.stringify(cached)}});
  await flush();
  assert.match(app.element("roadmapSyncNotice").textContent,/Không thể đồng bộ Roadmap/);
  assert.match(app.element("roadmapSyncNotice").textContent,/403/);
  assert.match(app.element("taskGrid").innerHTML,/Task p3/);
  assert.equal(JSON.parse(app.store.get("viread-shared-roadmap-v1")).syncedAt,cached.syncedAt);
});
