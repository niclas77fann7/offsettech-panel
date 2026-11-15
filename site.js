fetch('/api/session').then(r=>r.json()).then(data=>{if(data.user){const link=document.getElementById('site-login');if(link){link.textContent='Dashboard';link.href='/dashboard';}}}).catch(()=>{});
