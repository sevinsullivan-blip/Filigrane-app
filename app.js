'use strict';

// Les calculs sont effectués dans un Web Worker pour ne jamais bloquer l'iPhone.
// Aucune photo n'est envoyée à un serveur.
function stringArtWorker() {
  self.onmessage = (event) => {
    if (event.data.type !== 'generate') return;
    try {
      const {pixels, size, nails, moves} = event.data;
      const residual = new Float32Array(pixels);
      const angleStep = Math.PI * 2 / nails;
      const radius = size * 0.473;
      const center = (size - 1) / 2;
      const x = new Int16Array(nails), y = new Int16Array(nails);
      for (let i = 0; i < nails; i++) {
        const a = -Math.PI / 2 + i * angleStep;
        x[i] = Math.round(center + Math.cos(a) * radius);
        y[i] = Math.round(center + Math.sin(a) * radius);
      }
      const path = new Uint16Array(moves + 1);
      const visited = new Uint8Array(nails * nails);
      const ink = 0.145; // opacité d'un passage simulé dans l'analyse
      const minGap = Math.max(5, Math.round(nails * 0.045));
      let current = 0;
      path[0] = current;
      let countDone = 0;

      for (let k = 0; k < moves; k++) {
        let best = -1;
        let bestScore = -Infinity;
        for (let next = 0; next < nails; next++) {
          const gap = Math.abs(next - current);
          if (gap < minGap || nails - gap < minGap || visited[current * nails + next]) continue;

          let x0 = x[current], y0 = y[current];
          const x1 = x[next], y1 = y[next];
          const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
          const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
          let err = dx + dy;
          let sum = 0, len = 0;
          while (true) {
            sum += residual[y0 * size + x0];
            len++;
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
          }
          // Gain approché en erreur quadratique, tempéré pour ne pas privilégier
          // exclusivement les longs diamètres du cercle.
          const score = (sum - ink * len * 0.5) / Math.pow(len, 0.22);
          if (score > bestScore) { bestScore = score; best = next; }
        }

        // Le nombre de segments est limité par les contraintes, ce cas reste exceptionnel.
        if (best < 0) break;
        visited[current * nails + best] = 1;
        visited[best * nails + current] = 1;

        let x0 = x[current], y0 = y[current];
        const x1 = x[best], y1 = y[best];
        const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
        const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        while (true) {
          const idx = y0 * size + x0;
          residual[idx] -= ink;
          // Léger étalement de l'encre pour un résultat visuellement moins granuleux.
          if (x0 > 0) residual[idx - 1] -= ink * 0.08;
          if (x0 < size - 1) residual[idx + 1] -= ink * 0.08;
          if (y0 > 0) residual[idx - size] -= ink * 0.08;
          if (y0 < size - 1) residual[idx + size] -= ink * 0.08;
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
        current = best;
        path[k + 1] = best;
        countDone = k + 1;
        if (countDone % 100 === 0 || countDone === moves) {
          self.postMessage({type: 'progress', done: countDone, total: moves,
            partialPath: Array.from(path.subarray(0, countDone + 1))});
        }
      }
      const finalPath = path.slice(0, countDone + 1);
      self.postMessage({type: 'done', path: finalPath.buffer, nails}, [finalPath.buffer]);
    } catch (err) {
      self.postMessage({type: 'error', error: err && err.message || 'Erreur inconnue'});
    }
  };
}

const $ = (id) => document.getElementById(id);
const state = {image: null, zoom: 1, panX: 0, panY: 0,
  path: null, partialPath: null, nails: 200, worker: null, running: false};
const CIRCLE_SIZE = 256;
const displayCanvas = $('artCanvas');
const displayCtx = displayCanvas.getContext('2d');
const cropCanvas = $('photoCanvas');
const cropCtx = cropCanvas.getContext('2d');

function circlePoints(nails, size) {
  const r = size * 0.466;
  const c = size / 2;
  return Array.from({length:nails}, (_,i) => {
    const a = -Math.PI / 2 + (Math.PI * 2 * i / nails);
    return [c + r*Math.cos(a), c + r*Math.sin(a)];
  });
}
function withSeparators(n){return Math.round(n).toLocaleString('fr-FR');}
function currentSettings() {
  return {nails: Number($('nailsRange').value), moves: Number($('linesRange').value),
    contrast: Number($('contrastRange').value), diameter: Number($('diameterInput').value) || 50};
}
function clampPan(){
  if (!state.image) return;
  const img = state.image;
  const scale = Math.max(1 / img.width, 1 / img.height) * state.zoom;
  state.panX = Math.max(-(img.width*scale - 1)/2, Math.min((img.width*scale - 1)/2, state.panX));
  state.panY = Math.max(-(img.height*scale - 1)/2, Math.min((img.height*scale - 1)/2, state.panY));
}
function paintPhoto(ctx, size) {
  ctx.clearRect(0,0,size,size);
  ctx.fillStyle = '#fffdf7'; ctx.fillRect(0,0,size,size);
  if (!state.image) return;
  const img = state.image;
  const scale = Math.max(size / img.width, size / img.height) * state.zoom;
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img,(size-dw)/2 + state.panX*size,(size-dh)/2 + state.panY*size,dw,dh);
}
function drawPhotoPreview(){
  if (!state.image) return;
  const s = cropCanvas.width, c = s/2;
  cropCtx.save(); cropCtx.clearRect(0,0,s,s);
  cropCtx.beginPath();cropCtx.arc(c,c,s*0.486,0,Math.PI*2);cropCtx.clip();
  paintPhoto(cropCtx,s);
  cropCtx.restore();
  cropCtx.strokeStyle='#b45f47';cropCtx.lineWidth=3;
  cropCtx.beginPath();cropCtx.arc(c,c,s*0.484,0,Math.PI*2);cropCtx.stroke();
}
function createTarget(){
  const c = document.createElement('canvas');c.width=c.height=CIRCLE_SIZE;
  const ctx = c.getContext('2d', {willReadFrequently:true});
  paintPhoto(ctx,CIRCLE_SIZE);
  const rgba=ctx.getImageData(0,0,CIRCLE_SIZE,CIRCLE_SIZE).data;
  const target=new Float32Array(CIRCLE_SIZE*CIRCLE_SIZE);
  const contrast=currentSettings().contrast/100;
  for(let y=0;y<CIRCLE_SIZE;y++){
    for(let x=0;x<CIRCLE_SIZE;x++){
      const p=y*CIRCLE_SIZE+x, i=p*4;
      const radius=Math.hypot(x-CIRCLE_SIZE/2,y-CIRCLE_SIZE/2);
      if(radius>CIRCLE_SIZE*0.473){target[p]=0;continue;}
      const lum=(rgba[i]*.2126+rgba[i+1]*.7152+rgba[i+2]*.0722)/255;
      const raw=Math.max(0,1-lum-0.038);
      target[p]=Math.max(0,Math.min(1,raw*1.44*contrast));
    }
  }
  return target;
}
function drawArt(path, count, canvas, options={}) {
  const s=canvas.width, ctx=canvas.getContext('2d');
  const n=options.nails || currentSettings().nails;
  const points=circlePoints(n,s);
  const c=s/2, radius=s*0.466;
  ctx.clearRect(0,0,s,s);
  ctx.fillStyle='#fdfbf5';ctx.fillRect(0,0,s,s);
  ctx.save();ctx.beginPath();ctx.arc(c,c,radius,0,Math.PI*2);ctx.clip();
  ctx.fillStyle='#fffefd';ctx.fillRect(0,0,s,s);
  if(path && count>0){
    ctx.strokeStyle='#0e0e0c';ctx.lineWidth=s/900*1.45;ctx.globalAlpha=0.158;
    ctx.lineCap='round';
    const max=Math.min(count,path.length-1);
    for(let k=0;k<max;k++){
      const p1=points[path[k]],p2=points[path[k+1]];
      if(!p1||!p2)continue;
      ctx.beginPath();ctx.moveTo(p1[0],p1[1]);ctx.lineTo(p2[0],p2[1]);ctx.stroke();
    }
    ctx.globalAlpha=1;
    if(options.highlight && max>0 && max<path.length-1){
      const p1=points[path[max-1]],p2=points[path[max]];
      ctx.strokeStyle='#bd5437';ctx.globalAlpha=.9;ctx.lineWidth=s/900*3.1;
      ctx.beginPath();ctx.moveTo(p1[0],p1[1]);ctx.lineTo(p2[0],p2[1]);ctx.stroke();
      ctx.globalAlpha=1;
    }
  }
  ctx.restore();
  ctx.strokeStyle='#c4a894';ctx.lineWidth=s/900*2.4;
  ctx.beginPath();ctx.arc(c,c,radius,0,Math.PI*2);ctx.stroke();
  // Un point représente un clou. Tous les clous sont numérotés dans le guide CSV.
  for(let k=0;k<n;k++){
    const p=points[k];
    ctx.beginPath();ctx.fillStyle='#6c6152';ctx.arc(p[0],p[1],s/900*2.35,0,Math.PI*2);ctx.fill();
  }
  // Le clou 0 est identifié pour faciliter le démarrage sur le cadre réel.
  const p0=points[0];
  ctx.fillStyle='#bd654a';ctx.beginPath();ctx.arc(p0[0],p0[1],s/900*5,0,Math.PI*2);ctx.fill();
  if(options.highlight && path && count>0 && count<path.length-1){
    const p=points[path[count]];
    ctx.fillStyle='#bd5437';ctx.beginPath();ctx.arc(p[0],p[1],s/900*6.2,0,Math.PI*2);ctx.fill();
  }
}
function resetCanvas(){drawArt(null,0,displayCanvas);}
function invalidate(){
  if(state.running)stopWorker();
  state.path=null;state.partialPath=null;
  $('results').classList.add('hidden');$('emptyOverlay').classList.remove('hidden');
  $('previewBadge').textContent='EN ATTENTE';$('previewBadge').className='preview-badge';
  resetCanvas();
  $('generateButton').disabled=!state.image;
  $('generateText').textContent=state.image?'Créer mon tableau':'Choisir une photo pour commencer';
}
function imageReady(image){
  state.image=image;state.zoom=1;state.panX=0;state.panY=0;
  $('zoomRange').value=100;$('zoomValue').textContent='100 %';
  $('cropArea').classList.remove('hidden');
  $('uploadTitle').textContent='Changer de photographie';
  $('uploadHint').textContent='Appareil photo ou photothèque';
  drawPhotoPreview();invalidate();
}
async function loadPhoto(file){
  if(!file)return;
  if(file.size>70*1024*1024){showError('Image trop volumineuse (maximum 70 Mo).');return;}
  clearError();const url=URL.createObjectURL(file);
  const img=new Image();
  try {
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Format d’image non pris en charge. Essayez une photo JPEG ou PNG.'));img.src=url;});
    if(!img.naturalWidth)throw new Error('Image illisible');
    imageReady(img);
  } catch(e){showError(e.message);}finally{URL.revokeObjectURL(url);}
}
function demoPortrait(){
  const c=document.createElement('canvas');c.width=c.height=720;
  const g=c.getContext('2d');
  g.fillStyle='#fafaf9';g.fillRect(0,0,720,720);
  // Illustration neutre à fort contraste, uniquement utilisée comme exemple.
  g.fillStyle='#353535';g.beginPath();g.ellipse(360,800,248,260,0,0,Math.PI*2);g.fill();
  g.fillStyle='#d1d1d1';g.beginPath();g.ellipse(360,563,78,100,0,0,Math.PI*2);g.fill();
  g.fillStyle='#292929';g.beginPath();g.ellipse(360,310,190,235,0,0,Math.PI*2);g.fill();
  g.fillStyle='#e5e5e5';g.beginPath();g.ellipse(360,340,141,177,0,0,Math.PI*2);g.fill();
  // Coiffure, oreilles, visage, sourcils et traits marqués.
  g.fillStyle='#292929';g.beginPath();g.moveTo(219,286);g.bezierCurveTo(226,110,390,97,481,205);g.bezierCurveTo(500,260,497,298,483,327);g.bezierCurveTo(445,247,422,231,379,205);g.bezierCurveTo(327,258,277,272,219,286);g.fill();
  g.fillStyle='#dadada';g.beginPath();g.ellipse(214,352,22,40,0,0,Math.PI*2);g.ellipse(506,352,22,40,0,0,Math.PI*2);g.fill();
  g.strokeStyle='#444';g.lineWidth=11;g.lineCap='round';
  g.beginPath();g.moveTo(268,313);g.quadraticCurveTo(302,297,333,312);g.moveTo(392,312);g.quadraticCurveTo(423,299,452,316);g.stroke();
  g.strokeStyle='#575757';g.lineWidth=6;g.beginPath();g.moveTo(276,353);g.quadraticCurveTo(304,368,333,353);g.moveTo(388,353);g.quadraticCurveTo(417,368,447,353);g.stroke();
  g.fillStyle='#262626';g.beginPath();g.ellipse(304,353,8,10,0,0,Math.PI*2);g.ellipse(417,353,8,10,0,0,Math.PI*2);g.fill();
  g.strokeStyle='#999';g.lineWidth=7;g.beginPath();g.moveTo(363,342);g.quadraticCurveTo(344,419,363,425);g.quadraticCurveTo(380,432,389,420);g.stroke();
  g.strokeStyle='#5a5a5a';g.lineWidth=6;g.beginPath();g.moveTo(323,471);g.quadraticCurveTo(360,486,398,471);g.moveTo(338,493);g.quadraticCurveTo(364,503,387,491);g.stroke();
  g.strokeStyle='#888';g.lineWidth=7;g.beginPath();g.moveTo(262,410);g.quadraticCurveTo(274,475,304,505);g.moveTo(459,415);g.quadraticCurveTo(453,476,420,506);g.stroke();
  imageReady(c);
}
function clearError(){$('errorMessage').textContent='';$('errorMessage').classList.add('hidden');}
function showError(msg){$('errorMessage').textContent=msg;$('errorMessage').classList.remove('hidden');}
function stopWorker(){
  if(state.worker){state.worker.terminate();state.worker=null;}
  state.running=false;
  $('cancelButton').classList.add('hidden');$('progressArea').classList.add('hidden');
  $('generateButton').disabled=!state.image;
  $('generateText').textContent='Créer mon tableau';
  $('previewBadge').textContent='EN ATTENTE';$('previewBadge').className='preview-badge';
}
function startGeneration(){
  if(!state.image||state.running)return;
  clearError();
  const s=currentSettings();
  if(!Number.isFinite(s.diameter)||s.diameter<10||s.diameter>200){showError('Le diamètre doit être compris entre 10 et 200 cm.');return;}
  invalidate();
  state.running=true;state.nails=s.nails;
  $('generateButton').disabled=true;$('generateText').textContent='Calcul en cours…';
  $('cancelButton').classList.remove('hidden');$('progressArea').classList.remove('hidden');
  $('progressFill').style.width='0%';$('progressPercent').textContent='0 %';
  $('previewBadge').textContent='CRÉATION…';$('previewBadge').className='preview-badge working';
  $('emptyOverlay').classList.add('hidden');
  drawArt(null,0,displayCanvas,{nails:s.nails});
  try{
    const workerCode=`(${stringArtWorker.toString()})();`;
    const blob=new Blob([workerCode],{type:'text/javascript'});
    const url=URL.createObjectURL(blob);
    const worker=new Worker(url);
    URL.revokeObjectURL(url);
    state.worker=worker;
    worker.onmessage=(event)=>{
      if(state.worker!==worker)return;
      const data=event.data;
      if(data.type==='progress'){
        const pct=Math.round(data.done/data.total*100);
        $('progressFill').style.width=pct+'%';$('progressPercent').textContent=pct+' %';
        $('progressText').textContent=withSeparators(data.done)+' passages calculés';
        state.partialPath=data.partialPath;
        // Mise à jour progressive du dessin pendant le calcul.
        drawArt(data.partialPath,data.done,displayCanvas,{nails:s.nails});
      } else if(data.type==='done'){
        const completed=new Uint16Array(data.path);
        state.path=completed;
        state.nails=s.nails;
        stopWorker();
        $('progressFill').style.width='100%';
        $('previewBadge').textContent='PRÊT À FABRIQUER';$('previewBadge').className='preview-badge ready';
        $('results').classList.remove('hidden');$('emptyOverlay').classList.add('hidden');
        $('stepRange').max=String(completed.length-1);
        $('stepRange').value=String(completed.length-1);
        updateResults();
        if(window.innerWidth<680)$('artCanvas').scrollIntoView({behavior:'smooth',block:'center'});
      } else if(data.type==='error'){
        stopWorker();showError('Calcul impossible : '+data.error);
        $('emptyOverlay').classList.remove('hidden');
      }
    };
    worker.onerror=(error)=>{
      if(state.worker===worker){stopWorker();showError('Le calcul a échoué. Réessayez avec moins de passages.');$('emptyOverlay').classList.remove('hidden');}
    };
    const target=createTarget();
    worker.postMessage({type:'generate',pixels:target.buffer,size:CIRCLE_SIZE,nails:s.nails,moves:s.moves},[target.buffer]);
  } catch(e){stopWorker();$('emptyOverlay').classList.remove('hidden');showError('Web Worker indisponible : '+e.message);}
}
function estimateLengthCm(path,nails,diameter){
  if(!path)return 0;
  const a=Math.PI*2/nails;let total=0;
  for(let i=1;i<path.length;i++){
    const d=Math.abs(path[i]-path[i-1]);
    const shorter=Math.min(d,nails-d);
    total+=diameter*Math.sin(shorter*a/2);
  }
  return total;
}
function updateResults(){
  if(!state.path)return;
  const path=state.path, n=state.nails, length=path.length-1;
  const count=Math.max(0,Math.min(length,Number($('stepRange').value)));
  $('statNails').textContent=withSeparators(n);
  $('statLines').textContent=withSeparators(length);
  const straight=estimateLengthCm(path,n,currentSettings().diameter);
  $('statLength').textContent=((straight+length*2)/100).toLocaleString('fr-FR',{maximumFractionDigits:1})+' m';
  $('stepIndicator').textContent=withSeparators(count)+' / '+withSeparators(length);
  $('currentInstruction').textContent=count===0?'Départ : clou 0':count===length?'Parcours complet':`Clou ${path[count-1]} → ${path[count]}`;
  drawArt(path,count,displayCanvas,{nails:n,highlight:count<length});
}
function exportFile(blob,filename,shareImage=false){
  const file=new File([blob],filename,{type:blob.type});
  if(shareImage && navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
    navigator.share({files:[file],title:'Mon string art – Filigrane'}).catch(e=>{
      if(e.name!=='AbortError')downloadBlob(blob,filename);
    });
  }else{downloadBlob(blob,filename);}
}
function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function exportPNG(){
  if(!state.path)return;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1800;
  drawArt(state.path,state.path.length-1,canvas,{nails:state.nails});
  canvas.toBlob(blob=>{if(blob)exportFile(blob,'filigrane-mon-tableau.png',true);else showError('Export PNG impossible.');},'image/png');
}
function exportSVG(){
  if(!state.path)return;
  const path=state.path,n=state.nails,size=1000,pts=circlePoints(n,size),radius=size*.466;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000"><title>Filigrane — ${n} clous, ${path.length-1} passages</title><rect width="1000" height="1000" fill="#fdfbf5"/><circle cx="500" cy="500" r="${radius}" fill="#fffefd" stroke="#c4a894" stroke-width="2"/>`;
  svg+='<g fill="none" stroke="#0e0e0c" stroke-opacity="0.158" stroke-width="1.45">';
  for(let i=1;i<path.length;i++){
    const a=pts[path[i-1]],b=pts[path[i]];
    svg+=`<path d="M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${b[0].toFixed(2)} ${b[1].toFixed(2)}"/>`;
  }
  svg+='</g><g fill="#6c6152">';
  for(const p of pts)svg+=`<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="2.35"/>`;
  svg+='</g><circle cx="500" cy="34" r="5" fill="#bd654a"/></svg>';
  exportFile(new Blob([svg],{type:'image/svg+xml'}),'filigrane-mon-tableau.svg');
}
function exportCSV(){
  if(!state.path)return;
  const path=state.path,n=state.nails,diameter=currentSettings().diameter,a=2*Math.PI/n;
  const rows=[['Etape','Clou de depart','Clou d arrivee','Longueur droite (cm)','Longueur cumulee (cm)'].join(';')];
  let total=0;
  for(let k=1;k<path.length;k++){
    const d=Math.abs(path[k]-path[k-1]);
    const dist=diameter*Math.sin(Math.min(d,n-d)*a/2);
    total+=dist;
    rows.push([k,path[k-1],path[k],dist.toFixed(2).replace('.',','),total.toFixed(2).replace('.',',')].join(';'));
  }
  rows.push('');
  rows.push('Clou 0 = clou du haut ; numerotation dans le sens horaire');
  rows.push('Estimation hors contournement des clous : '+(total/100).toFixed(1).replace('.',',')+' m');
  rows.push('Avec marge de 2 cm par passage : '+((total+2*(path.length-1))/100).toFixed(1).replace('.',',')+' m');
  exportFile(new Blob(['\ufeff',rows.join('\r\n')],{type:'text/csv;charset=utf-8'}),'filigrane-parcours-clous.csv');
}

// Événements
$('photoInput').addEventListener('change',e=>{loadPhoto(e.target.files && e.target.files[0]);e.target.value='';});
$('demoButton').addEventListener('click',demoPortrait);
$('zoomRange').addEventListener('input',e=>{state.zoom=Number(e.target.value)/100;$('zoomValue').textContent=e.target.value+' %';clampPan();drawPhotoPreview();invalidate();});
for(const id of ['nailsRange','linesRange','contrastRange']){
  $(id).addEventListener('input',()=>{
    $('nailsValue').textContent=withSeparators(Number($('nailsRange').value))+' clous';
    $('linesValue').textContent=withSeparators(Number($('linesRange').value))+' passages';
    const contrast=Number($('contrastRange').value);
    $('contrastValue').textContent=contrast===110?'Normal':contrast<110?'Doux':'Renforcé';
    invalidate();
  });
}
$('diameterInput').addEventListener('input',()=>{if(state.path)updateResults();});
$('generateButton').addEventListener('click',startGeneration);
$('cancelButton').addEventListener('click',()=>{stopWorker();invalidate();});
$('stepRange').addEventListener('input',updateResults);
$('prevStep').addEventListener('click',()=>{$('stepRange').value=Math.max(0,Number($('stepRange').value)-1);updateResults();});
$('nextStep').addEventListener('click',()=>{$('stepRange').value=Math.min(Number($('stepRange').max),Number($('stepRange').value)+1);updateResults();});
$('savePNG').addEventListener('click',exportPNG);
$('saveSVG').addEventListener('click',exportSVG);
$('saveCSV').addEventListener('click',exportCSV);
let drag=null;
cropCanvas.addEventListener('pointerdown',(e)=>{
  if(!state.image)return;
  drag={x:e.clientX,y:e.clientY,px:state.panX,py:state.panY};
  cropCanvas.setPointerCapture(e.pointerId);
});
cropCanvas.addEventListener('pointermove',(e)=>{
  if(!drag)return;
  const w=cropCanvas.getBoundingClientRect().width||1;
  state.panX=drag.px+(e.clientX-drag.x)/w;
  state.panY=drag.py+(e.clientY-drag.y)/w;
  clampPan();drawPhotoPreview();invalidate();
});
for(const type of ['pointerup','pointercancel','lostpointercapture'])cropCanvas.addEventListener(type,()=>{drag=null;});
resetCanvas();
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost')){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}
