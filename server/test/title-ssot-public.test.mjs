import { onRequestGet as adminHomepage } from "../../functions/admin/api/homepage-events.js";
import { onRequestPost as projectsPost } from "../../functions/admin/api/projects.js";
import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as event } from "../../functions/api/event.js";
import { onRequestGet as override } from "../../functions/api/override.js";
import { onRequestGet as slug } from "../../functions/[slug].js";
import { buildHomepageFeed, buildPublishedSiteEvents, applyOverrides, getPublicHomepageFeed } from "../../functions/_lib/homepage-feed.js";
import { forgetGuideStatuses } from "../../functions/_lib/guide-event-hidden.js";
import { clearPublicGuideTitleCache } from "../../functions/_lib/public-guide-title.js";
import { withoutLocalProjectTitle } from "../../functions/_lib/title-ownership.js";

const title = "Guide current plain title";
const legacy = { title: "OLD ROOT", displayTitle: "OLD ROOT DISPLAY", fields: {
  "text:#evTitle": { type: "text", value: "OLD H1" },
  "text:main > #evTitle": { type: "text", value: "OLD ALIAS H1" },
  "text:#evTag": { type: "text", value: "Keep other edits" },
}};
const project = (extra = {}) => ({ id: "draft-owned", otraGuideId: "84", status: "published", adminOnly: false,
  title: "OLD PROJECT", frozenSlug: "stable-before-title", createdAt: "2026-11-01T12:00:00Z",
  startDate: "2999-01-01T12:00:00Z", claudeDesign: { title: "OLD DESIGN", displayTitle: "OLD DESIGN DISPLAY", meta: ["Daily"], rates: [] }, ...extra });

async function fixture(run, options = {}) {
  const projects = options.projects || [project()];
  const records = new Map(projects.map(p => [`site-event:${p.id}`, structuredClone(p)]));
  records.set("event:84", structuredClone(legacy));
  records.set("event:draft-owned", structuredClone(legacy));
  const writes = [], calls = [], cacheWrites = [], pending = [];
  const kv = { async get(k) { return records.has(k) ? structuredClone(records.get(k)) : null; },
    async put(k,v) { writes.push(k); records.set(k, JSON.parse(v)); }, async delete(k) { writes.push(k); records.delete(k); },
    async list({prefix}) { return {keys:[...records.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true}; } };
  const original = globalThis.fetch, oldCaches = globalThis.caches;
  globalThis.caches = {default:{async match(){return null;},async put(k,v){cacheWrites.push(await v.clone().text());}}};
  forgetGuideStatuses(); clearPublicGuideTitleCache();
  globalThis.fetch = async (input, init={}) => {
    const url = new URL(String(input)), auth = new Headers(init.headers).get("authorization");
    calls.push({path:url.pathname,auth,cache:init.cache});
    if (url.pathname.endsWith("/users/user-role/")) return Response.json({is_staff_or_admin:auth === "Bearer staff-test"});
    if (url.pathname.includes("/media/event-slug/")) {
      assert.equal(auth,"Bearer staff-test","anonymous must NEVER call staff title endpoint");
      return Response.json({id:84,title:"Staff Guide private title",slug:"stable-before-title"});
    }
    if (url.pathname.includes("/events/details/")) {
      const id = Number(url.pathname.match(/details\/(\d+)/)[1]);
      if (options.throwRead) throw new Error("offline");
      if (auth === "Bearer staff-test") return Response.json({id,title:"Staff detail title",is_ticketed:true});
      if (options.status) return Response.json({detail:"unavailable"},{status:options.status});
      return Response.json(options.detail ?? {id,title,is_ticketed:true,is_perennial:false,start_date:"2999-01-01T12:00:00Z"});
    }
    if (url.pathname.includes("/events/nonperennial/")) return Response.json({count:0,results:[]});
    if (url.pathname.includes("/ticket/purchase/tickets/")) return Response.json({count:1,results:[{id:1,name:"Entry",price:1}]});
    if (url.pathname.includes("/ticketing/")) return new Response("");
    throw new Error("Unexpected path "+url.pathname);
  };
  const env = {OVERRIDES:kv,OTRA_API_URL:"https://guide.test/api",ASSETS:{async fetch(){return new Response('<html data-event-id=""><head><title>Old</title></head><script src="/site-overrides.js"></script></html>');}}};
  const context = (path,staff=false) => ({env,request:new Request("https://tickets.test"+path,{headers:staff?{authorization:"Bearer staff-test"}:{}}),waitUntil(p){pending.push(p);}});
  const get = async (fn,path,staff=false) => {const r=await fn(context(path,staff));return {status:r.status,data:await r.json(),cache:r.headers.get("cache-control")};};
  try {await run({get,context,env,records,writes,calls,cacheWrites});}
  finally {await Promise.allSettled(pending);globalThis.fetch=original;globalThis.caches=oldCaches;forgetGuideStatuses(); clearPublicGuideTitleCache();}
}

test("owned numeric and published draft JSON and parallel H1 override use public Guide title, not any legacy copy",async()=>{
 await fixture(async f=>{
  for (const id of ["84","draft-owned"]) {
   const r=await f.get(event,"/api/event?id="+id);assert.equal(r.status,200);assert.equal(r.data.title,title);
   assert.equal(r.data.design.title,undefined);assert.equal(r.data.design.displayTitle,undefined);
   const h=await f.get(override,"/api/override?id="+id);assert.equal(h.status,200);
   assert.equal(h.data.override.fields["text:#evTitle"].value,title);
   assert.equal(h.data.override.fields["text:main > #evTitle"],undefined);
   assert.equal(h.data.override.fields["text:#evTag"].value,"Keep other edits");
  }
  assert.equal(f.writes.length,0,"read projections never persist the Guide title");
  assert.equal(f.records.get("site-event:draft-owned").title,"OLD PROJECT","no destructive lazy migration");
  assert.ok(f.calls.filter(c=>c.path.includes("/events/details/")).length>0, "public Guide detail is the anonymous title source");
  assert.ok(f.calls.every(c=>!c.path.includes("/media/")&&!c.auth));
 });
});

test("homepage/search/unlisted slug metadata cannot resurrect local title fields or cached category labels",async()=>{
 await fixture(async f=>{
  let cards=await buildPublishedSiteEvents(f.env);assert.equal(cards[0].title,title);
  cards=await applyOverrides(cards,f.env);assert.equal(cards[0].title,title);
  const feed=await buildHomepageFeed(f.context("/api/homepage-events"));assert.equal(feed.events[0].title,title);
  const ctx=f.context("/stable-before-title");ctx.params={slug:"stable-before-title"};
  ctx.getHomepageEvents=async()=>Response.json(feed);
  const response=await slug(ctx);assert.equal(response.status,200);const html=await response.text();
  assert.ok(html.includes(title));assert.ok(!html.includes("OLD H1"));
  assert.equal(f.writes.some(k=>k.startsWith("site-event:")||k.startsWith("event:")),false);
 });
 await fixture(async f=>{
  const feed=await buildHomepageFeed(f.context("/api/homepage-events"));assert.equal(feed.events.length,0,"unlisted absent from feed");
  const ctx=f.context("/stable-before-title");ctx.params={slug:"stable-before-title"};ctx.getHomepageEvents=async()=>Response.json(feed);
  const response=await slug(ctx);assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  assert.ok((await response.text()).includes(title));
 },{projects:[project({unlisted:true})]});
});

test("Guide-private owned pages expose no local fallback; valid staff can preview",async()=>{
 for (const keep of [false]) await fixture(async f=>{
  for (const id of ["84","draft-owned"]) {
   const r=await f.get(event,"/api/event?id="+id);assert.equal(r.status,404);assert.equal(r.cache,"no-store");
   const h=await f.get(override,"/api/override?id="+id);assert.equal(h.data.override,null);
   const staff=await f.get(event,"/api/event?id="+id,true);assert.equal(staff.status,200);assert.equal(staff.data.title,"Staff Guide private title");assert.equal(staff.cache,"no-store");
  }
  assert.equal((await buildPublishedSiteEvents(f.env)).length,0);
 },{status:404,projects:[project({keepSellingWhileGuidePrivate:keep})]});
});

test("unpublished/admin-only owned drafts and their edits stay private; newer draft never changes live numeric design",async()=>{
 for (const extra of [{status:"draft"},{adminOnly:true}]) await fixture(async f=>{
  assert.equal((await f.get(event,"/api/event?id=draft-owned")).status,404);
  assert.equal((await f.get(override,"/api/override?id=draft-owned")).data.override,null);
  const staff=await f.get(event,"/api/event?id=draft-owned",true);assert.equal(staff.status,200);assert.equal(staff.data.title,"Staff Guide private title");
 },{projects:[project(extra)]});
 await fixture(async f=>{
  const r=await f.get(event,"/api/event?id=84");assert.equal(r.status,200);assert.equal(r.data.design.meta[0],"Daily");
  assert.equal(JSON.stringify(r.data).includes("SECRET DRAFT"),false);
 },{projects:[project(),project({id:"draft-next",status:"draft",adminOnly:true,createdAt:"2026-11-05T12:00:00Z",claudeDesign:{meta:["SECRET DRAFT"]}})]});
});

test("public outages/malformed title/mismatched id fail closed and never serve local title fallback",async()=>{
 for (const options of [{status:500},{status:429},{status:403},{throwRead:true},{detail:{}},{detail:{id:84,title:""}},{detail:{id:999,title:"Wrong event"}}]) {
  await fixture(async f=>{
   for (const id of ["84","draft-owned"]) {
    const r=await f.get(event,"/api/event?id="+id);assert.equal(r.status,502);assert.equal(r.cache,"no-store");assert.equal(JSON.stringify(r.data).includes("OLD"),false);
    const h=await f.get(override,"/api/override?id="+id);assert.equal(h.status,502);assert.equal(h.data.override,null);
   }
   assert.equal((await buildPublishedSiteEvents(f.env)).length,0);
   assert.ok(f.calls.every(c=>!c.path.includes("/media/")));assert.equal(f.writes.length,0);
  },options);
 }
});

test("borrowed and checkout-bound pages use public Guide title; unlinked pages keep a local title",async()=>{
 await fixture(async f=>{
  const r=await f.get(event,"/api/event?id=draft-owned");assert.equal(r.status,200);assert.equal(r.data.title,title);
  assert.equal(r.data.design.displayTitle,undefined);
  const h=await f.get(override,"/api/override?id=draft-owned");assert.equal(h.data.override.fields["text:#evTitle"].value,title);
 },{projects:[project({usesExistingOtraGuideEvent:true})]});
 await fixture(async f=>{
  const r=await f.get(event,"/api/event?id=draft-owned");assert.equal(r.status,200);assert.equal(r.data.title,title);
 },{projects:[project({otraGuideId:"",checkoutEventId:"84"})]});
 await fixture(async f=>{
  const r=await f.get(event,"/api/event?id=draft-owned");assert.equal(r.status,200);assert.equal(r.data.title,"OLD PROJECT");assert.equal(r.data.design.displayTitle,"OLD DESIGN DISPLAY");
  const h=await f.get(override,"/api/override?id=draft-owned");assert.equal(h.data.override.fields["text:#evTitle"].value,"OLD H1");
 },{projects:[project({otraGuideId:""})]});
 const clean=withoutLocalProjectTitle({...project(),fields:legacy.fields});
 assert.equal(clean.fields["text:main > #evTitle"],undefined);assert.equal(clean.fields["text:#evTag"].value,"Keep other edits");
});


test("legacy durable homepage snapshot is reconciled before response and never restores old H1 or private Guide title",async()=>{
 for (const status of [0,404]) await fixture(async f=>{
  f.records.set("__homepage_feed_snapshot__",{events:[{id:84,title:"OLD SNAPSHOT TITLE",slug:"stable-before-title",otraOwnedGuideId:"84"}],rows:[],hasSiteEvents:true,generatedAt:Date.now(),titleModel:"guide-title-b1"});
  const feed=await getPublicHomepageFeed(f.context("/api/homepage-events"));
  assert.equal(feed.feedSource,"kv-stale");
  if(status===404) assert.equal(feed.events.length,0);
  else {assert.equal(feed.events[0].title,title);assert.equal(feed.events[0].slug,"stable-before-title");}
 },status ? {status} : {});
});


test("staff-only homepage cards still hydrate private owned titles without writing public snapshots",async()=>{
 await fixture(async f=>{
  const r=await f.get(adminHomepage,"/admin/api/homepage-events",true);
  assert.equal(r.status,200);assert.equal(r.cache,"no-store");
  assert.equal(r.data.events[0].title,"Staff Guide private title");
  assert.equal(f.writes.length,0);
  assert.ok(f.calls.some(c=>c.path.includes('/media/event-slug/')&&c.auth==='Bearer staff-test'));
 },{status:404,projects:[project({adminOnly:true})]});
});


// Keep-selling pages (legacy HIDDEN_DETAIL_EXCEPTIONS such as 8266, or the
// admin switch) sell while Guide is private, when no public Guide title exists.
// They keep local title authority (Marília's 2026-11-05 answer did not cover
// keep-selling) and never 404.
test("keep-selling owned pages (legacy exception or switch) keep selling with their local title while Guide is private",async()=>{
 const cases=[
  {guideId:"8266",draft:"draft-1792794458964-79d36de9",extra:{}},
  {guideId:"8088",draft:"draft-1791253678425-26c548a5",extra:{}},
  {guideId:"84",draft:"draft-owned",extra:{keepSellingWhileGuidePrivate:true}},
 ];
 for (const c of cases) await fixture(async f=>{
  const r=await f.get(event,"/api/event?id="+c.guideId);
  assert.equal(r.status,200,`${c.guideId} keeps selling`);
  assert.ok(r.data.title && r.data.title!==title,"local title, never a staff-only Guide read");
  const d=await f.get(event,"/api/event?id="+c.draft);assert.equal(d.status,200);
  const h=await f.get(override,"/api/override?id="+c.guideId);if (c.guideId==="84") assert.ok(h.data.override,"edits still served");
  assert.equal(h.data.guideTitleHidden,undefined);assert.equal(h.data.guideTitleUnavailable,undefined);
  assert.ok(f.calls.every(x=>!x.path.includes("/media/")),"anonymous never calls staff title endpoint");
 },{status:404,projects:[project({id:c.draft,otraGuideId:c.guideId,...c.extra})]});
});

test("Guide outage on the snapshot fast path keeps the snapshot's Guide title, answers fast and caches the failure",async()=>{
 await fixture(async f=>{
  f.records.set("__homepage_feed_snapshot__",{events:[{id:84,title:"Snapshot Guide title",slug:"stable-before-title",otraOwnedGuideId:"84"},{id:9001,title:"Other card",slug:"other-card"}],rows:[],hasSiteEvents:true,generatedAt:Date.now(),titleModel:"guide-title-b1"});
  const started=Date.now();
  const feed=await getPublicHomepageFeed(f.context("/api/homepage-events"));
  assert.equal(feed.feedSource,"kv-stale");
  assert.deepEqual(feed.events.map(e=>e.title),["Snapshot Guide title","Other card"],"homepage never empties on a Guide outage");
  const detailCalls=f.calls.filter(c=>c.path.includes("/events/details/84/")).length;
  await getPublicHomepageFeed(f.context("/api/homepage-events"));
  assert.ok(Date.now()-started<5000);
  assert.equal(f.calls.filter(c=>c.path.includes("/events/details/84/")).length,detailCalls,"recent failure reused, Guide not re-awaited");
  const snap=f.records.get("__homepage_feed_snapshot__");
  assert.equal(snap.events[0].title,"Snapshot Guide title","an outage build never replaces the last good snapshot");
 },{throwRead:true});
});

test("snapshots written before title SSOT are never served",async()=>{
 await fixture(async f=>{
  f.records.set("__homepage_feed_snapshot__",{events:[{id:84,title:"OLD PRE-SSOT LOCAL TITLE",slug:"stable-before-title"}],rows:[],hasSiteEvents:true,generatedAt:Date.now()});
  const feed=await getPublicHomepageFeed(f.context("/api/homepage-events"));
  assert.equal(feed.feedSource,"origin");
  assert.ok(feed.events.every(e=>e.title!=="OLD PRE-SSOT LOCAL TITLE"));
 });
});

test("/api/override without a KV binding answers a plain empty override",async()=>{
 const r=await override({env:{},request:new Request("https://tickets.test/api/override?id=6113"),waitUntil(){}});
 assert.equal(r.status,200);assert.deepEqual(await r.json(),{override:null});
});

test("turning keep-selling on for an owned page seeds its local title from Guide, never a placeholder",async()=>{
 await fixture(async f=>{
  const ctx={env:f.env,request:new Request("https://tickets.test/admin/api/projects?action=set-keep-selling-while-guide-private&id=draft-owned&value=true",{method:"POST",headers:{authorization:"Bearer staff-test"}}),waitUntil(){}};
  const r=await projectsPost(ctx);assert.equal(r.status,200);
  const stored=f.records.get("site-event:draft-owned");
  assert.equal(stored.keepSellingWhileGuidePrivate,true);
  assert.equal(stored.title,"Staff Guide private title");
  const pub=await f.get(event,"/api/event?id=84");assert.equal(pub.status,200);
 },{status:404,projects:[project({title:""})]});
});

// Marília 2026-11-06: no borrowed page may become a 404 because of the Guide
// title. Without a public Guide title (private or unreachable) a borrowed or
// checkout-bound page answers exactly as before: local title, same visibility.
test("borrowed/checkout pages never 404 or fail for a private or unreachable Guide title; they keep their local title",async()=>{
 for (const opts of [{status:404},{throwRead:true},{status:503}]) {
  await fixture(async f=>{
   const r=await f.get(event,"/api/event?id=draft-owned");
   assert.equal(r.status,200,JSON.stringify(opts));assert.equal(r.data.title,"OLD PROJECT");
   const h=await f.get(override,"/api/override?id=draft-owned");
   assert.equal(h.status,200);assert.equal(h.data.override.fields["text:#evTitle"].value,"OLD H1");
   assert.equal(h.data.guideTitleHidden,undefined);assert.equal(h.data.guideTitleUnavailable,undefined);
   const cards=await buildPublishedSiteEvents(f.env);
   assert.equal(cards.length,1,"card stays listed");assert.notEqual(cards[0].title,title);
   assert.ok(f.calls.every(c=>!c.path.includes("/media/")),"no staff endpoint for visitors");
  },{...opts,projects:[project({otraGuideId:"",checkoutEventId:"84"})]});
 }
 // Guide-404 numeric borrowed page: same answer as an unchanged page (main rule:
 // a Guide 404 event shows nothing unless keep-selling), not a new title 404.
 await fixture(async f=>{
  const r=await f.get(event,"/api/event?id=84");assert.notEqual(r.status,502);
 },{status:404,projects:[project({usesExistingOtraGuideEvent:true})]});
});

test("borrowed numeric page with an outage keeps serving its local title (no 502)",async()=>{
 await fixture(async f=>{
  const r=await f.get(event,"/api/event?id=draft-owned");assert.equal(r.status,200);assert.equal(r.data.title,"OLD PROJECT");
 },{throwRead:true,projects:[project({usesExistingOtraGuideEvent:true})]});
});
