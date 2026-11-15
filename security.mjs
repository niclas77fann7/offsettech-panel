import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
export const random = () => randomBytes(32).toString('hex');
export const hash = s => createHash('sha256').update(s).digest('hex');
export function equal(a,b){ if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y); }
export function validStripeSignature(raw,header,secret,now=Math.floor(Date.now()/1000)){
 if(!header||!secret)return false;
 const parts=header.split(',').map(s=>s.split('='));const t=parts.find(([k])=>k==='t')?.[1];
 if(!/^\d+$/.test(t||'')||Math.abs(now-Number(t))>300)return false;
 const expected=createHmac('sha256',secret).update(t+'.').update(raw).digest('hex');
 return parts.some(([k,v])=>k==='v1'&&equal(v,expected));
}
export function slotsFromSubscriptions(subscriptions,monthly,yearly,now=Math.floor(Date.now()/1000)){
 let month=0,year=0;
 for(const s of subscriptions){
  // Grant only paid-through items, never incomplete, unpaid or canceled subscriptions.
  if(!['active','past_due'].includes(s.status))continue;
  const paid=s.latest_invoice?.status==='paid';
  if(!paid)continue;
  for(const i of s.items?.data||[]){
   const expiry=i.current_period_end||s.current_period_end;
   if(!Number.isFinite(expiry)||expiry<=now)continue;
   const qty=i.quantity;if(!Number.isSafeInteger(qty)||qty<1)continue;
   const p=typeof i.price==='string'?i.price:i.price?.id;
   if(p===monthly)month+=qty;else if(p===yearly)year+=qty;
  }
 }
 return {monthly:month,yearly:year,total:month+year};
}

export function stripeMode(cfg){
 const test=cfg.STRIPE_TEST_MODE==='true';
 const prefix=test?/^(sk|rk)_test_/:/^(sk|rk)_live_/;
 if(!prefix.test(cfg.STRIPE_SECRET_KEY||''))throw Object.assign(Error(test?'Test checkout requires a Stripe test secret key.':'Stripe key mode does not match the configured payment mode.'),{status:503});
 return test;
}
export function checkoutAllowed(cfg,user){
 if(cfg.STRIPE_TEST_MODE==='true')return !!cfg.HOSTING_TEST_DISCORD_ID&&user===cfg.HOSTING_TEST_DISCORD_ID;
 return cfg.COMMERCE_ENABLED==='true';
}

