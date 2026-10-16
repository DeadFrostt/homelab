'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHistoryPager,decorateMailboxProvider,patchRuntimeSource,MAILBOX_GUARDED_OLD,MAILBOX_GUARDED}=require('./gmail-pacing.cjs');
const encode=c=>Buffer.from(JSON.stringify(c)).toString('base64url');
const decode=c=>JSON.parse(Buffer.from(c,'base64url'));
const baseline=()=>encode({version:1,provider:'google',phase:'delta',historyId:'10',after:'1970-01-01T00:00:00.000Z',pageToken:'legacy-label-page'});
const change=id=>({message:{id}});
function fakeProvider(pages){
 const calls=[],hydrated=[];
 return {name:'google',calls,hydrated,
  client:{users:{history:{list:async args=>{calls.push(args);const data=pages.shift();if(!data)throw Error('Unexpected history read');return {data}}}}},
  getMessagesBatch:async ids=>{hydrated.push(ids);return ids.map(id=>({id,threadId:'thread-'+id,internalDate:'1000',labelIds:['INBOX']}))},
  getMessage:async id=>({id,internalDate:'1000'}),
  getMailboxSyncPage:async input=>({original:true,input}),
 };
}
test('legacy label backlog is re-listed and the newest arrival is hydrated first',async()=>{
 const labels=Array.from({length:35},(_,i)=>change('old-'+i));
 const p=fakeProvider([{historyId:'100',history:[{labelsAdded:labels},{messagesAdded:[change('new')]}]}]);
 const read=createHistoryPager();
 const result=await read(p,'account',{cursor:baseline(),limit:10});
 assert.equal(p.calls[0].maxResults,500);assert.equal(p.calls[0].pageToken,undefined);
 assert.equal(p.hydrated[0][0],'new');assert.equal(p.hydrated[0].length,10);
 assert.equal(result.hasMore,true);assert.equal(decode(result.cursor).historyId,'100');
 assert.ok(decode(result.cursor).inboxzeroPending);
});
test('arrivals during a pending label backlog are prioritized and every older ID is retained',async()=>{
 const old=Array.from({length:25},(_,i)=>change('old-'+i));
 const p=fakeProvider([{historyId:'100',history:[{labelsAdded:old}]},{historyId:'110',history:[{messagesAdded:[change('newest')]}]},{historyId:'110',history:[]}]);
 const read=createHistoryPager();let result=await read(p,'a',{cursor:baseline(),limit:10});
 result=await read(p,'a',{cursor:result.cursor,limit:10});
 assert.equal(p.hydrated[1][0],'newest');assert.equal(p.calls[1].startHistoryId,'100');
 result=await read(p,'a',{cursor:result.cursor,limit:10});
 assert.equal(result.hasMore,false);
 assert.deepEqual(new Set(p.hydrated.flat()),new Set([...old.map(x=>x.message.id),'newest']));
});
test('lost pending state replays the original baseline without losing newer or older changes',async()=>{
 const events=Array.from({length:15},(_,i)=>change('old-'+i));
 const p=fakeProvider([{historyId:'100',history:[{labelsAdded:events}]},{historyId:'120',history:[{labelsAdded:events},{messagesAdded:[change('new')]}]}]);
 let result=await createHistoryPager()(p,'a',{cursor:baseline(),limit:10});
 result=await createHistoryPager()(p,'a',{cursor:result.cursor,limit:10});
 assert.equal(p.calls[1].startHistoryId,'10');assert.equal(p.hydrated[1][0],'new');
 assert.equal(decode(result.cursor).inboxzeroReplayFrom,'10');
});
test('history pages are gathered before hydration so a later-page arrival is not blocked',async()=>{
 const p=fakeProvider([{historyId:'99',nextPageToken:'page-2',history:[{labelsAdded:[change('old')]}]},{historyId:'100',history:[{messagesAdded:[change('new')]}]}]);
 const result=await createHistoryPager()(p,'a',{cursor:baseline(),limit:1});
 assert.equal(p.calls[1].pageToken,'page-2');assert.deepEqual(p.hydrated[0],['new']);assert.equal(result.hasMore,true);
});
test('deleted IDs suppress old pending upserts and omitted reads require a confirmed 404',async()=>{
 const p=fakeProvider([{historyId:'100',history:[{labelsAdded:[change('gone'),change('missing')]},{messagesDeleted:[change('gone')]}]}]);
 p.getMessagesBatch=async ids=>{p.hydrated.push(ids);return []};p.getMessage=async()=>{throw Object.assign(Error('gone'),{status:404})};
 const result=await createHistoryPager()(p,'a',{cursor:baseline(),limit:10});
 assert.deepEqual(p.hydrated[0],['missing']);assert.deepEqual(new Set(result.deletedMessageIds),new Set(['gone','missing']));
});
test('transient omitted-message failures cannot advance the cursor',async()=>{
 const p=fakeProvider([{historyId:'100',history:[{messagesAdded:[change('new')]}]}]);p.getMessagesBatch=async()=>[];p.getMessage=async()=>{throw Object.assign(Error('temporary'),{status:503})};
 await assert.rejects(createHistoryPager()(p,'a',{cursor:baseline(),limit:10}),{status:503});
});
test('empty history does not fetch messages and other providers or bootstrap reads remain unchanged',async()=>{
 const p=fakeProvider([{historyId:'100',history:[]}]);const read=createHistoryPager();
 const result=await read(p,'a',{cursor:baseline(),limit:10});assert.equal(result.hasMore,false);assert.equal(p.hydrated.length,0);
 assert.equal((await read(p,'a',{after:new Date(0),limit:1})).original,true);
 const other={name:'microsoft'};assert.equal(decorateMailboxProvider(other,'a',read),other);
});
test('provider wrapper binds methods to the actual provider and upgrades existing runtime patches',async()=>{
 const p=fakeProvider([{historyId:'100',history:[]}]);p.checkThis=function(){return this===p};
 const guarded=decorateMailboxProvider(p,'a',createHistoryPager());assert.equal(guarded.checkThis(),true);
 assert.equal((await guarded.getMailboxSyncPage({cursor:baseline(),limit:10})).hasMore,false);
 assert.equal(patchRuntimeSource(MAILBOX_GUARDED_OLD),MAILBOX_GUARDED);
 assert.equal(patchRuntimeSource(MAILBOX_GUARDED),MAILBOX_GUARDED);
});
test('received inbox arrivals precede newer generated drafts',async()=>{
 const inbox={message:{id:'inbox',labelIds:['INBOX','UNREAD']}};
 const drafts=Array.from({length:20},(_,i)=>({message:{id:'draft-'+i,labelIds:['DRAFT']}}));
 const p=fakeProvider([{historyId:'100',history:[{messagesAdded:[inbox,...drafts]}]}]);
 await createHistoryPager()(p,'a',{cursor:baseline(),limit:10});
 assert.equal(p.hydrated[0][0],'inbox');
});
test('only an expired history list triggers snapshot recovery, not a failed message batch',async()=>{
 const p=fakeProvider([]);p.client.users.history.list=async()=>{throw Object.assign(Error('expired'),{status:404})};
 assert.equal((await decorateMailboxProvider(p,'a',createHistoryPager()).getMailboxSyncPage({cursor:baseline(),limit:10})).original,true);
 const q=fakeProvider([{historyId:'100',history:[{messagesAdded:[change('new')]}]}]);q.getMessagesBatch=async()=>{throw Object.assign(Error('batch failure'),{status:404})};
 await assert.rejects(decorateMailboxProvider(q,'a',createHistoryPager()).getMailboxSyncPage({cursor:baseline(),limit:10}),/batch failure/);
});
