import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../../functions/admin/api/projects.js';
import { contentSnapshot } from '../../functions/admin/api/_draft-content.js';

const id = 'draft-content-regression';
const image = `/override-images/${id}/claude-design/source.jpg`;
const seed = () => ({ id, status:'draft', adminOnly:true, archivedAt:'', publishedAt:'', title:'Existing title', description:'Old story', otraGuideId:'8088', otraGuideSlug:'8088', ticketTypeIds:[491], ticketQuantities:[200], startDate:'2026-10-12T22:00:00Z', endDate:'2026-10-13T03:00:00Z', usesExistingOtraGuideEvent:true, untouched:{future:'preserve'}, claudeDesign:{galleryImages:[image], rates:[{name:'Entrance',price:'35.00',currency:'XCG'}], storyImage:image} });
const patch = () => ({ description:'Original story', bandEyebrow:'What We Appreciate', bandTitle:'Want to do more?', appreciates:[{name:'Separate optional perk',description:'Source prototype $25; currency and sale terms pending. Not included in Entrance 35 XCG.',image}], sponsorTitle:'With thanks to our sponsors & friends', sponsorText:'Original acknowledgments', sponsorLayout:'compact', sponsorGroups:[{name:'Grote Knip',sponsors:'D&D Car Rental · Tommy Coconut Private Resorts'},{name:'Klein Knip',sponsors:'Prima Car Rental · Lions Dive Beach Resort'}] });
async function run({ project=seed(), content=patch(), token='fixture', expected=contentSnapshot(project), changeAfterRead=null, changeDuringBodyParse=null } = {}) {
  const records=new Map([[`site-event:${id}`,structuredClone(project)],[`event:${id}`,{description:'An unrelated saved override',fields:{}}]]);
  const writes=[],calls=[];
  const kv={async get(key){const value=records.get(key);return value===undefined?null:structuredClone(value);},async put(key,value){writes.push(key);records.set(key,JSON.parse(value));},async list(){return {keys:[{name:`site-event:${id}`}],list_complete:true};}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (input,options={})=>{const url=new URL(String(input));const authorization=new Headers(options.headers).get('authorization');calls.push({path:url.pathname,method:options.method||'GET',authorization});if(url.pathname==='/users/user-role/')return Response.json({is_staff_or_admin:authorization==='Bearer fixture'});if(url.pathname==='/users/profile/')return Response.json({first_name:'Local',last_name:'Test'});throw new Error('Unexpected Guide request');};
  try {
    const env={OVERRIDES:kv,OTRA_API_URL:'https://guide.test'};
    const opened=await onRequestGet({env,request:new Request('https://site.test/admin/api/projects',{headers:{authorization:`Bearer ${token}`}})});
    const expectedProject=opened.ok?(await opened.json()).projects[0]:null;
    if(changeAfterRead) records.set(`site-event:${id}`,{...records.get(`site-event:${id}`),...changeAfterRead});
    const request=new Request(`https://site.test/admin/api/projects?action=update-content&id=${id}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({expectedProject,expected,patch:content})});
    if(changeDuringBodyParse){const originalJson=request.json.bind(request);request.json=async()=>{const parsed=await originalJson();records.set(`site-event:${id}`,{...records.get(`site-event:${id}`),...changeDuringBodyParse});return parsed;};}
    const response=await onRequestPost({env,request});
    return {status:response.status,body:await response.json(),records,writes,calls};
  } finally {globalThis.fetch=originalFetch;}
}

test('same private draft content merges without changing checkout, original assets, extra fields or overrides',async()=>{
  const original=seed();const result=await run({project:original});assert.equal(result.status,200);
  const saved=result.records.get(`site-event:${id}`);const changed=patch();
  assert.equal(saved.description,changed.description);
  for(const key of ['bandEyebrow','bandTitle','appreciates','sponsorTitle','sponsorText','sponsorLayout','sponsorGroups'])assert.deepEqual(saved.claudeDesign[key],changed[key],key);
  for(const key of Object.keys(original).filter(key=>!['description','claudeDesign'].includes(key)))assert.deepEqual(saved[key],original[key],key);
  assert.deepEqual(saved.claudeDesign.rates,original.claudeDesign.rates);assert.deepEqual(saved.claudeDesign.galleryImages,original.claudeDesign.galleryImages);assert.equal(saved.claudeDesign.storyImage,image);
  assert.deepEqual(result.records.get(`event:${id}`),{description:'An unrelated saved override',fields:{}});
  assert.equal(result.writes.filter(key=>key.startsWith('site-event:')).length,1);assert(result.writes.every(key=>key===`site-event:${id}`||key===`audit:event:${id}`));assert(result.calls.every(call=>call.method==='GET'));assert(result.calls.every(call=>['/users/user-role/','/users/profile/'].includes(call.path)));assert(result.calls.every(call=>call.authorization==='Bearer fixture'));
});
test('unauthorized session cannot write content',async()=>{const result=await run({token:'nonstaff'});assert.equal(result.status,401);assert.deepEqual(result.writes,[]);assert(result.calls.some(call=>call.path==='/users/user-role/'));assert(result.calls.every(call=>call.authorization==='Bearer nonstaff'));});
test('stale content snapshot refuses writes',async()=>{const expected={description:'Outdated story',claudeDesign:structuredClone(seed().claudeDesign)};const result=await run({expected});assert.equal(result.status,409);assert.deepEqual(result.writes,[]);});
test('all fields may reach their displayed limits in one save',async()=>{const content={description:'s'.repeat(20000),bandEyebrow:'e'.repeat(200),bandTitle:'t'.repeat(500),sponsorTitle:'h'.repeat(500),sponsorText:'a'.repeat(10000),appreciates:Array.from({length:12},(_,index)=>({name:`Perk ${index} `+'n'.repeat(190),description:'d'.repeat(8000),image:''}))};const result=await run({content});assert.equal(result.status,200);assert.equal(result.records.get(`site-event:${id}`).claudeDesign.appreciates.length,12);});
test('concurrent event, ticket or quantity changes refuse the content save',async()=>{for(const changeAfterRead of [{otraGuideId:'8084'},{ticketTypeIds:[492]},{ticketQuantities:[150]},{startDate:'2026-10-11T22:00:00Z'}]){const result=await run({changeAfterRead});assert.equal(result.status,409);assert.deepEqual(result.writes,[]);}});
test('a private or ticket change while parsing the request cannot be overwritten',async()=>{for(const changeDuringBodyParse of [{adminOnly:false},{status:'published'},{ticketTypeIds:[492]}]){const result=await run({changeDuringBodyParse});assert.equal(result.status,409);assert.deepEqual(result.writes,[]);}});
test('public or published drafts cannot use the private content editor',async()=>{for(const delta of [{adminOnly:false},{status:'published'},{publishedAt:'2026-10-01T00:00:00Z'},{archivedAt:'2026-10-01T00:00:00Z'}]){const result=await run({project:{...seed(),...delta}});assert.equal(result.status,409);assert.deepEqual(result.writes,[]);}});
test('commercial and unknown fields are rejected rather than silently applied',async()=>{for(const delta of [{rates:[]},{ticketQuantities:[1]},{adminOnly:false},{otraGuideId:'8084'},{unknown:'value'}]){const result=await run({content:{...patch(),...delta}});assert.equal(result.status,400);assert.deepEqual(result.writes,[]);}});
test('only existing same-draft images are accepted',async()=>{for(const invalid of ['javascript:alert(1)','https://external.test/image.jpg','/override-images/another-draft/claude-design/source.jpg',`/override-images/${id}/claude-design/missing.jpg`]){const content=patch();content.appreciates[0].image=invalid;const result=await run({content});assert.equal(result.status,400);assert.deepEqual(result.writes,[]);}});
test('sponsor layout and groups accept only bounded structured text',async()=>{for(const delta of [{sponsorLayout:'<script>'},{sponsorLayout:'cards'},{sponsorGroups:[{name:'Grote Knip',sponsors:'Names',html:'<b>'}]},{sponsorGroups:[{name:'',sponsors:'Names'}]},{sponsorGroups:[{name:'Grote Knip',sponsors:''}]},{sponsorGroups:Array.from({length:13},()=>({name:'Group',sponsors:'Names'}))}]){const result=await run({content:{...patch(),...delta}});assert.equal(result.status,400);assert.deepEqual(result.writes,[]);}});
test('oversized or malformed text and perk arrays refuse writes',async()=>{for(const content of [{description:'x'.repeat(20001)},{appreciates:Array.from({length:13},()=>patch().appreciates[0])},{appreciates:[{name:'Perk',description:'text',price:'25'}]},{sponsorText:null}]){const result=await run({content});assert.equal(result.status,400);assert.deepEqual(result.writes,[]);}});
