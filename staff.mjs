import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback);
export const permissions={
 'bots.view':'View all bots', 'bots.manage':'Edit and control any bot', 'bots.revoke':'Revoke or restore hosting',
 'bots.delete':'Delete bot instances', 'staff.manage':'Add and edit staff', 'staff.delegate':'Delegate staff-management access',
 'audit.view':'View the audit log', 'system.manage':'Configure Discord commands'
};
export const roles={support:['bots.view','audit.view'],operator:['bots.view','bots.manage','bots.revoke','audit.view'],admin:['bots.view','bots.manage','bots.revoke','bots.delete','audit.view','system.manage']};
const fail=(status,message)=>Object.assign(new Error(message),{status});
export async function checkOwnerPassword(cfg,username,password){
 if(typeof username!=='string'||typeof password!=='string'||password.length>256)return false;
 if(!cfg.STAFF_OWNER_PASSWORD)return false;
 const expectedUser=cfg.STAFF_OWNER_USERNAME||'myriad6969';
 const [expected,actual]=await Promise.all([scrypt(cfg.STAFF_OWNER_PASSWORD,'offsettech-owner-login-v1',64),scrypt(password,'offsettech-owner-login-v1',64)]);
 return username===expectedUser&&timingSafeEqual(expected,actual);
}
export function createStaff({cfg,db,now}){
 const ownerId=cfg.OWNER_DISCORD_ID||cfg.HOSTING_TEST_DISCORD_ID||'818142433845706753';
 db.exec(`CREATE TABLE IF NOT EXISTS staff_members(user_id TEXT PRIMARY KEY,role TEXT NOT NULL,permissions TEXT NOT NULL,created_by TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);`);
 const get=(sql,...a)=>db.prepare(sql).get(...a),run=(sql,...a)=>db.prepare(sql).run(...a);
 function identity(id){if(id===ownerId)return {id,role:'owner',owner:true,permissions:Object.keys(permissions)};const member=get('SELECT * FROM staff_members WHERE user_id=?',id);return{id,owner:false,role:member?.role||'customer',permissions:member?JSON.parse(member.permissions):[]};}
 function requirePermission(id,key){const actor=identity(id);if(!actor.permissions.includes(key))throw fail(403,'You do not have permission for this action.');return actor;}
 function audit(actor,action,target,detail=''){run('INSERT INTO audit_log(actor,action,target,detail,created) VALUES(?,?,?,?,?)',actor,action,target,String(detail).slice(0,300),now());}
 function list(id){requirePermission(id,'staff.manage');return[{userId:ownerId,role:'owner',permissions:Object.keys(permissions),owner:true},...db.prepare('SELECT * FROM staff_members ORDER BY created,user_id').all().map(r=>({userId:r.user_id,role:r.role,permissions:JSON.parse(r.permissions),owner:false}))];}
 function save(actorId,input){const actor=requirePermission(actorId,'staff.manage');
  if(!input||typeof input.userId!=='string'||!/^\d{15,22}$/.test(input.userId)||!['support','operator','admin','custom'].includes(input.role))throw fail(400,'Choose a staff role and enter a valid Discord user ID.');
  if(input.userId===ownerId)throw fail(403,'The owner cannot be edited or replaced.');
  if(input.userId===actorId)throw fail(403,'Staff cannot edit their own access.');
  const selected=input.permissions===undefined?(roles[input.role]||[]):input.permissions;
  if(!Array.isArray(selected)||selected.some(p=>!Object.hasOwn(permissions,p))||new Set(selected).size!==selected.length)throw fail(400,'Invalid permissions.');
  const previous=get('SELECT * FROM staff_members WHERE user_id=?',input.userId);
  if(!actor.owner){
   if(selected.some(p=>!actor.permissions.includes(p)))throw fail(403,'You cannot grant permissions you do not hold.');
   if(previous&&JSON.parse(previous.permissions).some(p=>!actor.permissions.includes(p)))throw fail(403,'You cannot edit a staff member with broader access.');
   if(selected.includes('staff.manage')&&!actor.permissions.includes('staff.delegate'))throw fail(403,'Only staff with delegation permission may grant staff management.');
  }
  run('INSERT INTO staff_members VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,permissions=excluded.permissions',input.userId,input.role,JSON.stringify(selected),actorId,now());audit(actorId,previous?'staff.updated':'staff.added',input.userId,selected.join(', '));return identity(input.userId);
 }
 function remove(actorId,target){const actor=requirePermission(actorId,'staff.manage');if(target===ownerId||target===actorId)throw fail(403,'You cannot remove this account.');const member=get('SELECT * FROM staff_members WHERE user_id=?',target);if(!member)throw fail(404,'Staff member not found.');if(!actor.owner&&JSON.parse(member.permissions).some(p=>!actor.permissions.includes(p)))throw fail(403,'You cannot remove a staff member with broader access.');run('DELETE FROM staff_members WHERE user_id=?',target);audit(actorId,'staff.removed',target);}
 function logs(id){requirePermission(id,'audit.view');return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();}
 return{ownerId,identity,requirePermission,audit,list,save,remove,logs,permissionCatalog:permissions,roles};
}
