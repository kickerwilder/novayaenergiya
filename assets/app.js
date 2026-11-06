/* ===================== SETTINGS ===================== */
const SETTINGS = {
  currency: "₽",                 // знак валюты
  noPriceText: "Цена по запросу",
  deliveryText: "с доставкой",   // подпись рядом с каждой ценой (цены включают доставку)
  contactLabel: "Позвонить",
  contactHref: "tel:+79787280002" // основной контакт; например "https://t.me/ваш_ник"; пусто = кнопка скрыта
};

(function(){
"use strict";
var D=DATA, EFF=D.eff, PH=D.phone_wh;
var nf=new Intl.NumberFormat("ru-RU");
var reduceMotion=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)");
function N(x){return x==null?"—":nf.format(x)}
function dec(x,d){return String(Math.round(x*Math.pow(10,d))/Math.pow(10,d)).replace(".",",")}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function hoursText(h){
  if(h<1) return "≈ "+Math.round(h*60)+" мин";
  if(h<10) return "≈ "+dec(h,1)+" ч";
  if(h<48) return "≈ "+Math.round(h)+" ч";
  return "≈ "+dec(h/24,1)+" сут";
}
function kwh(w){return dec(w/1000,1)}
var state={ver:"all",group:null,power:null,purpose:null,q:"",sort:"cap-asc",sel:{},only:true,cv:{}};
var BY={}; D.combos.forEach(function(c){BY[c.id]=c});
function curVer(c){
  var v=state.cv[c.id];
  if(v&&c.vers[v]) return v;
  if(state.ver!=="all"&&c.vers[state.ver]) return state.ver;
  return c.vers.D?"D":"L";
}
function totalLoad(){
  var t=0,any=false;
  D.loads.forEach(function(l){ if(state.sel[l.key]){any=true; t+=(l.watts==null?20:l.watts);} });
  return any?t:0;
}
function fits(c,t){return !t||c.power>=t}
function runtimeFor(c){
  return D.loads.map(function(l){
    if(l.watts==null) return {l:l,ok:true,text:"≈ "+N(Math.floor(c.cap*EFF/PH))+" раз"};
    if(c.power<l.watts) return {l:l,ok:false,text:"не потянет"};
    return {l:l,ok:true,h:c.cap*EFF/l.watts,text:hoursText(c.cap*EFF/l.watts)};
  });
}

/* ---- версии (шапка): «Все» / «Тёмный» / «Светлый на колёсах» ---- */
var kindsEl=document.getElementById("kinds"), hkEl=document.getElementById("hkinds");
function plural(n,f){var a=n%10,b=n%100; return f[(b>10&&b<20)?2:(a===1?0:(a>=2&&a<=4?1:2))]}
var KINDS=[
  {key:"all",title:"Все",act:"Показать все варианты"},
  {key:"D",title:"Тёмный корпус",act:"Показать только тёмные"},
  {key:"L",title:"Светлый на колёсах",act:"Показать только светлые"}
];
function kindCount(k){return D.combos.filter(function(c){return k==="all"||c.vers[k]}).length}
function setVer(key){state.ver=key;state.cv={};render();}
function kindPic(key,cls,w,h){
  var im=function(k){return '<img src="'+D.scenes[k]+'" alt="" width="'+w+'" height="'+h+'" loading="lazy">'};
  return key==="all"?'<span class="'+cls+' duo">'+im("D")+im("L")+'</span>':'<span class="'+cls+'">'+im(key)+'</span>';
}
/* hero: сцена показывает последний выбранный корпус; при «Все» остаётся прежняя */
var heroSide="D", sceneEl={D:document.getElementById("sceneD"),L:document.getElementById("sceneL")}, stageTag=document.getElementById("stagetag");
function renderHero(){
  if(state.ver==="D"||state.ver==="L") heroSide=state.ver;
  ["D","L"].forEach(function(k){ if(sceneEl[k]) sceneEl[k].classList.toggle("on",k===heroSide); });
  if(stageTag) stageTag.textContent=D.versions[heroSide].name;
}
function renderKinds(){
  if(!kindsEl.children.length){ /* строится один раз: счётчики из DATA, фокус не теряется при перерисовках */
    KINDS.forEach(function(k){
      var n=kindCount(k.key), cnt=n+' '+plural(n,["модель","модели","моделей"]);
      var b=document.createElement("button"); b.type="button"; b.className="kind"; b.dataset.kind=k.key;
      b.innerHTML=kindPic(k.key,"kpic",640,359)+'<span class="kt"><b>'+k.title+'</b><span class="ka">'+k.act+'</span><span class="kn">'+cnt+'</span></span>';
      b.addEventListener("click",function(){setVer(k.key)});
      kindsEl.appendChild(b);
      if(hkEl){
        var h=document.createElement("button"); h.type="button"; h.className="hk"; h.dataset.kind=k.key;
        h.setAttribute("aria-label",k.act+" ("+cnt+")");
        h.innerHTML=kindPic(k.key,"hpic",64,36)+'<span class="ht">'+(k.key==="all"?"Все":D.versions[k.key].short)+'</span>';
        h.addEventListener("click",function(){setVer(k.key)});
        hkEl.appendChild(h);
      }
    });
  }
  [kindsEl,hkEl].forEach(function(box){ if(!box) return;
    Array.prototype.forEach.call(box.children,function(b){b.setAttribute("aria-pressed",state.ver===b.dataset.kind?"true":"false")});
  });
  renderHero();
}

/* ---- подбор по нагрузке ---- */
var loadsEl=document.getElementById("loads"), pickrow=document.getElementById("pickrow");
D.loads.forEach(function(l){
  var b=document.createElement("button"); b.type="button"; b.className="load"; b.setAttribute("aria-pressed","false"); b.dataset.k=l.key;
  b.innerHTML=l.name.replace(/ \(.*\)$/,"").replace("Смартфон","Смартфон")+"<small>"+(l.watts==null?"зарядка":N(l.watts)+" Вт")+"</small>";
  b.addEventListener("click",function(){
    state.sel[l.key]=!state.sel[l.key]; b.setAttribute("aria-pressed",state.sel[l.key]?"true":"false"); render();
  });
  loadsEl.appendChild(b);
});
function renderPickrow(){
  var t=totalLoad();
  pickrow.innerHTML="";
  var s=document.createElement("span"); s.className="total";
  if(!t){ s.textContent="Ничего не выбрано — показаны все модели."; pickrow.appendChild(s); return; }
  s.innerHTML="Суммарная нагрузка:<b>"+N(t)+"</b>Вт"; pickrow.appendChild(s);
  var lb=document.createElement("label"); lb.className="chk";
  lb.innerHTML='<input type="checkbox"'+(state.only?" checked":"")+'> Скрыть модели, которым не хватит мощности';
  pickrow.appendChild(lb);
  lb.querySelector("input").addEventListener("change",function(e){state.only=e.target.checked;render();});
  var c=document.createElement("button"); c.type="button"; c.className="linkbtn"; c.textContent="Сбросить";
  c.addEventListener("click",function(){state.sel={};document.querySelectorAll(".load").forEach(function(b){b.setAttribute("aria-pressed","false")});render();});
  pickrow.appendChild(c);
}

/* ---- фильтры ---- */
function chip(parent,text,count,on,fn){
  var b=document.createElement("button"); b.type="button"; b.className="chip"; b.setAttribute("aria-pressed",on?"true":"false");
  b.innerHTML=esc(text)+(count!=null?"<span>"+count+"</span>":""); b.addEventListener("click",fn); parent.appendChild(b);
}
function baseList(){return D.combos.filter(function(c){return state.ver==="all"||c.vers[state.ver]})}
function renderFilters(){
  var gEl=document.getElementById("fGroup"), pEl=document.getElementById("fPower"), uEl=document.getElementById("fPurp"), base=baseList();
  [gEl,pEl,uEl].forEach(function(e){var l=e.firstChild; e.innerHTML=""; e.appendChild(l);});
  D.groups.forEach(function(g){
    var n=base.filter(function(c){return c.group===g}).length; if(!n) return;
    chip(gEl,g,n,state.group===g,function(){state.group=(state.group===g?null:g);render();});
  });
  D.powers.forEach(function(p){
    var n=base.filter(function(c){return c.power===p}).length; if(!n) return;
    chip(pEl,N(p)+" Вт",n,state.power===p,function(){state.power=(state.power===p?null:p);render();});
  });
  Object.keys(D.purposes).forEach(function(k){
    chip(uEl,D.purposes[k],null,state.purpose===k,function(){state.purpose=(state.purpose===k?null:k);render();});
  });
}

/* ---- карта ---- */
var mapEl=document.getElementById("map"), tip=document.getElementById("tip");
var MW=760, MH=380, ML=62, MR=16, MT=14, MB=44;
var PX=D.powers.map(function(p,i){return ML+(MW-ML-MR)*(i+.5)/D.powers.length});
var CMIN=1000, CMAX=24000;
function yOf(c){return MT+(MH-MT-MB)*(1-(Math.sqrt(c)-Math.sqrt(CMIN))/(Math.sqrt(CMAX)-Math.sqrt(CMIN)))}
function buildMap(){
  var s='<svg viewBox="0 0 '+MW+' '+MH+'" role="group" aria-label="Карта моделей: мощность и ёмкость">';
  [1500,3000,6000,10000,15000,23000].forEach(function(c){
    var y=yOf(c); s+='<line class="ax" x1="'+ML+'" x2="'+(MW-MR)+'" y1="'+y+'" y2="'+y+'"/><text class="tick" x="'+(ML-8)+'" y="'+(y+4)+'" text-anchor="end">'+kwh(c)+'</text>';
  });
  s+='<text class="atl" x="'+(ML-8)+'" y="'+(MT-2)+'" text-anchor="end">кВт·ч</text>';
  D.powers.forEach(function(p,i){
    s+='<text class="tick" x="'+PX[i]+'" y="'+(MH-MB+20)+'" text-anchor="middle">'+N(p)+'</text>';
  });
  s+='<text class="atl" x="'+((ML+MW-MR)/2)+'" y="'+(MH-6)+'" text-anchor="middle">Мощность, Вт</text>';
  D.combos.forEach(function(c){
    var x=PX[D.powers.indexOf(c.power)], y=yOf(c.cap), r=7, both=c.vers.D&&c.vers.L;
    var lab=c.title+(both?" — два варианта корпуса":(c.vers.D?" — тёмный корпус":" — светлый корпус на колёсах"));
    s+='<g class="mk" data-id="'+c.id+'" tabindex="0" role="link" aria-label="'+esc(lab)+'" transform="translate('+x+' '+y+')">';
    if(both) s+='<path class="d" d="M0 -'+r+'A'+r+' '+r+' 0 0 0 0 '+r+'Z"/><path class="l" d="M0 -'+r+'A'+r+' '+r+' 0 0 1 0 '+r+'Z"/>';
    else s+='<circle class="'+(c.vers.D?"d":"l")+'" r="'+r+'"/>';
    s+='<circle class="ring" r="'+r+'"/><circle r="8" fill="transparent"/></g>';
  });
  s+='</svg>';
  mapEl.innerHTML=s;
  mapEl.addEventListener("click",function(e){var g=e.target.closest(".mk"); if(g) goTo(g.dataset.id);});
  mapEl.addEventListener("keydown",function(e){var g=e.target.closest&&e.target.closest(".mk"); if(g&&(e.key==="Enter"||e.key===" ")){e.preventDefault();goTo(g.dataset.id);}});
  mapEl.addEventListener("mousemove",function(e){
    var g=e.target.closest(".mk"); if(!g){tip.classList.remove("on");return;}
    var c=BY[g.dataset.id]; tip.innerHTML="<b>"+esc(c.title)+"</b><br>"+(c.vers.D&&c.vers.L?"два варианта корпуса":(c.vers.D?"тёмный корпус":"светлый корпус на колёсах"));
    tip.style.left=Math.min(window.innerWidth-250,e.clientX+14)+"px"; tip.style.top=(e.clientY+16)+"px"; tip.classList.add("on");
  });
  mapEl.addEventListener("mouseleave",function(){tip.classList.remove("on")});
}
function updateMap(list){
  var t=totalLoad(), ids={}; list.forEach(function(c){ids[c.id]=1});
  mapEl.querySelectorAll(".mk").forEach(function(g){
    var c=BY[g.dataset.id];
    g.classList.toggle("dim",!ids[c.id]);
    g.classList.toggle("no",!!t&&!fits(c,t));
  });
  document.getElementById("mapfit").textContent=t?"Красная обводка — мощности не хватит":"";
}
function goTo(id){
  state.group=state.power=state.purpose=null; state.q=""; document.getElementById("q").value="";
  if(state.ver!=="all"&&!BY[id].vers[state.ver]) state.ver="all";
  state.only=false; render();
  var el=document.getElementById("card-"+id); if(!el) return;
  el.scrollIntoView({behavior:"smooth",block:"center"});
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}

/* ---- карточка ---- */
function priceOf(code){var p=PRICES[code]; return (typeof p==="number"&&p>0)?p:0}
function fmtPrice(p){return nf.format(p)+" "+SETTINGS.currency}
function priceHtml(code){
  var p=priceOf(code), h;
  if(p) h='<b>'+fmtPrice(p)+'</b><small class="dlv">'+SETTINGS.deliveryText+'</small>';
  else h='<span>'+SETTINGS.noPriceText+'</span>';
  if(SETTINGS.contactHref) h+='<a href="'+SETTINGS.contactHref+'">'+SETTINGS.contactLabel+'</a>';
  return '<div class="price">'+h+'</div>';
}
function cardHtml(c,t,open){
  var v=curVer(c), V=c.vers[v], rt=runtimeFor(c), ok=fits(c,t);
  var seg;
  if(c.vers.D&&c.vers.L){
    seg='<div class="vsw" role="group" aria-label="Вариант корпуса">'+["D","L"].map(function(k){
      var VV=c.vers[k], pr=priceOf(VV.code);
      return '<button type="button" class="vbtn" data-act="ver" data-id="'+c.id+'" data-v="'+k+'" aria-pressed="'+(k===v)+'">'+
        '<img src="'+VV.img+'" alt="" width="56" height="48" loading="lazy">'+
        '<span class="vt"><b>'+esc(D.versions[k].short)+'</b><span class="vp'+(pr?'':' none')+'">'+(pr?fmtPrice(pr):SETTINGS.noPriceText)+'</span>'+(pr?'<small class="dlv">'+SETTINGS.deliveryText+'</small>':'')+'</span>'+
        '<i class="tick" aria-hidden="true">✓</i></button>'}).join("")+'</div>';
  }else seg='<div class="only">'+(v==="D"?"Только тёмный корпус":"Только светлый на колёсах")+'</div>';
  var specs=[["Мощность",N(c.power)+" Вт"],["Ёмкость",N(c.cap)+" Вт·ч"],["Вес",V.net==null?"—":dec(V.net,1)+" кг"],["Размеры",V.size]];
  var sp='<dl class="specs">'+specs.map(function(s){return '<div><dt>'+s[0]+'</dt><dd>'+esc(s[1])+'</dd></div>'}).join("")+'</dl>';
  var l2='<p class="line2"><b>Розетки 220 В:</b> '+esc(V.sockets.join(" + "))+'<br><b>Постоянный ток:</b> '+esc(V.conn.join("; "))+'</p>';
  var tags=c.purposes.map(function(p){return '<span>'+esc(D.purposes[p])+'</span>'}).join("");
  var side;
  if(t){
    side=ok?'<div><h4>Хватит на</h4><div class="big">'+hoursText(c.cap*EFF/t)+'<small>при '+N(t)+' Вт</small></div></div>'
           :'<div><h4>Нагрузка '+N(t)+' Вт</h4><div class="hint">Мощности не хватит: максимум '+N(c.power)+' Вт.</div></div>';
  }else{
    var pick=rt.filter(function(r){return ["phone","laptop","fridge","kettle"].indexOf(r.l.key)>-1});
    side='<div><h4>На что хватает</h4><ul class="rt">'+pick.map(function(r){
      var nm=r.l.name.replace(" (средний расход)","").replace("Смартфон (полных зарядок)","Смартфон, зарядок");
      return '<li><span>'+esc(nm)+'</span><b>'+esc(r.text)+'</b></li>'}).join("")+'</ul></div>';
  }
  side+=priceHtml(V.code);
  var rows=V.rows.map(function(r){return '<tr><th>'+esc(r[0])+'</th><td>'+esc(r[1])+'</td></tr>'}).join("");
  var rtt='<h5>На что хватает (расчётная оценка)</h5><table>'+rt.map(function(r){
    return '<tr><th>'+esc(r.l.name+(r.l.watts?' ('+N(r.l.watts)+' Вт)':''))+'</th><td>'+esc(r.text)+'</td></tr>'}).join("")+'</table>';
  var fig='<figure class="fig"><h5>Порты и разъёмы (цифры на схеме)</h5><img src="'+V.diagram+'" alt="Схема портов и разъёмов: '+esc(c.title)+'" loading="lazy" width="900" height="'+V.dh+'"><ol>'+
    V.legend.map(function(g){return '<li><b>'+g.n+'</b><span>'+esc(g.ru)+'</span></li>'}).join("")+'</ol></figure>';
  var use='<h5>Для чего подходит</h5><ul>'+V.use.map(function(u){return '<li>'+esc(u)+'</li>'}).join("")+'</ul>';
  var lim=V.limits&&V.limits.length?'<h5>Ограничения</h5><ul class="warn">'+V.limits.map(function(u){return '<li>'+esc(u)+'</li>'}).join("")+'</ul>':'';
  return '<li class="card'+(ok?'':' off')+'" id="card-'+c.id+'" data-id="'+c.id+'">'+
   '<div class="main">'+
     '<div class="pic"><div class="ph"><img src="'+V.img+'" alt="'+esc(D.versions[v].name+': '+c.title)+'" loading="lazy" width="320" height="260"></div>'+seg+'</div>'+
     '<div class="info"><p class="grp">'+esc(c.group)+' · '+esc(V.design)+'</p>'+
       '<div class="hd"><h3>'+esc(c.title)+'</h3><span class="code">'+V.code+'</span></div>'+sp+l2+
       '<div class="tags">'+tags+'</div></div>'+
     '<div class="side">'+side+'</div>'+
   '</div>'+
   '<details class="more"'+(open?' open':'')+'><summary>Все характеристики, схема портов и расчёт</summary><div class="mbody"><div><h5>Характеристики</h5><table>'+rows+'</table></div><div>'+fig+use+lim+rtt+'</div></div></details>'+
  '</li>';
}

function sortVal(c,k,t){
  if(k.indexOf("cap")===0) return c.cap;
  if(k.indexOf("pow")===0) return c.power;
  if(k==="w-asc"){var w=c.vers[curVer(c)].net; return w==null?1e9:w;}
  if(k==="hours-desc"){var tt=t||60; return c.power>=tt?c.cap/tt:-1;}
  if(k.indexOf("price")===0) return priceOf(c.vers[curVer(c)].code);
  return 0;
}
function currentList(){
  var t=totalLoad();
  var list=baseList().filter(function(c){
    if(state.group&&c.group!==state.group) return false;
    if(state.power&&c.power!==state.power) return false;
    if(state.purpose&&c.purposes.indexOf(state.purpose)<0) return false;
    if(state.q){var q=state.q, hit=Object.keys(c.vers).some(function(k){return c.vers[k].code.toLowerCase().indexOf(q)>-1}); if(!hit&&c.title.toLowerCase().indexOf(q)<0) return false;}
    if(t&&state.only&&!fits(c,t)) return false;
    return true;
  });
  var k=state.sort, dir=(k.slice(-4)==="desc")?-1:1;
  var byPrice=k.indexOf("price")===0;
  list.sort(function(a,b){
    var va=sortVal(a,k,t), vb=sortVal(b,k,t);
    if(byPrice&&(!va||!vb)&&va!==vb) return va?-1:1; /* без цены всегда в конце */
    return (va-vb)*dir||(a.power-b.power)||(a.cap-b.cap)||a.id.localeCompare(b.id);
  });
  return list;
}
var listEl=document.getElementById("list"), rendered=false;
/* анимация появления только при первом показе: первые карточки с лёгкой задержкой, остальные перерисовки без неё */
function revealFirstCards(){
  if(!window.NEreveal||!document.documentElement.classList.contains("js")) return;
  var cards=Array.prototype.slice.call(listEl.querySelectorAll(".card"),0,6);
  cards.forEach(function(el,i){ el.classList.add("reveal"); el.style.transitionDelay=(i*70)+"ms"; });
  window.NEreveal(cards);
}
function render(){
  var t=totalLoad(), list=currentList();
  renderKinds(); renderPickrow(); renderFilters();
  var open={}; listEl.querySelectorAll("details[open]").forEach(function(d){open[d.parentNode.dataset.id]=1});
  listEl.innerHTML=list.length?list.map(function(c){return cardHtml(c,t,open[c.id])}).join(""):'<li class="empty">Ничего не найдено. Уберите часть приборов или фильтров.</li>';
  document.getElementById("pricenote").hidden=!list.some(function(c){return priceOf(c.vers[curVer(c)].code)>0});
  if(!rendered){ rendered=true; revealFirstCards(); }
  document.getElementById("count").textContent="Найдено: "+list.length+" из "+D.combos.length;
  updateMap(list);
}
/* плавная смена главного фото: прежняя картинка лежит сверху и гаснет (только opacity) */
function fadeFrom(ph,src){
  if(!ph||!src||(reduceMotion&&reduceMotion.matches)) return;
  var cur=ph.querySelector("img"); if(!cur||cur.getAttribute("src")===src) return;
  var g=document.createElement("img"); g.className="ghost"; g.src=src; g.alt=""; g.setAttribute("aria-hidden","true");
  ph.appendChild(g);
  requestAnimationFrame(function(){requestAnimationFrame(function(){g.style.opacity="0";});});
  setTimeout(function(){if(g.parentNode) g.parentNode.removeChild(g);},450);
}
listEl.addEventListener("click",function(e){
  var b=e.target.closest('button[data-act="ver"]'); if(!b) return;
  var c=BY[b.dataset.id], old=document.getElementById("card-"+c.id), open=old.querySelector("details").open;
  if(b.getAttribute("aria-pressed")==="true") return;
  var oldImg=old.querySelector(".ph img"), oldSrc=oldImg&&oldImg.getAttribute("src");
  state.cv[c.id]=b.dataset.v; old.outerHTML=cardHtml(c,totalLoad(),open);
  var nb=document.querySelector('#card-'+c.id+' button[data-v="'+b.dataset.v+'"]'); if(nb) nb.focus();
  fadeFrom(document.querySelector('#card-'+c.id+' .ph'),oldSrc);
});
document.getElementById("q").addEventListener("input",function(e){state.q=e.target.value.trim().toLowerCase();render();});
document.getElementById("sort").addEventListener("change",function(e){state.sort=e.target.value;render();});

/* словарь */
document.getElementById("gl").innerHTML=D.glossary.map(function(g){return '<dt>'+esc(g[0])+'</dt><dd>'+esc(g[1])+'</dd>'}).join("");

/* hero: «от N ₽ с доставкой» — минимум среди ненулевых цен; нет цен — строка скрыта */
(function(){
  var prices=[];
  D.combos.forEach(function(c){Object.keys(c.vers).forEach(function(k){var p=priceOf(c.vers[k].code); if(p) prices.push(p)})});
  var any=prices.length>0;
  if(any){
    document.getElementById("heroFromPrice").textContent=fmtPrice(Math.min.apply(null,prices));
    document.getElementById("heroFrom").hidden=false;
  }
  document.getElementById("footprice").hidden=!any;
})();

/* hero: числа счётчиков берутся из DATA (в HTML для случая без JS стоят те же значения) */
(function(){
  var cyc=3500, plus="+";
  D.combos.some(function(c){return Object.keys(c.vers).some(function(k){
    return c.vers[k].rows.some(function(r){
      var m=r[0]==="Ресурс батареи"&&/(\d+)\s*(\+?)/.exec(r[1]); if(!m) return false;
      cyc=+m[1]; plus=m[2]; return true;
    });
  })});
  var vals={combos:[D.combos.length,""],bodies:[Object.keys(D.versions).length,""],cycles:[cyc,plus]};
  Array.prototype.forEach.call(document.querySelectorAll("[data-fact]"),function(el){
    var v=vals[el.dataset.fact]; if(!v) return;
    var to=v[0], suf=v[1];
    el.textContent=to+suf;
    if((reduceMotion&&reduceMotion.matches)||!window.requestAnimationFrame) return;
    var t0=null, dur=900;
    el.textContent="0"+suf;
    requestAnimationFrame(function step(ts){
      if(t0===null) t0=ts;
      var k=Math.min(1,(ts-t0)/dur);
      el.textContent=(k<1?Math.round(to*(1-Math.pow(1-k,3))):to)+suf;
      if(k<1) requestAnimationFrame(step);
    });
  });
})();

/* липкая полоса: тень и уменьшение названия после прокрутки */
(function(){
  var bar=document.getElementById("top"), on=false, tick=false;
  function upd(){tick=false; var y=window.pageYOffset>8; if(y!==on){on=y; bar.classList.toggle("scrolled",on);}}
  window.addEventListener("scroll",function(){if(!tick){tick=true; requestAnimationFrame(upd);}},{passive:true});
  upd();
})();

buildMap(); render();
})();
