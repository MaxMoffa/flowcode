/* Flowcode site - pixel art (canvas). Plain script, no dependencies.
   Frog = port of frogArt.ts frogPixel (same geometry as the app). */
(function(){
"use strict";
document.documentElement.classList.add("js");
const AGENTS=[
 {id:"claude",green:"#E08A5E",dark:"#4A1E10"},
 {id:"codex",green:"#D9DEE6",dark:"#1F2430"},
 {id:"gemini",green:"#76A8FF",dark:"#14275E"},
 {id:"vibe",green:"#FF8A3D",dark:"#4F1D00"},
 {id:"opencode",green:"#9FB0C4",dark:"#1C232D"},
 {id:"cline",green:"#B794F6",dark:"#2A1658"},
];
const RM=matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const ease=t=>{t=clamp(t);return t*t*(3-2*t)};
const hash=(a,b=0)=>{let h=Math.sin(a*127.1+b*311.7)*43758.5453;return h-Math.floor(h)};
const PAL={
 awake:{green:"#A3E635",dark:"#14532D",white:"#FFFFFF"},
 rest:{green:"#AAC67D",dark:"#2A4434",white:"#EBEBEB"},
 carta:{green:"#7E9F5C",dark:"#2B3D20",white:"#FFF8EC"},
 gb:{green:"#9bbc0f",dark:"#0f380f",white:"#e0f8d0"},
};
const BOX={x:130,y:205,w:764,h:650},FC=30,FR=24;
const POSE={lookX:0,lookY:6,lid:0,scaleX:1,scaleY:1,rotate:0,lift:0,cursor:true};
// Port of frogArt.ts frogPixel — same geometry as the app's frog.
function frogPixel(px,py,p,pal){
 const ox=512,oy=830,an=(-p.rotate*Math.PI)/180,dx=px-ox,dy=py-p.lift-oy;
 const x=ox+(dx*Math.cos(an)-dy*Math.sin(an))/p.scaleX,y=oy+(dx*Math.sin(an)+dy*Math.cos(an))/p.scaleY;
 const seg=(ax,ay,bx,by)=>{const sx=bx-ax,sy=by-ay,t=clamp(((x-ax)*sx+(y-ay)*sy)/(sx*sx+sy*sy));return Math.hypot(x-(ax+t*sx),y-(ay+t*sy))};
 for(const cx of [340,684]){
  if(p.lid>0&&Math.hypot(x-cx,y-393)<=89&&y<=304+178*p.lid)return pal.green;
  if(Math.hypot(x-(cx+14+p.lookX),y-378-p.lookY)<=16)return pal.white;
  if(Math.hypot(x-(cx+p.lookX),y-393-p.lookY)<=45)return pal.dark;
  if(Math.hypot(x-cx,y-393)<=85)return pal.white;
 }
 const st=[[396,575,472,632],[472,632,396,689]];if(p.cursor)st.push([526,689,636,689]);
 if(st.some(s=>seg(...s)<=24))return pal.dark;
 const body=Math.hypot(x-340,y-400)<=135||Math.hypot(x-684,y-400)<=135||((x-512)/360)**2+((y-610)/220)**2<=1;
 return body?pal.green:null;
}
function frogGrid(p,pal){const o=[];for(let r=0;r<FR;r++){const y=BOX.y+((r+.5)*BOX.h)/FR;for(let c=0;c<FC;c++)o.push(frogPixel(BOX.x+((c+.5)*BOX.w)/FC,y,p,pal))}return o}
function drawFrog(ctx,pose,pal,x,y,g,cut=Infinity){
 const gr=frogGrid({...POSE,...pose},pal);x=Math.round(x);y=Math.round(y);
 for(let r=0;r<FR;r++){if(y+(r+1)*g>cut)break;for(let c=0;c<FC;c++){const col=gr[r*FC+c];if(!col)continue;ctx.fillStyle=col;ctx.fillRect(x+c*g,y+r*g,g,g)}}
}
function px(ctx,x,y,g,c,a=1){ctx.globalAlpha=a;ctx.fillStyle=c;ctx.fillRect(Math.round(x/g)*g,Math.round(y/g)*g,g,g);ctx.globalAlpha=1}
function spr(ctx,rows,map,x,y,g,flip){
 const w=rows[0].length;x=Math.round(x/g)*g;y=Math.round(y/g)*g;
 for(let r=0;r<rows.length;r++)for(let c=0;c<w;c++){const col=map[rows[r][c]];if(!col)continue;ctx.fillStyle=col;ctx.fillRect(x+(flip?w-1-c:c)*g,y+r*g,g,g)}
}
function ring(ctx,cx,cy,r,a,col,g,sq=.32){
 if(a<=0)return;ctx.globalAlpha=a;ctx.fillStyle=col;const n=Math.max(14,Math.round(r*1.4/g*4)),seen=new Set();
 for(let i=0;i<n;i++){const an=i/n*Math.PI*2,gx=Math.round((cx+Math.cos(an)*r)/g),gy=Math.round((cy+Math.sin(an)*r*sq)/g),k=gx+","+gy;if(seen.has(k))continue;seen.add(k);ctx.fillRect(gx*g,gy*g,g,g)}
 ctx.globalAlpha=1;
}
const PAD=["....LLLLL.LLLL....","..LLLLLLL.LLLLLL..",".LLLLLLLLlLLLLLLL.","LLLLlLLLLLLLLLLLLL",".LLLLLLLLLLLLlLLL.","..DDLLLLLLLLLLDD..","....DDDDDDDDDD...."];
const FLOWER=["..p.p..",".ppwpp.","ppwywpp",".ppppp."];
const CLOUD=["....WWWW......","..WWWWWWWW.WW.",".WWWWWWWWWWWWW","WWWWWWWWWWWWWW",".SSSSSSSSSSSS."];
const MOON=[".MMMM.","MMMMcM","MMcMMM","MMMMMM","MMMcMM",".MMMM."];
function lilyPad(ctx,x,y,g,col,flower,flip){spr(ctx,PAD,{L:col.pad,l:col.padHi,D:col.padLo},x,y,g,flip);if(flower)spr(ctx,FLOWER,{p:"#f2a7c3",w:"#fff0f6",y:"#ffd447"},x+11*g,y-3*g,g)}
function cattail(ctx,x,base,hgt,sway,g,stem,head){
 for(let i=0;i<hgt;i++){const f=i/hgt,xx=x+Math.round(sway*f*f)*g;ctx.fillStyle=stem;ctx.fillRect(Math.round(xx/g)*g,base-i*g,g,g);
  if(i>hgt-8&&i<hgt-1){ctx.fillStyle=head;ctx.fillRect(Math.round(xx/g)*g-g,base-i*g,g*3,g)}}
}
function blade(ctx,x,base,hgt,sway,g,col){for(let i=0;i<hgt;i++){const f=i/hgt;ctx.fillStyle=col;ctx.fillRect(Math.round((x+sway*f*f*g)/g)*g,base-i*g,g,g)}}
function fly(ctx,x,y,g,t,dark="#1a1a1a",wing="rgba(255,255,255,.85)"){px(ctx,x,y,g,dark);const up=Math.floor(t*20)%2;px(ctx,x-g,y-(up?g:0),g,wing);px(ctx,x+g,y-(up?g:0),g,wing)}
function dragonfly(ctx,x,y,g,t,body="#3fb6c9",dir=1){
 for(let i=0;i<8;i++)px(ctx,x-dir*i*g,y,g,i===0?"#1d5d6b":body);
 const up=Math.floor(t*24)%2,wc="rgba(220,245,255,.8)";
 for(let i=1;i<4;i++){px(ctx,x-dir*(1+(i>2?1:0))*g,y-i*g*(up?1:.5),g,wc);px(ctx,x-dir*(2+(i>2?1:0))*g,y+i*g*(up?.5:1),g,wc)}
}
function pixelEmoji(cv,emo,n=16){
 const o=document.createElement("canvas");o.width=o.height=n;const c=o.getContext("2d");
 c.textAlign="center";c.textBaseline="middle";c.font=`${n-2}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;c.fillText(emo,n/2,n/2+1);
 const d=c.getImageData(0,0,n,n);for(let i=3;i<d.data.length;i+=4)d.data[i]=d.data[i]>100?255:0;c.putImageData(d,0,0);
 const s=Math.max(2,Math.round((cv.clientWidth||n*2)*(devicePixelRatio||1)/n));cv.width=cv.height=n*s;const x=cv.getContext("2d");x.imageSmoothingEnabled=false;x.drawImage(o,0,0,n*s,n*s);
}
function staticFrog(cv,pal,pose={}){const g=Math.max(1,Math.round((cv.clientWidth||30)*(devicePixelRatio||1)/FC));cv.width=FC*g;cv.height=FR*g;drawFrog(cv.getContext("2d"),pose,pal,0,0,g)}

/* scene loop */
const scenes=[];
const io=new IntersectionObserver(es=>es.forEach(e=>{const s=scenes.find(x=>x.cv===e.target);if(s)s.vis=e.isIntersecting}));
function scene(cv,draw,init){const s={cv,ctx:cv.getContext("2d"),draw,w:0,h:0,dpr:0,vis:true,st:{},t0:performance.now(),mouse:{x:-1,y:-1},drawn:false};
 cv.addEventListener("pointermove",e=>{const r=cv.getBoundingClientRect();s.mouse={x:e.clientX-r.left,y:e.clientY-r.top}});
 cv.addEventListener("pointerleave",()=>s.mouse={x:-1,y:-1});
 if(init)init(s);io.observe(cv);scenes.push(s);return s}
function loop(now){
 for(const s of scenes){
  if(!s.vis||s.cv.offsetParent===null)continue;
  const dpr=devicePixelRatio||1,w=s.cv.clientWidth,h=s.cv.clientHeight;if(!w||!h)continue;
  const rs=s.w!==w||s.h!==h||s.dpr!==dpr;
  if(rs){s.w=w;s.h=h;s.dpr=dpr;s.cv.width=Math.round(w*dpr);s.cv.height=Math.round(h*dpr)}
  if(RM&&s.drawn&&!rs&&!s.dirty)continue;
  s.ctx.setTransform(dpr,0,0,dpr,0,0);s.ctx.imageSmoothingEnabled=false;
  s.resized=rs;s.draw(s,RM?4:(now-s.t0)/1000);s.drawn=true;s.dirty=false;
 }
 requestAnimationFrame(loop);
}

/* ====================== POND THEMES ====================== */
const TOD={
 day:{sky:["#5fb4e8","#86c9ef","#aedcf4","#d3eef8"],hill:["#7cb36a","#5a944e"],water:"#2f86ad",water2:"#2a7899",shim:"#a9e0f2",sun:"#fff3a6",sunY:.28,pad:"#5aa83c",padHi:"#86cc5a",padLo:"#367a26",stem:"#3d7a2a",head:"#7a4a22",cloud:"#ffffff",cloudS:"#d6ecf7",flies:4,fire:0,stars:0,dragon:1,frog:PAL.awake},
 dusk:{sky:["#24173f","#46205a","#7a2d63","#b8466a","#e8775a","#f6ae68"],hill:["#3b2550","#281a3b"],water:"#2e2350",water2:"#251c43",shim:"#f5a868",sun:"#ffd27a",sunY:.86,pad:"#4f7a3a",padHi:"#77a352",padLo:"#2f4c22",stem:"#2a3a22",head:"#5a3218",cloud:"#f0a27a",cloudS:"#b8607a",flies:4,fire:3,stars:.3,dragon:1,frog:PAL.awake},
 night:{sky:["#050817","#0a1230","#111c44","#182656"],hill:["#0f1a2c","#0a1220"],water:"#0b1830",water2:"#08132a",shim:"#4f6fa8",sun:"#f4f0d8",sunY:.25,moon:1,pad:"#2f5530",padHi:"#46744a",padLo:"#1d361f",stem:"#16261a",head:"#2c1d10",cloud:"#24305a",cloudS:"#1a2448",flies:0,fire:16,stars:1,dragon:0,frog:PAL.rest},
 carta:{sky:["#f6ead2","#f3e3c4","#efdbb7"],hill:["#e0caa0","#cdb48a"],water:"#a9c1ae",water2:"#9bb5a2",shim:"#eef3e6",sun:"#f0c58a",sunY:.5,pad:"#7e9f5c",padHi:"#a3bf7c",padLo:"#5a7840",stem:"#6b5a42",head:"#8f5428",cloud:"#fffaf1",cloudS:"#ead9b8",flies:3,fire:0,stars:0,dragon:1,frog:PAL.carta},
 gb:{sky:["#9bbc0f","#8bac0f"],hill:["#5e8a1a","#306230"],water:"#306230",water2:"#204a20",shim:"#8bac0f",sun:"#e0f8d0",sunY:.3,pad:"#8bac0f",padHi:"#9bbc0f",padLo:"#0f380f",stem:"#0f380f",head:"#306230",cloud:"#e0f8d0",cloudS:"#9bbc0f",flies:2,fire:0,stars:0,dragon:0,frog:PAL.gb},
};

/* Generic side-view pond: used by hero, strips, mini widgets, postcard, footer. */
function pondLayer(s,T,g,waterY){
 const o=document.createElement("canvas");o.width=Math.ceil(s.w*s.dpr);o.height=Math.ceil(s.h*s.dpr);const c=o.getContext("2d");c.setTransform(s.dpr,0,0,s.dpr,0,0);
 const cols=Math.ceil(s.w/g),rows=Math.ceil(waterY/g),n=T.sky.length;
 for(let r=0;r<rows;r++){const f=r/rows*(n-1),i=Math.floor(f),fr=f-i;for(let cc=0;cc<cols;cc++){let k=i;if(i<n-1&&(fr>.85||(fr>.5&&(cc+r)%2===0)))k=i+1;c.fillStyle=T.sky[k];c.fillRect(cc*g,r*g,g,g)}}
 if(T.stars)for(let i=0;i<cols*rows*.012*T.stars;i++){const x=Math.floor(hash(i,1)*cols),y=Math.floor(hash(i,2)*rows*.8);c.fillStyle=hash(i,3)>.8?"#fff6c8":"#c8d4ff";c.globalAlpha=.4+hash(i,4)*.6;c.fillRect(x*g,y*g,g,g)}
 c.globalAlpha=1;
 const sx=Math.round(s.w*.72/g)*g,sy=Math.round(waterY*T.sunY/g)*g,R=Math.round(Math.min(10,waterY/g*.16));
 if(T.moon){spr(c,MOON,{M:T.sun,c:"#c9c3a6"},sx,sy,g*2)}else{for(let y=-R;y<=R;y++)for(let x=-R;x<=R;x++)if(x*x+y*y<=R*R&&sy+y*g<waterY){c.fillStyle=T.sun;c.fillRect(sx+x*g,sy+y*g,g,g)}}
 T.hill.forEach((hc,li)=>{c.fillStyle=hc;for(let cc=0;cc<cols;cc++){const x=cc*g,hh=li===0?(5+3*Math.sin(x*.011)+2.5*Math.sin(x*.027+1.3)):(2+1.6*Math.sin(x*.019+2)+1.2*Math.sin(x*.05));const top=waterY-Math.round(hh*Math.max(1,waterY/g/22))*g;c.fillRect(x,top,g,waterY-top)}});
 return {img:o,sx,sy};
}
function drawWater(ctx,s,T,g,waterY,t,sunX){
 ctx.fillStyle=T.water;ctx.fillRect(0,waterY,s.w,s.h-waterY);
 const rows=Math.floor((s.h-waterY)/g/2);
 for(let r=0;r<rows;r++){const y=waterY+(r*2+1)*g;if(r%3===2){ctx.fillStyle=T.water2;ctx.fillRect(0,y,s.w,g)}
  const cnt=Math.ceil(s.w/90);for(let i=0;i<cnt;i++){const sp=(6+r*2)*(r%2?1:-1),x=((hash(i,r)*s.w+t*sp)%s.w+s.w)%s.w,len=(2+Math.floor(hash(i,r+9)*5))*g,a=.25+.35*Math.abs(Math.sin(t*1.5+i+r));ctx.globalAlpha=a;ctx.fillStyle=T.shim;ctx.fillRect(Math.round(x/g)*g,y,len,g)}}
 ctx.globalAlpha=1;
 if(sunX!=null&&!T.moon||T.moon){const cx=sunX??s.w*.72;for(let r=0;r<rows;r++){const y=waterY+(r*2)*g,wd=Math.max(1,10-r)*g*(T.moon?.6:1);if(hash(r,Math.floor(t*4))>.25){ctx.globalAlpha=.55;ctx.fillStyle=T.sun;ctx.fillRect(Math.round((cx-wd/2+Math.sin(t*2+r)*g*2)/g)*g,y,Math.round(wd/g)*g,g)}}ctx.globalAlpha=1}
}
function drawClouds(ctx,s,T,g,waterY,t){if(T.moon)return;for(let i=0;i<3;i++){const sp=4+i*2.5,x=((hash(i,7)*s.w+t*sp)%(s.w+80*g/4))-40,y=waterY*(.12+i*.14);spr(ctx,CLOUD,{W:T.cloud,S:T.cloudS},x,y,g*(i===0?2:1))}}
function drawFireflies(ctx,s,T,g,waterY,t,n){for(let i=0;i<n;i++){const x=(hash(i,11)*s.w+Math.sin(t*.6+i)*40),y=waterY*(.45+hash(i,12)*.6)+Math.cos(t*.8+i*2)*14,a=.5+.5*Math.sin(t*3+i*1.7);if(a<.15)continue;ctx.globalAlpha=a*.25;ctx.fillStyle="#d9ff6a";ctx.fillRect(Math.round(x/g)*g-g,Math.round(y/g)*g-g,g*3,g*3);px(ctx,x,y,g,"#f2ffb0",a)}}
/* ---------- simple pond scenes (strip / mini / postcard / footer) ---------- */
function miniPond(cv,todName,opt={}){
 return scene(cv,(s,t)=>{
  const ctx=s.ctx,st=s.st,T=TOD[todName],g=opt.g||(s.h<140?3:4),waterY=Math.round(s.h*(opt.water||.55)/g)*g;
  if(s.resized||!st.layer)st.layer=pondLayer(s,T,g,waterY);
  ctx.drawImage(st.layer.img,0,0,s.w,s.h);drawClouds(ctx,s,T,g,waterY,t);drawWater(ctx,s,T,g,waterY,t,st.layer.sx);
  for(let i=0;i<Math.ceil(s.w/60);i++)cattail(ctx,(i%2?s.w-(i*7+4)*g:(i*7+4)*g),s.h-g,Math.round(s.h/g*.45)+Math.floor(hash(i,2)*8),Math.sin(t*1.2+i)*2.5,g,T.stem,T.head);
  const padX=Math.round(s.w*(opt.fx||.5)/g)*g,padY=waterY+Math.round((s.h-waterY)*.4/g)*g;
  lilyPad(ctx,padX-9*g,padY,g,T,true);
  if(s.w>400)lilyPad(ctx,padX+40*g,padY+6*g,g,T,false,1),lilyPad(ctx,padX-60*g,padY+3*g,g,T,false);
  // surfacing: st.surf = time of page change
  let lift=0,cut=Infinity;const su=st.surf!=null?(t-st.surf):9;
  if(su<1.6){const u=ease(clamp((su-.15)/.9));lift=lerp(22*g,0,u)+Math.sin(u*Math.PI)*-4*g;cut=padY+3*g;if(Math.abs(su-.2)<.03)st.rip=[...(st.rip||[]),{x:padX,y:padY+3*g,t}]}
  st.rip=(st.rip||[]).filter(r=>t-r.t<1.6);for(const r of st.rip){const u=(t-r.t)/1.6;ring(ctx,r.x,r.y,lerp(g,22*g,ease(u)),(1-u)*.8,T.shim,g)}
  if(!st.rip.length&&(t%4)<.02)st.rip.push({x:padX,y:padY+3*g,t});
  const m=s.mouse,cx=padX,fy=padY-21*g+lift;
  const pose={lid:(t%4.1)<.18?Math.sin((t%4.1)/.18*Math.PI):0,cursor:Math.floor(t*2)%2===0,scaleY:1+Math.sin(t*2)*.015};
  if(m.x>=0){pose.lookX=clamp((m.x-cx)/6,-30,30);pose.lookY=clamp((m.y-fy-10*g)/8,-10,24)}
  drawFrog(ctx,pose,T.frog,padX-15*g,fy,g,cut);
  for(let i=0;i<T.flies;i++)fly(ctx,s.w*(.2+.6*hash(i,5))+Math.sin(t*(1+i*.3)+i)*50,waterY*(.5+.3*hash(i,6))+Math.cos(t*1.3+i)*20,g,t+i);
  if(T.dragon&&s.w>300)dragonfly(ctx,((t*50)%(s.w+300))-150,waterY-18*g+Math.sin(t*3)*4*g,g,t,todName==="carta"?"#5a8fa0":"#3fb6c9");
  if(T.fire)drawFireflies(ctx,s,T,g,waterY,t,Math.ceil(T.fire/2));
 });
}

/* frog card (party) */
function frogCard(cv,a,bg){
 return scene(cv,(s,t)=>{const ctx=s.ctx,g=Math.max(3,Math.floor(Math.min(s.w/FC*.42,s.h/FR*.55))),st=s.st;
  ctx.clearRect(0,0,s.w,s.h);if(bg){ctx.fillStyle=bg;ctx.fillRect(0,0,s.w,s.h)}
  const base=s.h-6*g,ph=a.id.length;
  // water band
  ctx.fillStyle=bg?"#14244a":"#2b3f6a";ctx.fillRect(0,base,s.w,s.h-base);for(let x=0;x<s.w;x+=g*6)px(ctx,x+((t*12+ph*7)%(g*6)),base+g*2,g,bg?"#3a5a9a":"#5a7ab0",.6);
  const pad={pad:"#4f7a3a",padHi:"#77a352",padLo:"#2f4c22"};lilyPad(ctx,s.w/2-9*g,base-2*g,g,pad,false);
  let lift=0,pose={cursor:Math.floor(t*2+ph)%2===0,lid:((t+ph)%3.3)<.16?Math.sin(((t+ph)%3.3)/.16*Math.PI):0};
  if(st.hop!=null){const u=clamp((t-st.hop)/.55);lift=-Math.sin(u*Math.PI)*16*g;pose.scaleY=u<.12||u>.9?.88:1.05;if(u>=1)st.hop=null}
  const m=s.mouse;if(m.x>=0){pose.lookX=clamp((m.x-s.w/2)/5,-30,30);pose.lookY=clamp((m.y-base)/6,-10,24)}
  drawFrog(ctx,pose,{green:a.green,dark:a.dark,white:"#FFFFFF"},s.w/2-15*g,base-21*g+lift,g);
 },s=>{s.cv.closest("[data-hop]")?.addEventListener("pointerenter",()=>{s.st.hop=(performance.now()-s.t0)/1000})});
}

/* ---------- B title ---------- */
function titleB(cv){
 return scene(cv,(s,t)=>{const ctx=s.ctx,st=s.st,g=5;
  ctx.fillStyle="#0b1020";ctx.fillRect(0,0,s.w,s.h);
  for(let i=0;i<140;i++){const sp=10+hash(i,1)*40,x=((hash(i,2)*s.w-t*sp)%s.w+s.w)%s.w,y=hash(i,3)*s.h*.75;px(ctx,x,y,g>4?3:2,hash(i,4)>.85?"#ffd447":"#8fa0c8",.5+.5*Math.sin(t*3+i))}
  // checker ground + water
  const gy=Math.round(s.h*.74/g)*g;
  for(let y=gy;y<s.h;y+=g*2)for(let x=0;x<s.w;x+=g*2){ctx.fillStyle=((x+y)/(g*2)+Math.floor(t*4))%2<1?"#16305a":"#12264a";ctx.fillRect(x,y,g*2,g*2)}
  ctx.fillStyle="#5ad1ff";for(let x=0;x<s.w;x+=g*4)ctx.fillRect(x+((t*30)%(g*4)),gy,g*2,g);
  // big frog bounce
  const G=Math.round(Math.min(10,s.w/FC*.2)),bt=(t%1.2)/1.2,hop=Math.abs(Math.sin(bt*Math.PI)),fx=s.w/2-15*G,base=gy-21*G+3*G,fy=base-hop*14*g;
  const sh=Math.round((1-hop*.5)*12);ctx.fillStyle="rgba(0,0,0,.45)";ctx.fillRect(s.w/2-sh*G,gy+G,sh*2*G,G*2);
  const m=s.mouse,cx=s.w/2;
  const pose={scaleY:hop<.08?.86:1.03,scaleX:hop<.08?1.08:1,cursor:Math.floor(t*2)%2===0,lid:(t%3)<.15?1:0};
  if(m.x>=0){pose.lookX=clamp((m.x-cx)/6,-30,30);pose.lookY=clamp((m.y-fy-10*G)/8,-10,24)}
  drawFrog(ctx,pose,PAL.awake,fx,fy,G);
  st.fl=st.fl||Array.from({length:7},(_,i)=>({i,dead:0}));
  for(const f of st.fl){if(t<f.dead)continue;f.x=s.w*(.15+.7*hash(f.i,9))+Math.sin(t*(.9+f.i*.13)+f.i)*120;f.y=s.h*(.3+.3*hash(f.i,8))+Math.cos(t*(1.2+f.i*.1)+f.i)*60;fly(ctx,f.x,f.y,g,t+f.i,"#e8f6d0","rgba(90,209,255,.9)")}
  if(st.tongue){const u=(t-st.tongue.t)/.3,k=Math.sin(clamp(u)*Math.PI),mx=cx,my=fy+15*G,tx=lerp(mx,st.tongue.x,k),ty=lerp(my,st.tongue.y,k),n=Math.ceil(Math.hypot(tx-mx,ty-my)/g);
   for(let i=0;i<=n;i++)px(ctx,lerp(mx,tx,i/n),lerp(my,ty,i/n),g,"#ff5a6e");
   if(u>=.5&&!st.tongue.done){st.tongue.done=1;const hit=st.fl.find(f=>t>=f.dead&&Math.hypot(f.x-st.tongue.x,f.y-st.tongue.y)<40);if(hit){hit.dead=t+2;bScore(1);st.pops=[...(st.pops||[]),{x:hit.x,y:hit.y,t}]}}
   if(u>=1)st.tongue=null}
  st.pops=(st.pops||[]).filter(p=>t-p.t<.8);ctx.font='10px "Press Start 2P"';ctx.fillStyle="#ffd447";for(const p of st.pops)ctx.fillText("+1",p.x,p.y-(t-p.t)*40);
 },s=>{s.cv.addEventListener("click",e=>{const r=s.cv.getBoundingClientRect();if(!s.st.tongue)s.st.tongue={t:(performance.now()-s.t0)/1000,x:e.clientX-r.left,y:e.clientY-r.top}})});

}
/* ====================== PAGE WIRING ====================== */
let score=0;
function bScore(n){score+=n;const el=document.getElementById("score");if(el)el.textContent=String(score).padStart(3,"0")}
const $$=(sel)=>Array.from(document.querySelectorAll(sel));
const agentById=id=>AGENTS.find(a=>a.id===id);

function hydrate(){
 $$("canvas[data-emoji]").forEach(cv=>pixelEmoji(cv,cv.dataset.emoji));
 $$("canvas[data-agentfrog]").forEach(cv=>{const a=agentById(cv.dataset.agentfrog);if(a)staticFrog(cv,{green:a.green,dark:a.dark,white:"#fff"})});
 $$("canvas[data-pad]").forEach(cv=>{const g=3;cv.width=18*g;cv.height=8*g;lilyPad(cv.getContext("2d"),0,g,g,TOD.dusk,cv.dataset.pad==="flower")});
 $$("canvas[data-frog]").forEach(cv=>staticFrog(cv,PAL.awake,{lookY:12}));
 $$("canvas[data-card]").forEach(cv=>{const a=agentById(cv.dataset.card);if(a)frogCard(cv,a,"#1c2a4f")});
 $$("canvas[data-portrait]").forEach(cv=>scene(cv,(s,t)=>{const g=Math.floor(Math.min(s.w/FC,s.h/FR)*.85);s.ctx.clearRect(0,0,s.w,s.h);
  drawFrog(s.ctx,{cursor:Math.floor(t*2)%2===0,lid:(t%2.6)<.14?1:0,lookX:Math.sin(t*.7)*20},PAL.awake,(s.w-FC*g)/2,(s.h-FR*g)/2+g,g)}));
 $$("canvas[data-scene]").forEach(cv=>miniPond(cv,cv.dataset.scene,{fx:parseFloat(cv.dataset.fx||".5")}));
 const title=document.getElementById("title");if(title)titleB(title);
 requestAnimationFrame(loop);
}

/* nav: mobile menu button */
function wireNav(){
 const btn=document.querySelector(".menu-btn"),nav=document.getElementById("site-nav");
 if(!btn||!nav)return;
 btn.addEventListener("click",()=>{const o=nav.classList.toggle("open");btn.setAttribute("aria-expanded",o);btn.textContent=o?"CLOSE":"MENU"});
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&nav.classList.contains("open")){nav.classList.remove("open");btn.setAttribute("aria-expanded","false");btn.textContent="MENU";btn.focus()}});
}

/* highlight the visitor's system on the download page */
function wireOS(){
 const u=navigator.userAgent,os=/Android/i.test(u)?"android":/Mac/i.test(u)?"mac":/Linux|X11/i.test(u)?"linux":"win";
 const names={win:"Windows",mac:"macOS",linux:"Linux",android:"Android"};
 $$("[data-os]").forEach(el=>{if(el.dataset.os===os)el.classList.add("mine")});
 $$(".os-name").forEach(el=>el.textContent=names[os]);
}

/* latest release tag from the GitHub API (silent fallback to the static text) */
function wireLatest(){
 const els=$$("[data-latest]");if(!els.length||!window.fetch)return;
 fetch("https://api.github.com/repos/MaxMoffa/flowcode/releases/latest",{headers:{Accept:"application/vnd.github+json"}})
  .then(r=>r.ok?r.json():null)
  .then(d=>{if(d&&typeof d.tag_name==="string"&&/^v?[\w.\-]{1,20}$/.test(d.tag_name))els.forEach(el=>{el.textContent=el.dataset.latest.replace("%v",d.tag_name)})})
  .catch(()=>{});
}

function start(){hydrate();wireNav();wireOS();wireLatest()}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
