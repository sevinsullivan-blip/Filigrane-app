// FILIGRANE V8 — cache mis à jour pour forcer le rechargement de la nouvelle version.
const CACHE='filigrane-v8-20261124-1';
const APP_FILES=['./','./index.html'];
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(APP_FILES.map(path=>new Request(path,{cache:'reload'})));
  await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(key=>key!==CACHE&&(key.startsWith('filigrane')||key.startsWith('filigrane-github'))).map(key=>caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==location.origin)return;
  event.respondWith((async()=>{
    try{
      const response=await fetch(request,{cache:'no-store'});
      if(response.ok){const cache=await caches.open(CACHE);cache.put(request,response.clone()).catch(()=>{});}
      return response;
    }catch(_){
      const cached=await caches.match(request);
      if(cached)return cached;
      if(request.mode==='navigate')return(await caches.match('./index.html'))||Response.error();
      return Response.error();
    }
  })());
});
