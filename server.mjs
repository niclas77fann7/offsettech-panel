import http from 'node:http';
import { createStaff,checkOwnerPassword } from './staff.mjs';
import { verifyDiscord,registerCommands,interactionReply,commandDefinitions } from './discord.mjs';
import { createHosting,missingHosting } from './hosting.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { random,hash,equal,validStripeSignature,slotsFromSubscriptions,stripeMode,checkoutAllowed } from './security.mjs';
const cfg=process.env, publicURL=cfg.PUBLIC_URL?.replace(/\/$/,'');
if(!publicURL||!publicURL.startsWith('https://'))throw Error('PUBLIC_URL must be your HTTPS origin');
if(new URL(publicURL).origin!==publicURL)throw Error('PUBLIC_URL must contain only an origin');
const dbPath=cfg.DB_PATH||'./data/offsettech.sqlite';mkdirSync(dirname(dbPath),{recursive:true});
const db=new DatabaseSync(dbPath);db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL,customer TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS states(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,processed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS entitlements(user_id TEXT PRIMARY KEY REFERENCES users(id),monthly INTEGER NOT NULL,yearly INTEGER NOT NULL,updated INTEGER NOT NULL);`);
db.exec('CREATE TABLE IF NOT EXISTS stripe_test_customers(user_id TEXT PRIMARY KEY REFERENCES users(id),customer TEXT NOT NULL UNIQUE);');
function paymentUser(user){if(cfg.STRIPE_TEST_MODE!=='true')return user;const id=user.user_id||user.id;return {...user,customer:db.prepare('SELECT customer FROM stripe_test_customers WHERE user_id=?').get(id)?.customer||null};}
const html=readFileSync(new URL('./app.html',import.meta.url));const now=()=>Math.floor(Date.now()/1000);
const query=(s,...args)=>db.prepare(s).get(...args),run=(s,...args)=>db.prepare(s).run(...args);
const cookie=(req,key)=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='))?.slice(key.length+1);
const session=req=>{const token=cookie(req,'__Host-offset_session');return token?query('SELECT sessions.*,users.username,users.customer FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.id=? AND expires>?',hash(token),now()):null};
const securityHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'Strict-Transport-Security':'max-age=31536000'};
function send(res,status,data,extra={}){res.writeHead(status,{...securityHeaders,'Content-Type':'application/json',...extra});res.end(typeof data==='string'?data:JSON.stringify(data));}
const redirect=(res,url,cookies)=>send(res,303,'',{'Location':url,...cookies?{'Set-Cookie':cookies}:{}});
function requireSession(req){const s=session(req);if(!s)throw Object.assign(Error('Please sign in with Discord.'),{status:401});return s;}
function csrf(req,s){if(req.headers.origin!==publicURL||!equal(req.headers['x-csrf-token'],s.csrf))throw Object.assign(Error('Invalid request. Refresh and try again.'),{status:403});}
function need(...keys){if(keys.some(k=>!cfg[k]))throw Object.assign(Error('This connection is not configured yet.'),{status:503});}
async function body(req){let b=[],size=0;for await(const c of req){size+=c.length;if(size>65536)throw Object.assign(Error('Request too large'),{status:413});b.push(c);}return Buffer.concat(b);}
async function stripe(path,params=null,key=null){need('STRIPE_SECRET_KEY');stripeMode(cfg);const r=await fetch('https://api.stripe.com/v1/'+path,{method:params?'POST':'GET',headers:{Authorization:'Bearer '+cfg.STRIPE_SECRET_KEY,'Stripe-Version':'2025-06-30.basil',...params?{'Content-Type':'application/x-www-form-urlencoded'}:{},...key?{'Idempotency-Key':key}:{}},body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok)throw Error('Payment provider request failed');return d;}
async function sync(user){user=paymentUser(user);if(!user.customer)return {monthly:0,yearly:0,total:0};const all=[];let after='';do{const p=new URLSearchParams({customer:user.customer,status:'all',limit:'100','expand[]':'data.latest_invoice'});if(after)p.set('starting_after',after);const result=await stripe('subscriptions?'+p);all.push(...result.data);after=result.has_more?result.data.at(-1)?.id:'';}while(after);
 const slots=slotsFromSubscriptions(all,cfg.STRIPE_MONTHLY_PRICE_ID,cfg.STRIPE_YEARLY_PRICE_ID);
 run('INSERT INTO entitlements VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET monthly=excluded.monthly,yearly=excluded.yearly,updated=excluded.updated',user.user_id||user.id,slots.monthly,slots.yearly,now());return slots;}
// In-process serialization prevents duplicate customer creation for concurrent checkouts.
const locks=new Map();async function locked(key,fn){const previous=locks.get(key)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}}
const hosting=createHosting({cfg,db,random,now});
const staff=createStaff({cfg,db,now});
db.exec('CREATE TABLE IF NOT EXISTS discord_requests(id TEXT PRIMARY KEY,created INTEGER NOT NULL);');
const passwordAttempts=new Map();
function slotAllowance(user,paid){return cfg.COMMERCE_ENABLED!=='true'&&cfg.HOSTING_TEST_DISCORD_ID===user?Math.max(1,paid):paid;}
const rate=new Map();function limit(req,s){const key=s?.user_id||req.socket.remoteAddress;const t=Math.floor(Date.now()/60000),v=rate.get(key);if(v?.t===t&&v.n>=30)throw Object.assign(Error('Too many requests. Try again in a minute.'),{status:429});rate.set(key,{t,n:v?.t===t?v.n+1:1});if(rate.size>10000)for(const [k,x]of rate)if(x.t<t)rate.delete(k);}
http.createServer(async(req,res)=>{try{const url=new URL(req.url,publicURL),p=url.pathname;
 if(req.method==='GET'&&p==='/health')return send(res,200,{ok:true});
 if(req.method==='GET'&&p==='/')return send(res,200,readFileSync(new URL('./landing.html',import.meta.url)).toString(),{'Content-Type':'text/html; charset=utf-8'});
 if(req.method==='GET'&&p==='/docs')return send(res,200,readFileSync(new URL('./docs.html',import.meta.url)).toString(),{'Content-Type':'text/html; charset=utf-8'});
 if(req.method==='GET'&&p==='/signin'){if(session(req))return redirect(res,'/dashboard');return send(res,200,readFileSync(new URL('./signin.html',import.meta.url)).toString(),{'Content-Type':'text/html; charset=utf-8'});}
 if(req.method==='GET'&&['/dashboard','/staff'].includes(p)){const current=session(req);if(!current)return redirect(res,'/signin');if(p==='/staff'&&!staff.identity(current.user_id).permissions.length)return redirect(res,'/dashboard');return send(res,200,html.toString(),{'Content-Type':'text/html; charset=utf-8'});}
 if(req.method==='GET'&&['/site.css','/site.js','/signin.js','/staff-ui.js'].includes(p))return send(res,200,readFileSync(new URL('.'+p,import.meta.url)).toString(),{'Content-Type':p.endsWith('.css')?'text/css':'text/javascript'});
 if(req.method==='GET'&&p==='/api/session'){const current=session(req);return send(res,200,{user:current?{id:current.user_id,name:current.username}:null});}
 if(req.method==='POST'&&p==='/api/auth/password'){
  if(req.headers.origin!==publicURL)return send(res,403,{error:'Invalid login origin.'});
  const key=req.socket.remoteAddress;const attempts=passwordAttempts.get(key)||{count:0,until:now()+900};
  if(attempts.until<=now()){attempts.count=0;attempts.until=now()+900;}
  if(attempts.count>=6)return send(res,429,{error:'Too many login attempts. Try again in 15 minutes.'});
  attempts.count++;passwordAttempts.set(key,attempts);const input=JSON.parse(await body(req));
  if(!cfg.STAFF_OWNER_PASSWORD)return send(res,503,{error:'Password login is not configured. Use Discord sign-in, or set STAFF_OWNER_PASSWORD privately in Coolify.'});
  if(!await checkOwnerPassword(cfg,input.username,input.password))return send(res,401,{error:'Incorrect username or password.'});
  passwordAttempts.delete(key);run('INSERT INTO users(id,username) VALUES(?,?) ON CONFLICT(id) DO NOTHING',staff.ownerId,cfg.STAFF_OWNER_USERNAME||'myriad6969');
  const sid=random();run('INSERT INTO sessions VALUES(?,?,?,?)',hash(sid),staff.ownerId,random(),now()+28800);staff.audit(staff.ownerId,'owner.login',staff.ownerId,'Password sign-in');
  return send(res,200,{url:'/staff'},{'Set-Cookie':'__Host-offset_session='+sid+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800'});
 }
 if(req.method==='POST'&&p==='/api/discord/interactions'){
  const raw=await body(req);if(!verifyDiscord(raw,req.headers['x-signature-ed25519'],req.headers['x-signature-timestamp'],cfg.DISCORD_PUBLIC_KEY))return send(res,401,{error:'Invalid Discord signature.'});
  const interaction=JSON.parse(raw);if(interaction.application_id!==cfg.DISCORD_CLIENT_ID)return send(res,401,{error:'Wrong application.'});
  if(interaction.type===1)return send(res,200,{type:1});
  if(interaction.type!==2)return send(res,400,{error:'Unsupported interaction.'});
  const id=interaction.member?.user?.id||interaction.user?.id;
  if(!id||!interaction.id||!interaction.token)return send(res,400,{error:'Invalid interaction.'});limit(req,{user_id:'discord:'+id});
  run('DELETE FROM discord_requests WHERE created<?',now()-900);
  if(query('SELECT id FROM discord_requests WHERE id=?',interaction.id))return send(res,200,{type:5,data:{flags:64}});
  run('INSERT INTO discord_requests VALUES(?,?)',interaction.id,now());
  send(res,200,{type:5,data:{flags:64}});
  void handleDiscord(interaction,id).then(content=>interactionReply(cfg,interaction,content)).catch(async()=>{try{await interactionReply(cfg,interaction,'The action could not be completed. Check your dashboard for details.');}catch{console.error('Discord reply failed');}});
  return;
 }

 if(req.method==='GET'&&p==='/app.js')return send(res,200,readFileSync(new URL('./app.js',import.meta.url)).toString(),{'Content-Type':'text/javascript'});
 if(req.method==='GET'&&p==='/api/auth/discord'){
  need('DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET');limit(req);const state=random();run('DELETE FROM states WHERE expires<?',now());run('INSERT INTO states VALUES(?,?)',hash(state),now()+600);
  const q=new URLSearchParams({client_id:cfg.DISCORD_CLIENT_ID,response_type:'code',redirect_uri:publicURL+'/api/auth/discord/callback',scope:'identify',state});return redirect(res,'https://discord.com/oauth2/authorize?'+q,'__Host-offset_state='+state+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
 }
 if(req.method==='GET'&&p==='/api/auth/discord/callback'){
  need('DISCORD_CLIENT_SECRET');const state=url.searchParams.get('state'),saved=cookie(req,'__Host-offset_state');if(!state||!equal(state,saved))return send(res,400,{error:'Login expired or invalid. Start again.'});
  const found=run('DELETE FROM states WHERE id=? AND expires>?',hash(state),now());if(!found.changes)return send(res,400,{error:'Login expired. Start again.'});
  const code=url.searchParams.get('code');if(!code)return redirect(res,'/?login=cancelled');const issuer=url.searchParams.get('iss');if(issuer&&issuer!=='https://discord.com')return send(res,400,{error:'Invalid login issuer'});
  const tokenRes=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:cfg.DISCORD_CLIENT_ID,client_secret:cfg.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:publicURL+'/api/auth/discord/callback'}),signal:AbortSignal.timeout(15000)});if(!tokenRes.ok)throw Error('Discord login failed');const token=await tokenRes.json();
  const who=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(15000)});if(!who.ok)throw Error('Discord identity lookup failed');const user=await who.json();if(!/^\d+$/.test(user.id))throw Error('Invalid Discord user');
  run('INSERT INTO users(id,username) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username',user.id,user.global_name||user.username);
  const sid=random();run('DELETE FROM sessions WHERE expires<?',now());run('INSERT INTO sessions VALUES(?,?,?,?)',hash(sid),user.id,random(),now()+604800);
  return redirect(res,'/dashboard',['__Host-offset_session='+sid+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800','__Host-offset_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
 }
 if(req.method==='POST'&&p==='/api/stripe/webhook'){
  need('STRIPE_WEBHOOK_SECRET');const raw=await body(req);if(!validStripeSignature(raw,req.headers['stripe-signature'],cfg.STRIPE_WEBHOOK_SECRET))return send(res,400,{error:'Invalid signature'});
  const event=JSON.parse(raw);if(event.livemode!==(cfg.STRIPE_TEST_MODE!=='true'))return send(res,400,{error:'Webhook mode does not match this deployment.'});if(query('SELECT id FROM events WHERE id=?',event.id))return send(res,200,{received:true});
  if(['checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
   const obj=event.data.object,customer=typeof obj.customer==='string'?obj.customer:obj.customer?.id;
   const user=customer?(cfg.STRIPE_TEST_MODE==='true'?query('SELECT users.* FROM users JOIN stripe_test_customers ON stripe_test_customers.user_id=users.id WHERE stripe_test_customers.customer=?',customer):query('SELECT * FROM users WHERE customer=?',customer)):null;
   if(user)await locked(user.id,async()=>{const slots=await sync(user);if(hosting.ready())await hosting.enforce(user.id,slotAllowance(user.id,slots.total));});
  }
  run('INSERT OR IGNORE INTO events VALUES(?,?)',event.id,now());return send(res,200,{received:true});
 }
 if(req.method==='GET'&&p==='/api/account'){
  const s=session(req);if(!s)return send(res,200,{user:null,paymentsReady:!!cfg.STRIPE_SECRET_KEY});const slots=await locked(s.user_id,async()=>{let paid,verified=true;try{paid=await sync(s);}catch{verified=false;const cached=query('SELECT * FROM entitlements WHERE user_id=?',s.user_id);paid={monthly:cached?.monthly||0,yearly:cached?.yearly||0,total:(cached?.monthly||0)+(cached?.yearly||0)};}if(verified&&hosting.ready())await hosting.enforce(s.user_id,slotAllowance(s.user_id,paid.total));await hosting.refresh(s.user_id);return paid;});return send(res,200,{user:{id:s.user_id,name:s.username},csrf:s.csrf,slots,paymentsReady:!!(cfg.STRIPE_SECRET_KEY&&cfg.STRIPE_WEBHOOK_SECRET),deploymentReady:hosting.ready(),commerceEnabled:checkoutAllowed(cfg,s.user_id),paymentsTestMode:cfg.STRIPE_TEST_MODE==='true',hostingMissing:missingHosting(cfg),bots:hosting.list(s.user_id),hostingTest:cfg.COMMERCE_ENABLED!=='true'&&cfg.HOSTING_TEST_DISCORD_ID===s.user_id,staff:staff.identity(s.user_id),discordConfigured:!!cfg.DISCORD_PUBLIC_KEY,discordInstallURL:'https://discord.com/oauth2/authorize?client_id='+cfg.DISCORD_CLIENT_ID+'&scope=applications.commands',discordCommands:commandDefinitions.map(c=>c.name)});
 }
 if(req.method==='GET'&&p==='/api/bots/status'){
  const s=requireSession(req);limit(req,s);return await locked(s.user_id,async()=>{await hosting.refresh(s.user_id);return send(res,200,{bots:hosting.list(s.user_id)});});
 }
 if(req.method==='POST'&&p==='/api/logout'){const s=requireSession(req);csrf(req,s);run('DELETE FROM sessions WHERE id=?',s.id);return send(res,200,{ok:true},{'Set-Cookie':'__Host-offset_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'});}
 if(req.method==='POST'&&p==='/api/checkout'){
  const s=requireSession(req);csrf(req,s);limit(req,s);if(!checkoutAllowed(cfg,s.user_id)||!hosting.ready())return send(res,503,{error:'Checkout is not open while hosting is being connected.'});need('STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_MONTHLY_PRICE_ID','STRIPE_YEARLY_PRICE_ID');const input=JSON.parse(await body(req));
  if(!['monthly','yearly'].includes(input.plan)||!Number.isInteger(input.quantity)||input.quantity<1||input.quantity>100)return send(res,400,{error:'Choose a plan and 1–100 slots.'});
  const price=input.plan==='monthly'?cfg.STRIPE_MONTHLY_PRICE_ID:cfg.STRIPE_YEARLY_PRICE_ID;
  return await locked(s.user_id,async()=>{let user=paymentUser(query('SELECT * FROM users WHERE id=?',s.user_id));if(!user.customer){const c=await stripe('customers',{'metadata[discord_id]':s.user_id},'customer-'+(cfg.STRIPE_TEST_MODE==='true'?'test-':'live-')+s.user_id);if(cfg.STRIPE_TEST_MODE==='true')run('INSERT INTO stripe_test_customers VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET customer=excluded.customer',s.user_id,c.id);else run('UPDATE users SET customer=? WHERE id=?',c.id,s.user_id);user.customer=c.id;}
  const result=await stripe('checkout/sessions',{mode:'subscription',customer:user.customer,'line_items[0][price]':price,'line_items[0][quantity]':String(input.quantity),client_reference_id:s.user_id,'subscription_data[metadata][discord_id]':s.user_id,success_url:publicURL+'/dashboard?checkout=success',cancel_url:publicURL+'/dashboard?checkout=cancelled'});return send(res,200,{url:result.url});});
 }
 if(req.method==='POST'&&p==='/api/billing'){
  const s=requireSession(req);csrf(req,s);limit(req,s);const user=paymentUser(s);if(!user.customer)return send(res,400,{error:'No billing account yet.'});const portal=await stripe('billing_portal/sessions',{customer:user.customer,return_url:publicURL+'/dashboard?tab=billing'});return send(res,200,{url:portal.url});
 }
 if(req.method==='POST'&&p==='/api/hosting/check'){
  const s=requireSession(req);csrf(req,s);limit(req,s);return send(res,200,await hosting.check());
 }
 if(req.method==='POST'&&p==='/api/bots'){
  const s=requireSession(req);csrf(req,s);limit(req,s);const input=JSON.parse(await body(req));
  return await locked(s.user_id,async()=>{const paid=await sync(s);const result=await hosting.create(s.user_id,input,slotAllowance(s.user_id,paid.total));staff.audit(s.user_id,'bot.created',result.id,result.name);return send(res,201,{bot:result});});
 }
 const actionMatch=p.match(/^\/api\/bots\/([a-f0-9-]+)\/(start|stop|restart)$/);
 if(req.method==='POST'&&actionMatch){
  const s=requireSession(req);csrf(req,s);limit(req,s);return await locked(s.user_id,async()=>{const paid=actionMatch[2]==='stop'?{total:0}:await sync(s);const result=await hosting.control(s.user_id,actionMatch[1],actionMatch[2],slotAllowance(s.user_id,paid.total));staff.audit(s.user_id,'bot.'+actionMatch[2],actionMatch[1]);return send(res,200,{bot:result});});
 }

 const ownBot=p.match(/^\/api\/bots\/([a-f0-9-]+)$/);
 if(ownBot&&['PATCH','DELETE'].includes(req.method)){
  const current=requireSession(req);csrf(req,current);limit(req,current);
  return await locked(current.user_id,async()=>{if(req.method==='PATCH'){const result=await hosting.edit(current.user_id,ownBot[1],JSON.parse(await body(req)));staff.audit(current.user_id,'bot.edited',ownBot[1]);return send(res,200,{bot:result});}
   const result=await hosting.remove(current.user_id,ownBot[1]);staff.audit(current.user_id,'bot.deleted',ownBot[1],'Instance removal queued; database volume retained');return send(res,200,result);});
 }
 if(req.method==='GET'&&p==='/api/staff'){
  const current=requireSession(req);limit(req,current);const actor=staff.identity(current.user_id);if(!actor.permissions.length)return send(res,403,{error:'Staff access required.'});
  if(actor.permissions.includes('bots.view'))for(const owner of new Set(hosting.all().map(b=>b.ownerId)))await locked(owner,()=>hosting.refresh(owner));
  return send(res,200,{actor,bots:actor.permissions.includes('bots.view')?hosting.all():[],members:actor.permissions.includes('staff.manage')?staff.list(current.user_id):[],audit:actor.permissions.includes('audit.view')?staff.logs(current.user_id):[],permissionCatalog:staff.permissionCatalog,roles:staff.roles,discord:{configured:!!cfg.DISCORD_PUBLIC_KEY,endpoint:publicURL+'/api/discord/interactions',installURL:'https://discord.com/oauth2/authorize?client_id='+cfg.DISCORD_CLIENT_ID+'&scope=applications.commands'}});
 }
 if(req.method==='POST'&&p==='/api/staff/members'){
  const current=requireSession(req);csrf(req,current);limit(req,current);return send(res,200,{member:staff.save(current.user_id,JSON.parse(await body(req)))});
 }
 const member=p.match(/^\/api\/staff\/members\/(\d+)$/);
 if(req.method==='DELETE'&&member){const current=requireSession(req);csrf(req,current);limit(req,current);staff.remove(current.user_id,member[1]);return send(res,200,{removed:true});}
 if(req.method==='POST'&&p==='/api/staff/discord/register'){
  const current=requireSession(req);csrf(req,current);staff.requirePermission(current.user_id,'system.manage');limit(req,current);const result=await registerCommands(cfg);staff.audit(current.user_id,'discord.commands_registered',cfg.DISCORD_CLIENT_ID);return send(res,200,result);
 }
 const staffBot=p.match(/^\/api\/staff\/bots\/([a-f0-9-]+)(?:\/(start|stop|restart|revoke|restore))?$/);
 if(staffBot&&['POST','PATCH','DELETE'].includes(req.method)){
  const current=requireSession(req);csrf(req,current);limit(req,current);const action=staffBot[2];
  const permission=req.method==='DELETE'?'bots.delete':action==='revoke'||action==='restore'?'bots.revoke':'bots.manage';staff.requirePermission(current.user_id,permission);
  const target=hosting.find(staffBot[1]);
  return await locked(target.user_id,async()=>{
   staff.requirePermission(current.user_id,permission);
   let result;
   if(req.method==='DELETE')result=await hosting.remove(target.user_id,target.id);
   else if(req.method==='PATCH')result={bot:await hosting.edit(target.user_id,target.id,JSON.parse(await body(req)))};
   else if(action==='revoke')result={bot:await hosting.revoke(target.id)};
   else if(action==='restore')result={bot:hosting.restore(target.id)};
   else if(['start','stop','restart'].includes(action)){const user=query('SELECT * FROM users WHERE id=?',target.user_id);const paid=action==='stop'?{total:0}:await sync(user);result={bot:await hosting.control(target.user_id,target.id,action,slotAllowance(target.user_id,paid.total))};}
   else return send(res,400,{error:'Unknown staff action.'});
   staff.audit(current.user_id,'staff.bot.'+(req.method==='DELETE'?'delete':req.method==='PATCH'?'edit':action),target.id);return send(res,200,result);
  });
 }
 if(req.method==='GET'&&p==='/hosting-logs-unavailable')return send(res,501,'Log viewing is not included in this hosting test. Threads are stored in the bot database.',{'Content-Type':'text/plain'});
 return send(res,404,{error:'Not found'});
 }catch(e){const status=e.status||502;console.error('Request failed:',status);return send(res,status,{error:e.status?e.message:'Connection failed. Please try again.'});}}).listen(Number(cfg.PORT||3000),'0.0.0.0',()=>console.log('OffsetTech listening on configured port'));


// Reconcile renewals/expiry even when the customer does not open the site or a webhook is missed.
let sweeping=false;
setInterval(async()=>{if(sweeping||!hosting.ready())return;sweeping=true;try{for(const user of db.prepare('SELECT DISTINCT users.* FROM users JOIN bots ON users.id=bots.user_id').all()){try{await locked(user.id,async()=>{const slots=await sync(user);await hosting.enforce(user.id,slotAllowance(user.id,slots.total));});}catch{console.error('Hosting reconciliation needs attention');}}}finally{sweeping=false;}},300000).unref();

async function handleDiscord(interaction,id){
 const command=interaction.data.name;const path=publicURL+'/dashboard';
 if(!query('SELECT id FROM users WHERE id=?',id))return 'Sign in with Discord first: '+publicURL+'/signin';
 if(command==='deploy')return 'Deploy your bot privately: '+path+'?deploy=1';
 if(command==='billing')return 'Manage your hosting: '+path+'?tab=billing';
 if(command==='edit'||command==='delete')return 'Manage your bots securely: '+path;
 if(command==='staff')return staff.identity(id).permissions.length?'Staff console: '+publicURL+'/staff':'You do not have staff access.';
 return await locked(id,async()=>{
  const user=query('SELECT * FROM users WHERE id=?',id);const slots=command==='stop'?{total:0}:await sync(user);await hosting.refresh(id);const bots=hosting.list(id);
  if(command==='status')return 'Slots: '+bots.length+'/'+slotAllowance(id,slots.total)+'\n'+(bots.length?bots.map(b=>b.name+' — '+b.status.replaceAll('_',' ')).join('\n'):'No bots deployed.');
  if(['start','stop','restart'].includes(command)){
   const selected=interaction.data.options?.find(x=>x.name==='bot')?.value;const matches=bots.filter(b=>b.id===selected||b.name.toLowerCase()===String(selected).toLowerCase());
   if(matches.length!==1)return 'Use the exact bot name or its dashboard ID. No unique matching bot was found.';
   try{await hosting.control(id,matches[0].id,command,slotAllowance(id,slots.total));staff.audit(id,'discord.bot.'+command,matches[0].id);return command+' queued for '+matches[0].name+'. Check status on the dashboard.';}catch(e){return e.status?e.message:'The hosting action failed. Check the dashboard.';}
  }
  return 'Unknown command. Open your dashboard: '+path;
 });
}
