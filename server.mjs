import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { random,hash,equal,validStripeSignature,slotsFromSubscriptions } from './security.mjs';
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
async function stripe(path,params=null,key=null){need('STRIPE_SECRET_KEY');const r=await fetch('https://api.stripe.com/v1/'+path,{method:params?'POST':'GET',headers:{Authorization:'Bearer '+cfg.STRIPE_SECRET_KEY,'Stripe-Version':'2025-06-30.basil',...params?{'Content-Type':'application/x-www-form-urlencoded'}:{},...key?{'Idempotency-Key':key}:{}},body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok)throw Error('Payment provider request failed');return d;}
async function sync(user){if(!user.customer)return {monthly:0,yearly:0,total:0};const all=[];let after='';do{const p=new URLSearchParams({customer:user.customer,status:'all',limit:'100','expand[]':'data.latest_invoice'});if(after)p.set('starting_after',after);const result=await stripe('subscriptions?'+p);all.push(...result.data);after=result.has_more?result.data.at(-1)?.id:'';}while(after);
 const slots=slotsFromSubscriptions(all,cfg.STRIPE_MONTHLY_PRICE_ID,cfg.STRIPE_YEARLY_PRICE_ID);
 run('INSERT INTO entitlements VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET monthly=excluded.monthly,yearly=excluded.yearly,updated=excluded.updated',user.user_id||user.id,slots.monthly,slots.yearly,now());return slots;}
// In-process serialization prevents duplicate customer creation for concurrent checkouts.
const locks=new Map();async function locked(key,fn){const previous=locks.get(key)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}}
const rate=new Map();function limit(req,s){const key=s?.user_id||req.socket.remoteAddress;const t=Math.floor(Date.now()/60000),v=rate.get(key);if(v?.t===t&&v.n>=30)throw Object.assign(Error('Too many requests. Try again in a minute.'),{status:429});rate.set(key,{t,n:v?.t===t?v.n+1:1});if(rate.size>10000)for(const [k,x]of rate)if(x.t<t)rate.delete(k);}
http.createServer(async(req,res)=>{try{const url=new URL(req.url,publicURL),p=url.pathname;
 if(req.method==='GET'&&p==='/health')return send(res,200,{ok:true});
 if(req.method==='GET'&&p==='/')return send(res,200,html.toString(),{'Content-Type':'text/html; charset=utf-8'});
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
  return redirect(res,'/',['__Host-offset_session='+sid+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800','__Host-offset_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
 }
 if(req.method==='POST'&&p==='/api/stripe/webhook'){
  need('STRIPE_WEBHOOK_SECRET');const raw=await body(req);if(!validStripeSignature(raw,req.headers['stripe-signature'],cfg.STRIPE_WEBHOOK_SECRET))return send(res,400,{error:'Invalid signature'});
  const event=JSON.parse(raw);if(query('SELECT id FROM events WHERE id=?',event.id))return send(res,200,{received:true});
  if(['checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
   const obj=event.data.object,customer=typeof obj.customer==='string'?obj.customer:obj.customer?.id;
   const user=customer?query('SELECT * FROM users WHERE customer=?',customer):null;
   if(user)await locked(user.id,()=>sync(user));
  }
  run('INSERT OR IGNORE INTO events VALUES(?,?)',event.id,now());return send(res,200,{received:true});
 }
 if(req.method==='GET'&&p==='/api/account'){
  const s=session(req);if(!s)return send(res,200,{user:null,paymentsReady:!!cfg.STRIPE_SECRET_KEY});const slots=await locked(s.user_id,()=>sync(s));return send(res,200,{user:{id:s.user_id,name:s.username},csrf:s.csrf,slots,paymentsReady:!!(cfg.STRIPE_SECRET_KEY&&cfg.STRIPE_WEBHOOK_SECRET),deploymentReady:false});
 }
 if(req.method==='POST'&&p==='/api/logout'){const s=requireSession(req);csrf(req,s);run('DELETE FROM sessions WHERE id=?',s.id);return send(res,200,{ok:true},{'Set-Cookie':'__Host-offset_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'});}
 if(req.method==='POST'&&p==='/api/checkout'){
  const s=requireSession(req);csrf(req,s);limit(req,s);if(cfg.COMMERCE_ENABLED!=='true')return send(res,503,{error:'Checkout is not open while hosting is being connected.'});need('STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_MONTHLY_PRICE_ID','STRIPE_YEARLY_PRICE_ID');const input=JSON.parse(await body(req));
  if(!['monthly','yearly'].includes(input.plan)||!Number.isInteger(input.quantity)||input.quantity<1||input.quantity>100)return send(res,400,{error:'Choose a plan and 1–100 slots.'});
  const price=input.plan==='monthly'?cfg.STRIPE_MONTHLY_PRICE_ID:cfg.STRIPE_YEARLY_PRICE_ID;
  return await locked(s.user_id,async()=>{let user=query('SELECT * FROM users WHERE id=?',s.user_id);if(!user.customer){const c=await stripe('customers',{'metadata[discord_id]':s.user_id},'customer-'+s.user_id);run('UPDATE users SET customer=? WHERE id=?',c.id,s.user_id);user.customer=c.id;}
  const result=await stripe('checkout/sessions',{mode:'subscription',customer:user.customer,'line_items[0][price]':price,'line_items[0][quantity]':String(input.quantity),client_reference_id:s.user_id,'subscription_data[metadata][discord_id]':s.user_id,success_url:publicURL+'/?checkout=success',cancel_url:publicURL+'/?checkout=cancelled'});return send(res,200,{url:result.url});});
 }
 if(req.method==='POST'&&p==='/api/billing'){
  const s=requireSession(req);csrf(req,s);limit(req,s);if(!s.customer)return send(res,400,{error:'No billing account yet.'});const portal=await stripe('billing_portal/sessions',{customer:s.customer,return_url:publicURL+'/'});return send(res,200,{url:portal.url});
 }
 return send(res,404,{error:'Not found'});
 }catch(e){const status=e.status||502;console.error('Request failed:',status);return send(res,status,{error:e.status?e.message:'Connection failed. Please try again.'});}}).listen(Number(cfg.PORT||3000),'0.0.0.0',()=>console.log('OffsetTech listening on configured port'));
