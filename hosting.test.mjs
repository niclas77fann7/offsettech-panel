import { test } from 'node:test';import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{createHosting,template,missingHosting}from'./hosting.mjs';
const owner='123456789012345678',guild='234567890123456789',image='ghcr.io/modmail-dev/modmail@sha256:'+'a'.repeat(64);
const cfg={PUBLIC_URL:'https://panel.example',COOLIFY_API_URL:'http://coolify:8080',COOLIFY_API_TOKEN:'private',COOLIFY_PROJECT_UUID:'project',COOLIFY_SERVER_UUID:'server',MODMAIL_IMAGE:image,HOSTING_ENABLED:'true'};
function setup(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE users(id TEXT PRIMARY KEY);');db.prepare('INSERT INTO users VALUES(?)').run(owner);const calls=[];const fetcher=async(url,options={})=>{calls.push({url,options});if(url.includes('discord.com'))return new Response(JSON.stringify({id:'345678901234567890',owner:{id:owner}}));if(url.endsWith('/envs')&&options.method==='POST')return new Response(JSON.stringify({message:'Environment variable already exists'}),{status:409});if(url.endsWith('/services'))return new Response(JSON.stringify({uuid:'service1'}));return new Response('{}');};return{db,calls,host:createHosting({cfg,db,fetcher,random:()=> 'a'.repeat(64),now:()=>2000})};}
test('template never embeds credentials and isolates database',()=>{const t=JSON.parse(template(guild,owner,image,'https://example/logs'));assert.equal(t.services.bot.environment.TOKEN,'${BOT_TOKEN}');assert.equal(t.services.mongo.environment.MONGO_INITDB_ROOT_PASSWORD,'${MONGO_PASSWORD}');assert.equal(t.networks.private.internal,true);assert.equal(t.services.mongo.ports,undefined);assert.equal(t.services.bot.privileged,undefined);assert.ok(t.services.bot.command[2].includes('hosting_check'));assert.throws(()=>template(guild,owner,'mutable:latest',''),/digest/);});
test('no slot rejects before contacting either provider',async()=>{const{host,calls}=setup();await assert.rejects(host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},0),/slot/);assert.equal(calls.length,0);});
test('provision reserves one slot and does not expose token',async()=>{const{host,calls}=setup();const bot=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);assert.equal(bot.status,'starting');assert.ok(!JSON.stringify(bot).includes('a'.repeat(60)));assert.equal(host.list(owner).length,1);await assert.rejects(host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1),/slot/);const create=calls.find(x=>x.url.endsWith('/services'));assert.equal(JSON.parse(create.options.body).connect_to_docker_network,false);});
test('other users cannot control a bot',async()=>{const{host}=setup();const bot=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);await assert.rejects(host.control('999999999999999999',bot.id,'stop',1),/not found/);});
test('expired slots are stopped and cannot restart',async()=>{const{host,calls}=setup();const bot=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);await host.enforce(owner,0);assert.equal(host.list(owner)[0].status,'suspended');assert.ok(calls.some(c=>c.url.endsWith('/stop')));await assert.rejects(host.control(owner,bot.id,'start',0),/active hosting slot/);});
test('ambiguous creation is not retried and keeps reservation',async()=>{const{db}=setup();const host=createHosting({cfg,db,random:()=>'',now:()=>1,fetcher:async url=>{if(url.includes('discord'))return new Response(JSON.stringify({id:'345678901234567890',owner:{id:owner}}));throw Error('timeout');}});await assert.rejects(host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1));assert.equal(host.list(owner)[0].status,'needs_attention');await assert.rejects(host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1),/slot/);});
test('missing deployment configuration is reported by name only',()=>assert.deepEqual(missingHosting({}),['COOLIFY_API_URL','COOLIFY_API_TOKEN','COOLIFY_PROJECT_UUID','COOLIFY_SERVER_UUID','MODMAIL_IMAGE']));

test('observed healthy containers recover an earlier needs-attention reservation',async()=>{
 const {db}=setup();
 db.prepare('INSERT INTO bots VALUES(?,?,?,?,?,?,?,?)').run('reserved',owner,'Test',guild,'345678901234567890','existing-service','needs_attention',1);
 const calls=[];const host=createHosting({cfg,db,random:()=>'',now:()=>2,fetcher:async(url,options={})=>{calls.push({url,method:options.method});return new Response(JSON.stringify({applications:[{name:'bot',status:'running:unknown'}],databases:[{name:'mongo',status:'running:healthy'}]}));}});
 await host.refresh(owner);assert.equal(host.list(owner)[0].status,'running');assert.equal(host.list(owner).length,1);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
 await host.control(owner,'reserved','restart',1);assert.equal(host.list(owner)[0].status,'restarting');
});
test('provider outage cannot clear a failed reservation or query another user',async()=>{
 const {db}=setup();db.prepare('INSERT INTO bots VALUES(?,?,?,?,?,?,?,?)').run('reserved',owner,'Test',guild,'345678901234567890','existing-service','needs_attention',1);
 let count=0;const host=createHosting({cfg,db,random:()=>'',now:()=>2,fetcher:async()=>{count++;throw Error('offline');}});
 await host.refresh('another-user');assert.equal(count,0);await host.refresh(owner);assert.equal(host.list(owner)[0].status,'needs_attention');assert.equal(host.list(owner).length,1);
});
test('unhealthy containers are not reported as recovered',async()=>{
 const {db}=setup();db.prepare('INSERT INTO bots VALUES(?,?,?,?,?,?,?,?)').run('reserved',owner,'Test',guild,'345678901234567890','existing-service','needs_attention',1);
 const host=createHosting({cfg,db,random:()=>'',now:()=>2,fetcher:async()=>new Response(JSON.stringify({applications:[{name:'bot',status:'running:unhealthy'}],databases:[{name:'mongo',status:'running:healthy'}]}))});await host.refresh(owner);assert.equal(host.list(owner)[0].status,'needs_attention');
});

test('queued stop remains stopping until Coolify observes exit',async()=>{
 const {operationState}=await import('./hosting.mjs');const operation={action:'stop',requested:10,transition_seen:0};
 assert.equal(operationState(operation,'running:healthy','running:healthy',11).status,'stopping');
 assert.equal(operationState(operation,'exited:unhealthy','exited:unhealthy',20).status,'stopped');
 assert.equal(operationState(operation,'running:healthy','running:healthy',131).status,'stop_unconfirmed');
});
test('queued restart cannot be confirmed by the old running snapshot',async()=>{
 const {operationState}=await import('./hosting.mjs');const operation={action:'restart',requested:10,transition_seen:0};
 assert.equal(operationState(operation,'running:healthy','running:healthy',11).confirmed,false);
 assert.equal(operationState(operation,'exited:unhealthy','running:healthy',12).seen,true);
 assert.equal(operationState({...operation,transition_seen:1},'running:healthy','running:healthy',20).confirmed,true);
 assert.equal(operationState(operation,'running:healthy','running:healthy',131).status,'restart_unconfirmed');
});

test('revoked bots cannot be restarted and deleted instances leave customer lists',async()=>{const{host,db}=setup();const b=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);await host.revoke(b.id);assert.equal(host.list(owner)[0].status,'revoked');await assert.rejects(host.control(owner,b.id,'start',1),/revoked/);await assert.rejects(host.control(owner,b.id,'stop',1),/revoked/);assert.equal(host.list(owner)[0].status,'revoked');await assert.rejects(host.control(owner,b.id,'restart',1),/revoked/);host.restore(b.id);assert.equal(host.list(owner)[0].status,'stopped');db.prepare("UPDATE bots SET state='deleted' WHERE id=?").run(b.id);assert.equal(host.list(owner).length,0);});
test('delete requests preserve database volumes and require observed provider removal',async()=>{const{host,calls}=setup();const b=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);const result=await host.remove(owner,b.id);assert.equal(result.pending,true);assert.equal(host.list(owner)[0].status,'deleting');const request=calls.find(c=>c.options.method==='DELETE');assert.ok(request.url.includes('delete_volumes=false'));});
test('editing the display name never changes bot ownership or exposes secrets',async()=>{const{host,calls}=setup();const b=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);const count=calls.length;const updated=await host.edit(owner,b.id,{name:'New name',guildId:guild});assert.equal(updated.name,'New name');assert.equal(updated.ownerId,owner);assert.equal(calls.length,count);await assert.rejects(host.edit('999999999999999999',b.id,{name:'Stolen',guildId:guild}),/not found/);});

test('configuration edits preserve secret references and restart the existing service',async()=>{
 const {host,db,calls}=setup();const b=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);db.prepare("UPDATE bots SET state='running' WHERE id=?").run(b.id);calls.length=0;
 const updated=await host.edit(owner,b.id,{name:'Edited',guildId:'456789012345678901'});assert.equal(updated.status,'restarting');assert.equal(updated.guildId,'456789012345678901');const patch=calls.find(c=>c.options.method==='PATCH'&&c.url.endsWith('/services/service1'));const compose=JSON.parse(Buffer.from(JSON.parse(patch.options.body).docker_compose_raw,'base64').toString());assert.equal(compose.services.bot.environment.TOKEN,'${BOT_TOKEN}');assert.equal(compose.services.mongo.environment.MONGO_INITDB_ROOT_PASSWORD,'${MONGO_PASSWORD}');assert.ok(calls.some(c=>c.url.endsWith('/restart')));assert.ok(!calls.some(c=>c.url.endsWith('/envs/bulk')));
});
test('confirmed deletion frees the reservation and duplicate bot identity',async()=>{
 const {host,db}=setup();const b=await host.create(owner,{name:'Bot',token:'a'.repeat(60),guildId:guild},1);await host.remove(owner,b.id);const removed=createHosting({cfg,db,random:()=>'',now:()=>2001,fetcher:async()=>new Response('{}',{status:404})});await removed.refresh(owner);assert.equal(removed.list(owner).length,0);assert.equal(db.prepare('SELECT discord_bot_id FROM bots WHERE id=?').get(b.id).discord_bot_id,null);assert.throws(()=>removed.find(b.id),/not found/);
});
