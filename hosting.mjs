import { randomUUID } from 'node:crypto';
const fail=(status,message)=>Object.assign(new Error(message),{status});
export const deploymentKeys=['COOLIFY_API_URL','COOLIFY_API_TOKEN','COOLIFY_PROJECT_UUID','COOLIFY_SERVER_UUID','MODMAIL_IMAGE'];
export function missingHosting(cfg){return deploymentKeys.filter(k=>!cfg[k]);}
export const hostedBootstrap = `import os
from discord.ext import commands
import bot
original_init = bot.ModmailBot.__init__
def hosted_init(self, *args, **kwargs):
    original_init(self, *args, **kwargs)
    self.loaded_cogs = [name for name in self.loaded_cogs if name != "cogs.plugins"]
    async def hosting_check(ctx):
        command = ctx.command
        while command and command.parent:
            command = command.parent
        if command and command.name in {"eval", "debug", "update", "plugins", "plugin", "config", "oauth", "load", "reload", "unload"}:
            raise commands.CheckFailure("This command is unavailable on managed hosting.")
        return True
    self.add_check(hosting_check)
    self.add_check(hosting_check, call_once=True)
bot.ModmailBot.__init__ = hosted_init
bot.main()
`;
export function template(guild,owner,image,logURL){
 if(!/^\d{15,22}$/.test(guild)||!/^\d{15,22}$/.test(owner))throw fail(400,'Enter a valid Discord server ID.');
 if(!/^[a-z0-9][a-z0-9._/:@-]+$/i.test(image)||!image.includes('@sha256:'))throw fail(503,'The approved Modmail image must be pinned by digest.');
 // JSON is valid YAML. Credentials are referenced, never embedded in Compose.
 return JSON.stringify({services:{bot:{image,command:['python','-c',hostedBootstrap],restart:'unless-stopped',environment:{TOKEN:'${BOT_TOKEN}',GUILD_ID:guild,OWNERS:owner,CONNECTION_URI:'mongodb://offset:${MONGO_PASSWORD}@mongo:27017/modmail?authSource=admin',LOG_URL:logURL,DISABLE_AUTOUPDATES:'true',ENABLE_EVAL:'false'},depends_on:{mongo:{condition:'service_healthy'}},mem_limit:'384m',cpus:.5,pids_limit:128,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],networks:['private','outbound']},mongo:{image:'mongo:7',user:'999:999',restart:'unless-stopped',environment:{MONGO_INITDB_ROOT_USERNAME:'offset',MONGO_INITDB_ROOT_PASSWORD:'${MONGO_PASSWORD}'},volumes:['database:/data/db'],healthcheck:{test:['CMD','mongosh','--quiet','--eval','db.adminCommand("ping").ok'],interval:'10s',timeout:'5s',retries:12},mem_limit:'384m',cpus:.5,pids_limit:128,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],networks:['private']}},volumes:{database:{}},networks:{private:{internal:true},outbound:{}}});
}
export function createHosting({cfg,db,random,now,fetcher=fetch}){
 db.exec(`CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,guild_id TEXT NOT NULL,discord_bot_id TEXT UNIQUE,service_uuid TEXT UNIQUE,state TEXT NOT NULL,created INTEGER NOT NULL);`);
 const q=(sql,...a)=>db.prepare(sql).get(...a),run=(sql,...a)=>db.prepare(sql).run(...a);
 function configured(){if(missingHosting(cfg).length)throw fail(503,'Hosting connection setup is incomplete.');}
 async function api(path,method='GET',data){
  if(!cfg.COOLIFY_API_URL||!cfg.COOLIFY_API_TOKEN)throw fail(503,'Coolify API address or token is missing.');
  const base=new URL(cfg.COOLIFY_API_URL);if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw fail(503,'Invalid Coolify API address.');
  // Address is administrator-configured only; customer input never chooses API targets.
  const r=await fetcher(base.toString().replace(/\/$/,'')+'/api/v1/'+path,{method,headers:{Authorization:'Bearer '+cfg.COOLIFY_API_TOKEN,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw fail(502,`Coolify request failed (${r.status}). Check token permissions and resource access.`);
  if(r.status===204)return {};const raw=await r.text();try{return JSON.parse(raw)}catch{return {}};
 }
 function publicBot(b){return{id:b.id,name:b.name,guildId:b.guild_id,status:b.state,created:b.created};}
 function list(user){return db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY created,id').all(user).map(publicBot);}
 function owned(user,id){const b=q('SELECT * FROM bots WHERE id=? AND user_id=?',id,user);if(!b)throw fail(404,'Bot not found.');return b;}
 async function check(){const version=await api('version');return{connected:true,missing:missingHosting(cfg),version:typeof version==='string'?version:undefined};}
 function ready(){return !missingHosting(cfg).length&&cfg.HOSTING_ENABLED==='true';}
 async function create(user,input,slots){
  configured();if(!ready())throw fail(503,'Bot deployment is not enabled yet.');
  if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>40||typeof input.token!=='string'||input.token.length<30||input.token.length>250||/[\r\n\s]/.test(input.token))throw fail(400,'Enter a bot name, valid bot token and Discord server ID.');
  const compose=template(input.guildId,user,cfg.MODMAIL_IMAGE,cfg.PUBLIC_URL.replace(/\/$/,'')+'/hosting-logs-unavailable');
  if(q('SELECT count(*) AS n FROM bots WHERE user_id=?',user).n>=slots)throw fail(409,'No unused slot is available.');
  const capacity=Number(cfg.MAX_BOT_INSTANCES||5);if(!Number.isSafeInteger(capacity)||capacity<1)throw fail(503,'Hosting capacity is not configured.');
  if(q('SELECT count(*) AS n FROM bots').n>=capacity)throw fail(409,'Hosting capacity is full. Please contact support.');
  const id=randomUUID();run('INSERT INTO bots VALUES(?,?,?,?,?,?,?,?)',id,user,input.name.trim(),input.guildId,null,null,'validating',now());
  let externalAttempted=false;
  try{
   // Validate bot credentials and confirm the logged-in user owns its Discord application.
   const auth={Authorization:'Bot '+input.token};
   const a=await fetcher('https://discord.com/api/v10/oauth2/applications/@me',{headers:auth,signal:AbortSignal.timeout(15000)});
   if(!a.ok)throw fail(400,'Discord rejected the bot token.');const app=await a.json();
   if((app.team?.owner_user_id||app.owner?.id)!==user)throw fail(403,'You must own the Discord bot application to deploy it.');
   if(!/^\d{15,22}$/.test(app.id||''))throw fail(400,'Invalid Discord bot identity.');
   if(q('SELECT id FROM bots WHERE discord_bot_id=?',app.id))throw fail(409,'That Discord bot is already deployed.');
   run('UPDATE bots SET discord_bot_id=?,state=? WHERE id=?',app.id,'creating',id);
   const args={project_uuid:cfg.COOLIFY_PROJECT_UUID,server_uuid:cfg.COOLIFY_SERVER_UUID,environment_name:cfg.COOLIFY_ENVIRONMENT_NAME||'production',name:'offsettech-'+id,docker_compose_raw:Buffer.from(compose).toString('base64'),instant_deploy:false,connect_to_docker_network:false,redact_all_env_values_in_logs:true};
   if(cfg.COOLIFY_DESTINATION_UUID)args.destination_uuid=cfg.COOLIFY_DESTINATION_UUID;
   externalAttempted=true;const created=await api('services','POST',args);if(!created.uuid)throw fail(502,'Coolify returned no service ID; contact support before retrying.');
   run('UPDATE bots SET service_uuid=?,state=? WHERE id=?',created.uuid,'configuring',id);
   for(const [key,value]of Object.entries({BOT_TOKEN:input.token,MONGO_PASSWORD:random()}))await api('services/'+encodeURIComponent(created.uuid)+'/envs','POST',{key,value,is_literal:true,is_multiline:false,is_shown_once:true});
   await api('services/'+encodeURIComponent(created.uuid)+'/start','POST');run('UPDATE bots SET state=? WHERE id=?','starting',id);return publicBot(owned(user,id));
  }catch(e){
   if(!externalAttempted)run('DELETE FROM bots WHERE id=?',id);else run('UPDATE bots SET state=? WHERE id=?','needs_attention',id);
   // A timeout after creating a service is ambiguous. Keep its slot reserved to prevent duplicates.
   throw e;
  }
 }
 async function control(user,id,action,slots){
  const b=owned(user,id);if(!['start','stop','restart'].includes(action))throw fail(400,'Unknown bot action.');if(!b.service_uuid)throw fail(409,'This deployment needs operator attention.');
  if(action!=='stop'){
   if(!ready())throw fail(503,'Bot deployment is not enabled yet.');
   const allowed=db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY created,id LIMIT ?').all(user,slots).some(x=>x.id===id);
   if(!allowed)throw fail(403,'This bot has no active hosting slot.');
   if(['needs_attention','configuring'].includes(b.state))throw fail(409,'Contact support to complete this deployment before starting it.');
  }
  await api('services/'+encodeURIComponent(b.service_uuid)+'/'+action,'POST');run('UPDATE bots SET state=? WHERE id=?',action==='stop'?'stopped':action==='start'?'starting':'restarting',id);return publicBot(owned(user,id));
 }
 async function enforce(user,slots){const bots=db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY created,id').all(user);for(const b of bots.slice(slots)){if(b.service_uuid&&!['suspended','stopped'].includes(b.state)){await api('services/'+encodeURIComponent(b.service_uuid)+'/stop','POST');run('UPDATE bots SET state=? WHERE id=?','suspended',b.id);}}}
 return{ready,list,check,create,control,enforce};
}
