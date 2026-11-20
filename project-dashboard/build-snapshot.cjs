"use strict";

/* Runs only inside trusted GitHub Actions or in unit tests; NEVER bundled in Pages. */
const {mkdirSync,writeFileSync}=require("node:fs");
const path=require("node:path");
const {reconcileIssues,ROADMAP_IDS,validateSnapshot}=require("./roadmap-core.js");
const REPO="trancuong3/capstone1";
const LIMIT=25; // stop after at most 2,500 issue records, never silently truncate

function safeText(s,max=220){return typeof s==="string"?s.slice(0,max):"";}
function githubUrl(u){
  return typeof u==="string" && u.startsWith("https://github.com/"+REPO+"/")?u:"";
}
function activityProjection(key,data){
  if(key==="commits")return data.map(x=>({
    sha:safeText(x.sha,40),
    commit:{message:safeText(x.commit&&x.commit.message,240),author:{date:safeText(x.commit&&x.commit.author&&x.commit.author.date,40)}},
    html_url:githubUrl(x.html_url)
  }));
  if(key==="prs")return data.map(x=>({
    number:x.number,title:safeText(x.title),draft:!!x.draft,
    updated_at:safeText(x.updated_at,40),html_url:githubUrl(x.html_url)
  }));
  if(key==="issues")return data.filter(x=>!x.pull_request).map(x=>({
    number:x.number,title:safeText(x.title),
    updated_at:safeText(x.updated_at,40),html_url:githubUrl(x.html_url)
  }));
  if(key==="runs")return data.map(x=>({
    id:x.id,name:safeText(x.name),status:safeText(x.status,30),
    conclusion:safeText(x.conclusion,30),updated_at:safeText(x.updated_at,40),
    html_url:githubUrl(x.html_url)
  }));
  if(key==="releases")return data.map(x=>({
    name:safeText(x.name),tag_name:safeText(x.tag_name),prerelease:!!x.prerelease,
    published_at:safeText(x.published_at,40),html_url:githubUrl(x.html_url)
  }));
  throw new Error("Unrecognized activity resource");
}

async function fetchRoadmapIssues(getJson){
  const all=[];
  for(let page=1;page<=LIMIT;page++){
    const batch=await getJson("/issues?state=all&per_page=100&page="+page);
    if(!Array.isArray(batch))throw new Error("Issue API returned invalid JSON");
    all.push(...batch);
    const count=new Set(all.filter(x=>!x.pull_request).map(x=>{
      const match=(x.body||"").match(/<!--\s*viread-roadmap:v1\s*[\s\S]*?\bid:\s*(p\d+)\b/);
      return match&&match[1];
    }).filter(Boolean));
    if(ROADMAP_IDS.every(id=>count.has(id)))return reconcileIssues(all,ROADMAP_IDS);
    if(batch.length<100)break;
  }
  return reconcileIssues(all,ROADMAP_IDS); // fail closed if incomplete or duplicate
}
async function buildSnapshot(getJson,{now=new Date(),sha=""}={}){
  const roadmap=await fetchRoadmapIssues(getJson); // required; never publish partial tasks
  const resources=[
    ["repo",""],
    ["commits","/commits?per_page=5"],
    ["prs","/pulls?state=open&per_page=10"],
    ["issues","/issues?state=open&per_page=100"],
    ["runs","/actions/runs?per_page=5"],
    ["releases","/releases?per_page=5"],
    ["branch","/branches/main"]
  ];
  const settled=await Promise.allSettled(resources.map(([,endpoint])=>getJson(endpoint)));
  const activity={},warnings=[];
  settled.forEach((r,i)=>{
    const key=resources[i][0];
    if(r.status!=="fulfilled"){
      warnings.push("GitHub "+key+" feed unavailable");activity[key]=null;return;
    }
    const value=r.value;
    if(key==="repo"){
      activity.repo={full_name:safeText(value.full_name,100)};return;
    }
    if(key==="branch"){
      activity.branch={protected:!!value.protected};return;
    }
    const list=key==="runs"?value.workflow_runs:value;
    if(!Array.isArray(list)){
      warnings.push("GitHub "+key+" feed returned invalid JSON");activity[key]=null;
      return;
    }
    activity[key]=activityProjection(key,list);
  });
  const payload={
    schemaVersion:1,repository:REPO,generatedAt:now.toISOString(),sourceCommit:sha,
    roadmap,activity,warnings
  };
  validateSnapshot(payload);
  return payload;
}
async function githubGetJson(endpoint,{fetchImpl=globalThis.fetch,token=process.env.GITHUB_TOKEN}={}){
  if(!token)throw new Error("GITHUB_TOKEN is required inside GitHub Actions");
  const response=await fetchImpl("https://api.github.com/repos/"+REPO+endpoint,{
    headers:{
      Accept:"application/vnd.github+json",
      Authorization:"Bearer "+token,
      "X-GitHub-Api-Version":"2022-11-28",
      "User-Agent":"ViRead-Hub-Snapshot-Builder"
    },
    signal:AbortSignal.timeout(20000)
  });
  if(!response.ok){
    throw new Error("GitHub "+endpoint.split("?")[0]+" returned HTTP "+response.status);
  }
  return response.json();
}
async function main(){
  const payload=await buildSnapshot(endpoint=>githubGetJson(endpoint),{
    now:new Date(),sha:process.env.GITHUB_SHA||""
  });
  const out=path.join(__dirname,"data","hub-snapshot.json");
  mkdirSync(path.dirname(out),{recursive:true});
  writeFileSync(out,JSON.stringify(payload,null,2)+"\n",{encoding:"utf8",flag:"w"});
  // Do not print JSON, bodies, headers or credentials to CI logs.
  console.log("ViRead public snapshot validated: "+payload.roadmap.length+
    " tasks; "+payload.warnings.length+" optional feeds unavailable");
}
if(require.main===module){
  main().catch(e=>{console.error("Snapshot build failed: "+e.message);process.exitCode=1;});
}
module.exports={buildSnapshot,fetchRoadmapIssues,activityProjection,githubGetJson};
