import { createPublicKey,verify } from 'node:crypto';
export function verifyDiscord(raw,signature,timestamp,key,now=Math.floor(Date.now()/1000)){
 if(!/^[a-f\d]{128}$/i.test(signature||'')||!/^\d+$/.test(timestamp||'')||!/^[a-f\d]{64}$/i.test(key||'')||Math.abs(now-Number(timestamp))>300)return false;
 try{const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(key,'hex')]),format:'der',type:'spki'});return verify(null,Buffer.concat([Buffer.from(timestamp),raw]),publicKey,Buffer.from(signature,'hex'));}catch{return false;}
}
export const commandDefinitions=[
 {name:'deploy',description:'Open your private bot deployment page'},
 {name:'status',description:'Show your bot status and hosting slots'},
 ...['start','stop','restart'].map(name=>({name,description:name[0].toUpperCase()+name.slice(1)+' one of your bots',options:[{name:'bot',description:'Bot name or dashboard bot ID',type:3,required:true,max_length:100}]})),
 {name:'edit',description:'Edit your bots on the private dashboard'},
 {name:'delete',description:'Open bot deletion controls on your dashboard'},
 {name:'billing',description:'Manage hosting slots and subscriptions'},
 {name:'staff',description:'Open the staff console (staff only)'}
].map(c=>({...c,type:1}));
export async function registerCommands(cfg,fetcher=fetch){
 if(!cfg.DISCORD_CLIENT_SECRET||!cfg.DISCORD_CLIENT_ID||!cfg.DISCORD_PUBLIC_KEY)throw Object.assign(Error('Set DISCORD_PUBLIC_KEY and Discord OAuth credentials in Coolify first.'),{status:503});
 const token=await fetcher('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(cfg.DISCORD_CLIENT_ID+':'+cfg.DISCORD_CLIENT_SECRET).toString('base64')},body:new URLSearchParams({grant_type:'client_credentials',scope:'applications.commands.update'}),signal:AbortSignal.timeout(15000)});
 if(!token.ok)throw Object.assign(Error('Discord command authorization failed. Check the client credentials.'),{status:502});const data=await token.json();
 // Upsert only this panel's command names; leave unrelated commands untouched.
 for(const command of commandDefinitions){const r=await fetcher('https://discord.com/api/v10/applications/'+cfg.DISCORD_CLIENT_ID+'/commands',{method:'POST',headers:{Authorization:'Bearer '+data.access_token,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Object.assign(Error('Discord could not register commands. Try again shortly.'),{status:502});}
 return {registered:commandDefinitions.map(c=>c.name)};
}
export async function interactionReply(cfg,interaction,content,fetcher=fetch){
 const r=await fetcher('https://discord.com/api/v10/webhooks/'+cfg.DISCORD_CLIENT_ID+'/'+interaction.token+'/messages/@original',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:String(content).slice(0,1900),allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Discord interaction reply failed');
}
