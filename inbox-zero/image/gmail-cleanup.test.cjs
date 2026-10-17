'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AsyncLocalStorage}=require('node:async_hooks');
const {requestDetails,metadataRead,requestCost,createGmailTransport,decorateMailboxSource,decorateOperationExecutor,patchRuntimeSource,OPERATION_FACTORY,OPERATION_GUARDED}=require('./gmail-pacing.cjs');
const base='https://gmail.googleapis.com/gmail/v1/users/me/';
function harness(){
 const storage=new AsyncLocalStorage(), calls=[];
 const transport=createGmailTransport(async()=>{}, {context:()=>storage.getStore(),log:()=>{}});
 const read=async(resource)=>transport(async(input,options)=>{calls.push({url:String(input),method:options?.method||'GET',body:options?.body});return new Response('{}')},base+resource);
 return {calls,read,runMetadata:fn=>storage.run({metadataOnly:true},fn)};
}
test('sender cleanup scans use bounded pages and preserve filters and continuation tokens',()=>{
 const original='/api/threads/basic?fromEmail=sender%40example.com&labelId=INBOX&limit=100&nextPageToken=opaque%2Btoken';
 const details=requestDetails(original,'GET'),url=new URL(details.url,'http://local');
 assert.equal(url.searchParams.get('limit'),'10');
 assert.equal(url.searchParams.get('fromEmail'),'sender@example.com');
 assert.equal(url.searchParams.get('labelId'),'INBOX');
 assert.equal(url.searchParams.get('nextPageToken'),'opaque+token');
 assert.equal(details.metadataOnly,true);
 assert.equal(new URL(requestDetails(original.replace('limit=100','limit=3'),'GET').url,'http://local').searchParams.get('limit'),'3');
 for(const url of ['/api/threads/basic?limit=100','/api/threads/basic?fromEmail=x&labelId=SENT&limit=100','/api/threads?limit=100','/api/threads/thread-id'])assert.notEqual(requestDetails(url,'GET').metadataOnly,true);
 assert.notEqual(requestDetails(original,'POST').metadataOnly,true);
});
test('thread metadata reads cost one third while retaining native query fields',()=>{
 const input=base+'threads/thread-id?format=full&fields=id%2Cmessages';
 const rewritten=metadataRead(input).input;
 assert.equal(new URL(rewritten).searchParams.get('fields'),'id,messages');
 assert.equal(requestCost(input),120);assert.equal(requestCost(rewritten),40);
 const body='--x\nContent-Type: application/http\n\nGET /gmail/v1/users/me/threads/a?format=full\n\n--x\nContent-Type: application/http\n\nGET /gmail/v1/users/me/threads/b?format=full\n\n--x--';
 const options={method:'POST',body};const batch='https://www.googleapis.com/batch/gmail/v1';
 assert.equal(requestCost(batch,options),240);assert.equal(requestCost(batch,metadataRead(batch,options).options),80);
});
test('conversation membership keeps complete IDs, metadata patches, and pagination without bodies',async()=>{
 const h=harness();let input;
 const result={status:'ok',value:{status:'page',page:{keys:[{accountId:'a',messageId:'m'}],changes:[{kind:'message_patch',fields:{subject:'subject',hasAttachments:false}}],nextPage:'50'}}};
 const source={readConversationMembership:async value=>{input=value;await h.read('threads/t?format=full');return result}};
 const wrapped=decorateMailboxSource(source,{name:'google'},h);
 const args={conversation:{accountId:'a',conversationId:'t'},page:'0',pageSize:50};
 const actual=await wrapped.readConversationMembership(args);
 assert.equal(input,args);assert.deepEqual(actual.value.page.keys,result.value.page.keys);assert.equal(actual.value.page.nextPage,'50');
 assert.equal(Object.hasOwn(actual.value.page.changes[0].fields,'hasAttachments'),false);
 assert.equal(new URL(h.calls[0].url).searchParams.get('format'),'metadata');
});
test('archive execution and readback keep outcomes and dispatch writes exactly once',async()=>{
 const h=harness();let writes=0;
 const confirmed={status:'confirmed',receiptId:'r',targets:[{key:{messageId:'m'},outcome:'applied'}],observations:[{kind:'message_patch',fields:{roles:[],hasAttachments:false}}]};
 const executor={execute:async()=>{writes++;await h.read('messages/m?format=full');return confirmed},inspect:async()=>{await h.read('messages/m?format=full');return confirmed}};
 const wrapped=decorateOperationExecutor(executor,{name:'google'},h),input={operation:{intent:{kind:'metadata',change:{kind:'archive'}}}};
 const result=await wrapped.execute(input);const inspected=await wrapped.inspect(input);
 assert.equal(writes,1);assert.deepEqual(result.targets,confirmed.targets);assert.equal(result.status,'confirmed');assert.equal(inspected.receiptId,'r');
 assert.ok(h.calls.every(call=>new URL(call.url).searchParams.get('format')==='metadata'));
 assert.equal(Object.hasOwn(result.observations[0].fields,'hasAttachments'),false);
});
test('sending, full body hydration, and other providers retain their content reads',async()=>{
 const h=harness(),executor={execute:async()=>{await h.read('messages/m?format=full');return{status:'confirmed',bodies:[{text:'full content'}]}},inspect:async()=>({status:'uncertain'})};
 const wrapped=decorateOperationExecutor(executor,{name:'google'},h);
 const result=await wrapped.execute({operation:{intent:{kind:'send'}}});
 assert.equal(result.bodies[0].text,'full content');assert.equal(new URL(h.calls[0].url).searchParams.get('format'),'full');
 assert.equal(decorateOperationExecutor(executor,{name:'microsoft'},h),executor);
 assert.equal(decorateOperationExecutor(executor,{name:'google'}),executor);
});
test('metadata scope never rewrites or retries mutation bodies',async()=>{
 const h=harness();let calls=0,actual;
 const options={method:'POST',body:JSON.stringify({ids:['a','b'],removeLabelIds:['INBOX']})};
 const pace=async()=>{};pace.cooldown=()=>{};
 const transport=createGmailTransport(pace,{context:()=>({metadataOnly:true}),log:()=>{}});
 await transport(async(input,opts)=>{calls++;actual={input,options:opts};return new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}',{status:403})},base+'messages/batchModify',options);
 assert.equal(calls,1);assert.equal(actual.input,base+'messages/batchModify');assert.equal(actual.options.body,options.body);
});
test('executor errors and uncertain results retain normal recovery semantics',async()=>{
 const h=harness(),uncertain={status:'uncertain',receiptId:'retry'};
 const error=new Error('transient');const executor={execute:async()=>{throw error},inspect:async()=>uncertain};
 const wrapped=decorateOperationExecutor(executor,{name:'google'},h),input={operation:{intent:{kind:'metadata'}}};
 await assert.rejects(wrapped.execute(input),e=>e===error);assert.equal(await wrapped.inspect(input),uncertain);
});
test('pinned executor export is wrapped once and remains compatible with repeated startup patching',()=>{
 const vm=require('node:vm');const source='['+OPERATION_FACTORY+'execute(){return t.name},inspect(){return a}}}]';
 const patched=patchRuntimeSource(source);assert.ok(patched.includes(OPERATION_GUARDED));assert.equal(patchRuntimeSource(patched),patched);
 let wrapped=0;const sandbox={};sandbox[Symbol.for('inboxzero.gmailPacing')]={operationExecutor:(value)=>{wrapped++;return value}};
 const exported=vm.runInNewContext(patched,sandbox);
 const value=exported[2]({provider:{name:'google'},accountId:'account'});
 assert.equal(value.execute(),'google');assert.equal(value.inspect(),'account');assert.equal(wrapped,1);
});
