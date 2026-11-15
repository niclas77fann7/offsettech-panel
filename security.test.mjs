import {test} from 'node:test';import assert from 'node:assert/strict';import{createHmac}from'node:crypto';import{validStripeSignature,slotsFromSubscriptions,equal}from'./security.mjs';
test('webhook signature binds exact raw body and timestamp',()=>{const body=Buffer.from('{"id":"evt_1"}'),t=2000,secret='test';const sig=createHmac('sha256',secret).update(t+'.').update(body).digest('hex');assert.equal(validStripeSignature(body,`t=${t},v1=${sig}`,secret,t),true);assert.equal(validStripeSignature(Buffer.from('{}'),`t=${t},v1=${sig}`,secret,t),false);assert.equal(validStripeSignature(body,`t=${t},v1=${sig}`,secret,t+301),false);assert.equal(validStripeSignature(body,`t=${t},v1=bad`,secret,t),false);});
test('only recognized, paid, unexpired subscription items grant slots',()=>{const make=(status,paid,expiry,price,quantity)=>({status,latest_invoice:{status:paid?'paid':'open'},items:{data:[{price:{id:price},quantity,current_period_end:expiry}]}});const s=[make('active',true,3000,'month',2),make('active',true,3000,'year',3),make('active',false,3000,'month',9),make('canceled',true,3000,'month',10),make('active',true,1000,'month',11),make('active',true,3000,'other',20),make('incomplete',true,3000,'year',50)];assert.deepEqual(slotsFromSubscriptions(s,'month','year',2000),{monthly:2,yearly:3,total:5});});
test('cancel-at-period-end retains paid slots until expiry',()=>{const s={status:'active',cancel_at_period_end:true,latest_invoice:{status:'paid'},items:{data:[{price:{id:'month'},quantity:1,current_period_end:3000}]}};assert.equal(slotsFromSubscriptions([s],'month','year',2000).total,1);assert.equal(slotsFromSubscriptions([s],'month','year',3000).total,0);});
test('safe comparisons reject absent or unequal state',()=>{assert.equal(equal(undefined,'abc'),false);assert.equal(equal('abc','abcd'),false);assert.equal(equal('abc','abc'),true);});


test('sandbox payment mode rejects live credentials and restricts checkout to operator',async()=>{
 const{stripeMode,checkoutAllowed}=await import('./security.mjs');
 const testCfg={STRIPE_TEST_MODE:'true',HOSTING_TEST_DISCORD_ID:'operator',STRIPE_SECRET_KEY:'sk_test_example',COMMERCE_ENABLED:'false'};
 assert.equal(stripeMode(testCfg),true);assert.equal(checkoutAllowed(testCfg,'operator'),true);assert.equal(checkoutAllowed(testCfg,'customer'),false);
 assert.throws(()=>stripeMode({...testCfg,STRIPE_SECRET_KEY:'sk_live_example'}),/test secret key/);
 assert.equal(checkoutAllowed({...testCfg,COMMERCE_ENABLED:'true'},'customer'),false);
});
test('live mode cannot reuse sandbox keys or bypass closed checkout',async()=>{
 const{stripeMode,checkoutAllowed}=await import('./security.mjs');
 assert.throws(()=>stripeMode({STRIPE_SECRET_KEY:'sk_test_example'}),/mode/);
 assert.equal(checkoutAllowed({COMMERCE_ENABLED:'false'},'operator'),false);
 assert.equal(stripeMode({STRIPE_SECRET_KEY:'sk_live_example'}),false);
});
