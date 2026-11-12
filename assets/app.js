/* ===================== SETTINGS ===================== */
const SETTINGS = {
  currency: "₽",                 // знак валюты
  noPriceText: "Цена по запросу",
  deliveryText: "с доставкой",   // подпись рядом с каждой ценой (цены включают доставку)
  warrantyText: "Гарантия 6 месяцев. Продление до 12 месяцев: +10 000 ₽", // показывается под ценой и рядом со сроком доставки
  warrantyExtra: 10000,          // доплата за продление гарантии, ₽ (основная цена не меняется)
  contactLabel: "Позвонить",
  contactHref: "tel:+79787280002" // основной контакт; например "https://t.me/ваш_ник"; пусто = кнопка скрыта
};

/* Адрес бэкенда чата-консультанта (например "https://bot.example.ru"). Пусто: чат не показывается, сайт работает без бэкенда.
   Для локальной проверки без правки файла: открыть страницу с ?chat=local (порт 8787) или ?chat=local:ПОРТ. */
const CHAT_URL = "";

(function(){
"use strict";
var D=DATA, EFF=D.eff, PH=D.phone_wh;
var nf=new Intl.NumberFormat("ru-RU");
var reduceMotion=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)");
var C=NECalc; /* расчёты вынесены в assets/calc.js (общий модуль сайта и бота) */
var N=C.N, dec=C.dec, hoursText=C.hoursText;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function kwh(w){return dec(w/1000,1)}
var state={ver:"all",group:null,power:null,purpose:null,q:"",sort:"cap-asc",sel:{},only:true,cv:{}};
var BY={}; D.combos.forEach(function(c){BY[c.id]=c});
function curVer(c){
  var v=state.cv[c.id];
  if(v&&c.vers[v]) return v;
  if(state.ver!=="all"&&c.vers[state.ver]) return state.ver;
  return c.vers.D?"D":"L";
}
/* подбор по приборам и время работы: assets/calc.js */
var lw=C.loadWatts, la=C.loadAvg, peakOf=C.peakOf, fits=C.fits;
function selInfo(){return C.selection(D.loads,state.sel)}
function runtimeFor(c){return C.runtimeFor(c,D.loads,EFF,PH)}

/* ---- версии (шапка): «Все» / «Тёмный» / «Светлый на колёсах» ---- */
var kindsEl=document.getElementById("kinds"), hkEl=document.getElementById("hkinds");
var plural=C.plural;
var KINDS=[
  {key:"all",title:"Все",act:"Показать все варианты"},
  {key:"D",title:"Тёмный корпус",act:"Показать только тёмные"},
  {key:"L",title:"Светлый на колёсах",act:"Показать только светлые"}
];
function kindCount(k){return D.combos.filter(function(c){return k==="all"||c.vers[k]}).length}
function kindCountText(k){var n=kindCount(k); return k==="all"?n+" "+plural(n,["модель","модели","моделей"]):n+" из "+D.combos.length}
function bothCount(){return D.combos.filter(function(c){return c.vers.D&&c.vers.L}).length}
function setVer(key){state.ver=key;state.cv={};render();}
function kindPic(key,cls){
  var im=function(k){return '<img src="'+D.photos[k]+'" alt="" width="1200" height="896" loading="lazy">'};
  return key==="all"?'<span class="'+cls+' duo">'+im("D")+im("L")+'</span>':'<span class="'+cls+'">'+im(key)+'</span>';
}
function renderKinds(){
  if(!kindsEl.children.length){ /* строится один раз: счётчики из DATA, фокус не теряется при перерисовках */
    KINDS.forEach(function(k){
      var cnt=kindCountText(k.key);
      var b=document.createElement("button"); b.type="button"; b.className="kind"; b.dataset.kind=k.key;
      b.innerHTML=kindPic(k.key,"kpic")+'<span class="kt"><b>'+k.title+'</b><span class="ka">'+k.act+'</span><span class="kn">'+cnt+'</span></span>';
      b.addEventListener("click",function(){setVer(k.key)});
      kindsEl.appendChild(b);
      if(hkEl){
        var h=document.createElement("button"); h.type="button"; h.className="hk"; h.dataset.kind=k.key;
        h.setAttribute("aria-label",k.act+" ("+cnt+(k.key==="all"?"":" моделей")+")");
        h.innerHTML=kindPic(k.key,"hpic")+'<span class="ht">'+(k.key==="all"?"Все":D.versions[k.key].short)+'</span>';
        h.addEventListener("click",function(){setVer(k.key)});
        hkEl.appendChild(h);
      }
    });
  }
  var note=document.getElementById("kindsNote");
  if(note&&!note.textContent){var nb=bothCount(); note.textContent=nb+" "+plural(nb,["модель есть","модели есть","моделей есть"])+" в обоих корпусах";}
  [kindsEl,hkEl].forEach(function(box){ if(!box) return;
    Array.prototype.forEach.call(box.children,function(b){b.setAttribute("aria-pressed",state.ver===b.dataset.kind?"true":"false")});
  });
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
  var S=selInfo(), t=S.t;
  pickrow.innerHTML="";
  var s=document.createElement("span"); s.className="total";
  if(!S.any){ s.textContent="Ничего не выбрано — показаны все модели."; pickrow.appendChild(s); return; }
  s.innerHTML="Суммарная нагрузка:<b>"+N(t)+"</b>Вт"+(S.start?'<span class="startn">пусковая нагрузка до '+N(S.start)+' Вт</span>':""); pickrow.appendChild(s);
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
/* ---- карта моделей: «гармошка» по группам ёмкости (одна открыта за раз) ---- */
var accEl=document.getElementById("macc"), accBtns=[];
var rangeText=C.rangeText;
function minPrice(c){
  var m=0; Object.keys(c.vers).forEach(function(k){var p=priceOf(c.vers[k].code); if(p&&(!m||p<m)) m=p;}); return m;
}
function buildAcc(){
  if(!accEl) return;
  var fr=D.loads.filter(function(l){return l.key==="fridge"})[0];
  accEl.innerHTML="";
  D.groups.forEach(function(g,gi){
    var cs=D.combos.filter(function(c){return c.group===g}); if(!cs.length) return;
    var pr=cs.map(minPrice).filter(Boolean), caps=cs.map(function(c){return c.cap});
    var head=[g, cs.length+" "+plural(cs.length,["модель","модели","моделей"])];
    if(pr.length) head.push("от "+fmtPrice(Math.min.apply(null,pr)));
    if(fr) head.push("холодильника хватит на "+rangeText(Math.min.apply(null,caps)*EFF/la(fr),Math.max.apply(null,caps)*EFF/la(fr)));
    var item=document.createElement("div"); item.className="ac";
    var bid="acb-"+gi, pid="acp-"+gi;
    var h=document.createElement("button"); h.type="button"; h.className="ac-h"; h.id=bid; h.setAttribute("aria-expanded","false"); h.setAttribute("aria-controls",pid);
    h.innerHTML='<span class="ac-t"><b>'+esc(g)+'</b><span>'+esc(head.slice(1).join(", "))+'</span></span><i class="ac-i" aria-hidden="true"></i>';
    h.setAttribute("aria-label",head.join(", "));
    var panel=document.createElement("div"); panel.className="ac-p"; panel.id=pid; panel.hidden=true; panel.setAttribute("role","region"); panel.setAttribute("aria-labelledby",bid);
    var capList=[]; caps.forEach(function(x){ if(capList.indexOf(x)<0) capList.push(x); }); capList.sort(function(a,b){return a-b});
    capList.forEach(function(cap){
      var row=document.createElement("div"); row.className="ac-r";
      row.innerHTML='<div class="ac-c">'+kwh(cap)+' кВт·ч</div>';
      var btns=document.createElement("div"); btns.className="ac-b";
      cs.filter(function(c){return c.cap===cap}).sort(function(a,b){return a.power-b.power}).forEach(function(c){
        var both=c.vers.D&&c.vers.L, body=both?"оба":(c.vers.D?"тёмный":"светлый"), p=minPrice(c);
        var b=document.createElement("button"); b.type="button"; b.className="ac-m"; b.dataset.id=c.id;
        b.innerHTML='<b>'+N(c.power)+' Вт</b><span>'+body+'</span><span>'+(p?'от '+fmtPrice(p):SETTINGS.noPriceText.toLowerCase())+'</span>'+(fr?'<span>холодильник '+hoursText(c.cap*EFF/la(fr))+'</span>':'')+'<em hidden>не хватит мощности</em>';
        b.addEventListener("click",function(){goTo(c.id)});
        btns.appendChild(b); accBtns.push(b);
      });
      row.appendChild(btns); panel.appendChild(row);
    });
    h.addEventListener("click",function(){ /* открыта одна группа за раз */
      var open=h.getAttribute("aria-expanded")!=="true";
      accEl.querySelectorAll(".ac-h").forEach(function(x){
        var on=open&&x===h; x.setAttribute("aria-expanded",on?"true":"false");
        document.getElementById(x.getAttribute("aria-controls")).hidden=!on;
      });
    });
    item.appendChild(h); item.appendChild(panel); accEl.appendChild(item);
  });
}
function updateAcc(S){
  accBtns.forEach(function(b){
    var bad=S.any&&!fits(BY[b.dataset.id],S);
    b.classList.toggle("no",bad); b.querySelector("em").hidden=!bad;
  });
}
/* переход к карточке по коду версии (Z2800-3800-L): нужная версия корпуса включается, карточка подсвечивается */
function goToCode(code){
  var id=String(code).replace(/-[DL]$/,""), ver=String(code).slice(-1);
  if(!BY[id]) return;
  goTo(id);
  var b=document.querySelector('#card-'+id+' .vbtn[data-v="'+ver+'"]');
  if(b&&b.getAttribute("aria-pressed")!=="true"){
    b.click();
    var el=document.getElementById("card-"+id); if(el){el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");}
  }
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
  if(SETTINGS.warrantyText) h+='<small class="wty">'+esc(SETTINGS.warrantyText)+'</small>';
  if(SETTINGS.contactHref) h+='<a href="'+SETTINGS.contactHref+'">'+SETTINGS.contactLabel+'</a>';
  return '<div class="price">'+h+'</div>';
}
/* зарядка: расчёты в assets/calc.js; диапазоны ориентировочных данных пишет scripts/update_charge_estimates.py */
function chargeTimesOf(V,c){return C.chargeTimes(c.cap,(typeof CHARGE!=="undefined")&&CHARGE[V.code])}
function chargeHtml(V,c){
  var ct=chargeTimesOf(V,c), li=[];
  if(ct){
    var tx=C.chargeText(ct);
    li.push('Время зарядки от сети 220 В: до 80 % — '+tx.t80+', до 100 % — '+tx.t100+(tx.approx?' (ориентировочно)':''));
  }else li.push('Время зарядки уточняется');
  var hasAnd=V.conn.some(function(x){return /Anderson/i.test(x)});
  li.push('Через разъёмы XT90 (до 30 А)'+(hasAnd?' и Anderson (до 50 А)':'')+'; солнечные панели — только через внешний MPPT-контроллер');
  li.push('Зарядка возможна при температуре воздуха 0…+45 °C');
  return li;
}
/* alt фото версии корпуса: по файлу фото различаем «ящик» и «шкаф» */
function bodyAlt(V,v){
  if(v==="L") return "Светлая портативная электростанция на колёсах с выдвижной ручкой";
  return V.img.indexOf("cabinet")>-1?"Тёмная портативная электростанция в корпусе-шкафу на колёсиках с четырьмя розетками":"Тёмная портативная электростанция с четырьмя розетками на лицевой панели";
}
function cardHtml(c,S,open){
  open=open||{};
  var t=S.t, v=curVer(c), V=c.vers[v], rt=runtimeFor(c), ok=fits(c,S), ms=V.maxSocket;
  var seg;
  if(c.vers.D&&c.vers.L){
    seg='<div class="vsw" role="group" aria-label="Вариант корпуса">'+["D","L"].map(function(k){
      var VV=c.vers[k], pr=priceOf(VV.code);
      return '<button type="button" class="vbtn" data-act="ver" data-id="'+c.id+'" data-v="'+k+'" aria-pressed="'+(k===v)+'">'+
        '<img src="'+VV.img+'" alt="" width="1200" height="896" loading="lazy">'+
        '<span class="vt"><b>'+esc(D.versions[k].short)+'</b><span class="vp'+(pr?'':' none')+'">'+(pr?fmtPrice(pr):SETTINGS.noPriceText)+'</span>'+(pr?'<small class="dlv">'+SETTINGS.deliveryText+'</small>':'')+'</span>'+
        '<i class="tick" aria-hidden="true">✓</i></button>'}).join("")+'</div>';
  }else seg='<div class="only">'+(v==="D"?"Только тёмный корпус":"Только светлый на колёсах")+'</div>';
  var specs=[["Мощность",N(c.power)+" Вт"],["Ёмкость",N(c.cap)+" Вт·ч"],["Вес",V.net==null?"—":dec(V.net,1)+" кг"],["Размеры",V.size]];
  var sp='<dl class="specs">'+specs.map(function(s){return '<div><dt>'+s[0]+'</dt><dd>'+esc(s[1])+'</dd></div>'}).join("")+'</dl>';
  var l2='<p class="line2"><b>Розетки 220 В:</b> '+esc(V.sockets.join(" + "))+'<br><b>Постоянный ток:</b> '+esc(V.conn.join("; "))+(ms?'<br><b>Мощность одной розетки:</b> до '+N(ms)+' Вт':'')+'</p>';
  var tags=c.purposes.map(function(p){return '<span>'+esc(D.purposes[p])+'</span>'}).join("");
  var side;
  if(S.any){
    if(ok){
      side='<div><h4>Хватит на</h4><div class="big">'+hoursText(c.cap*EFF/S.avg)+'<small>при средней нагрузке '+N(S.avg)+' Вт</small></div>'+
        (ms&&t>ms?'<div class="hint">Нагрузка больше, чем выдержит одна розетка (до '+N(ms)+' Вт): включайте приборы в разные розетки.</div>':'')+'</div>';
    }else{
      var why=c.power<t?'Мощности не хватит: максимум '+N(c.power)+' Вт.':'Не хватит пиковой мощности: пусковая нагрузка до '+N(S.start)+' Вт, у станции пик до '+N(peakOf(c))+' Вт.';
      side='<div><h4>Нагрузка '+N(t)+' Вт</h4><div class="hint">'+why+'</div></div>';
    }
  }else{
    var pick=rt.filter(function(r){return ["phone","laptop","fridge","kettle"].indexOf(r.l.key)>-1});
    side='<div><h4>На что хватает</h4><ul class="rt">'+pick.map(function(r){
      var nm=r.l.name.replace("Смартфон (полных зарядок)","Смартфон, зарядок");
      return '<li><span>'+esc(nm)+'</span><b>'+esc(r.text)+'</b></li>'}).join("")+'</ul></div>';
  }
  side+=priceHtml(V.code);
  var rows=V.rows.map(function(r){return '<tr><th>'+esc(r[0])+'</th><td>'+esc(r[1])+'</td></tr>'}).join("");
  var rtt='<h5>На что хватает (расчётная оценка)</h5><table>'+rt.map(function(r){
    var w=r.l.watts?' ('+N(r.l.watts)+' Вт'+(r.l.avg&&r.l.avg!==r.l.watts?', в среднем '+N(r.l.avg)+' Вт':'')+')':'';
    var tx=C.tableText(r);
    return '<tr><th>'+esc(r.l.name+w)+'</th><td'+(r.ok?'':' class="no"')+'>'+esc(tx)+'</td></tr>'}).join("")+'</table>'+
    '<p class="fn">Время расчётное. Не учитывает собственное потребление станции при включённом инверторе (по паспорту изделия до 50 Вт): у приборов до 100 Вт фактическое время может быть меньше. Мелкие устройства лучше заряжать через USB.</p>';
  var saf=D.safety&&D.safety.length?'<h5>Безопасность</h5><ul class="warn">'+D.safety.map(function(u){return '<li>'+esc(u)+'</li>'}).join("")+'</ul>':'';
  var chg='<details class="more chg"'+(open.c?' open':'')+'><summary>Зарядка</summary><div class="cbody"><ul>'+chargeHtml(V,c).map(function(u){return '<li>'+esc(u)+'</li>'}).join("")+'</ul>'+((chargeTimesOf(V,c)||{}).estimate?'<p class="fn">Ориентировочное время по аналогичным моделям; точное уточним при заказе.</p>':'')+'</div></details>';
  var fig='<figure class="fig"><h5>Порты и разъёмы (цифры на схеме)</h5><img src="'+V.diagram+'" alt="Схема портов и разъёмов: '+esc(c.title)+'" loading="lazy" width="900" height="'+V.dh+'"><ol>'+
    V.legend.map(function(g){return '<li><b>'+g.n+'</b><span>'+esc(g.ru)+'</span></li>'}).join("")+'</ol></figure>';
  var use='<h5>Для чего подходит</h5><ul>'+V.use.map(function(u){return '<li>'+esc(u)+'</li>'}).join("")+'</ul>';
  var lim=V.limits&&V.limits.length?'<h5>Ограничения</h5><ul class="warn">'+V.limits.map(function(u){return '<li>'+esc(u)+'</li>'}).join("")+'</ul>':'';
  return '<li class="card'+(ok?'':' off')+'" id="card-'+c.id+'" data-id="'+c.id+'">'+
   '<div class="main">'+
     '<div class="pic"><div class="ph"><img src="'+V.img+'" alt="'+esc(bodyAlt(V,v)+': '+c.title)+'" loading="lazy" width="1200" height="896"></div>'+seg+'</div>'+
     '<div class="info"><p class="grp">'+esc(c.group)+' · '+esc(V.design)+'</p>'+
       '<div class="hd"><h3>'+esc(c.title)+'</h3><span class="code">'+V.code+'</span></div>'+sp+l2+
       '<div class="tags">'+tags+'</div></div>'+
     '<div class="side">'+side+'</div>'+
   '</div>'+
   '<details class="more mx"'+(open.m?' open':'')+'><summary>Все характеристики, схема портов и расчёт</summary><div class="mbody"><div><h5>Характеристики</h5><table>'+rows+'</table></div><div>'+fig+use+lim+saf+rtt+'</div></div></details>'+chg+
  '</li>';
}

function sortVal(c,k,t){
  if(k.indexOf("cap")===0) return c.cap;
  if(k.indexOf("pow")===0) return c.power;
  if(k==="w-asc"){var w=c.vers[curVer(c)].net; return w==null?1e9:w;}
  if(k==="hours-desc"){return fits(c,t)?c.cap/(t.any?t.avg:la(D.loads.filter(function(l){return l.key==="laptop"})[0])):-1;}
  if(k.indexOf("price")===0) return priceOf(c.vers[curVer(c)].code);
  return 0;
}
function currentList(){
  var t=selInfo();
  var list=baseList().filter(function(c){
    if(state.group&&c.group!==state.group) return false;
    if(state.power&&c.power!==state.power) return false;
    if(state.purpose&&c.purposes.indexOf(state.purpose)<0) return false;
    if(state.q){var q=state.q, hit=Object.keys(c.vers).some(function(k){return c.vers[k].code.toLowerCase().indexOf(q)>-1}); if(!hit&&c.title.toLowerCase().indexOf(q)<0) return false;}
    if(t.any&&state.only&&!fits(c,t)) return false;
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
  var t=selInfo(), list=currentList();
  renderKinds(); renderPickrow(); renderFilters();
  var open={}; listEl.querySelectorAll("details[open]").forEach(function(d){var id=d.parentNode.dataset.id; (open[id]=open[id]||{})[d.classList.contains("chg")?"c":"m"]=1});
  listEl.innerHTML=list.length?list.map(function(c){return cardHtml(c,t,open[c.id])}).join(""):'<li class="empty">Ничего не найдено. Уберите часть приборов или фильтров.</li>';
  document.getElementById("pricenote").hidden=!list.some(function(c){return priceOf(c.vers[curVer(c)].code)>0});
  if(!rendered){ rendered=true; revealFirstCards(); }
  document.getElementById("count").textContent="Найдено: "+list.length+" из "+D.combos.length;
  updateAcc(selInfo());
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
  var c=BY[b.dataset.id], old=document.getElementById("card-"+c.id), open={m:old.querySelector("details.mx").open,c:old.querySelector("details.chg").open};
  if(b.getAttribute("aria-pressed")==="true") return;
  var oldImg=old.querySelector(".ph img"), oldSrc=oldImg&&oldImg.getAttribute("src");
  state.cv[c.id]=b.dataset.v; old.outerHTML=cardHtml(c,selInfo(),open);
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
  Array.prototype.forEach.call(document.querySelectorAll("[data-warranty]"),function(el){ if(SETTINGS.warrantyText) el.textContent=SETTINGS.warrantyText; });
})();

/* hero: числа счётчиков берутся из DATA (в HTML для случая без JS стоят те же значения) */
(function(){
  var cyc=2000, plus="+";
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

/* компьютер (мышь): клик по tel: копирует номер и показывает уведомление; на телефонах и без JS ссылка работает как есть */
(function(){
  if(!window.matchMedia||!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  var toast=null, timer=0;
  function fmt(h){
    var d=h.replace(/\D/g,"");
    return d.length===11?"+"+d[0]+" "+d.slice(1,4)+" "+d.slice(4,7)+"-"+d.slice(7,9)+"-"+d.slice(9):"+"+d;
  }
  function copy(text){
    if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){
      return navigator.clipboard.writeText(text).catch(function(){return fallback(text);});
    }
    return Promise.resolve(fallback(text));
  }
  function fallback(text){
    var ta=document.createElement("textarea"), ok=false;
    ta.value=text; ta.setAttribute("readonly",""); ta.setAttribute("aria-hidden","true");
    ta.style.cssText="position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta); ta.select();
    try{ok=document.execCommand("copy");}catch(e){}
    document.body.removeChild(ta);
    if(!ok) throw new Error("copy failed");
  }
  function show(msg){
    if(!toast){
      toast=document.createElement("div");
      toast.className="toast"; toast.setAttribute("role","status"); toast.setAttribute("aria-live","polite");
      document.body.appendChild(toast);
    }
    clearTimeout(timer);
    toast.textContent=msg;
    void toast.offsetWidth;
    toast.classList.add("on");
    timer=setTimeout(function(){toast.classList.remove("on");},3000);
  }
  document.addEventListener("click",function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey) return;
    var a=e.target.closest&&e.target.closest('a[href^="tel:"]');
    if(!a) return;
    e.preventDefault();
    var num=fmt(a.getAttribute("href").slice(4));
    Promise.resolve().then(function(){return copy(num);}).then(
      function(){show("Номер скопирован: "+num);},
      function(){show("Не удалось скопировать. Номер: "+num);}
    );
  });
})();

/* hero-видео: адрес файла лежит в data-src и подставляется скриптом, поэтому без JS, при prefers-reduced-motion
   и при экономии трафика (saveData) файл не загружается и виден постер. Вне экрана видео стоит на паузе. */
(function(){
  var v=document.getElementById("heroVideo"); if(!v) return;
  var rm=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)"), sd=navigator.connection&&navigator.connection.saveData;
  function allowed(){return !(rm&&rm.matches)&&!sd}
  if(!allowed()){ v.removeAttribute("autoplay"); return; }
  v.src=v.getAttribute("data-src");
  if(!("IntersectionObserver" in window)) return;
  new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(e.isIntersecting&&allowed()){ var p=v.play(); if(p&&p.catch) p.catch(function(){}); }
      else v.pause();
    });
  },{threshold:0.15}).observe(v);
})();

/* чат-консультант: кнопка создаётся сразу, сам виджет (assets/chat.js) подгружается лениво: на простое страницы или по нажатию */
(function(){
  var url=CHAT_URL, m=/[?&]chat=local(?::(\d+))?(?:&|$)/.exec(location.search);
  if(m) url="http://localhost:"+(m[1]||"8787");
  if(!url) return;
  document.body.classList.add("has-chat");
  var btn=document.createElement("button");
  btn.type="button"; btn.className="chat-fab"; btn.id="chatFab"; btn.setAttribute("aria-haspopup","dialog"); btn.setAttribute("aria-expanded","false"); btn.setAttribute("aria-controls","chatPanel");
  btn.innerHTML='<svg class="chat-fab-ic" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="currentColor"/></svg><span>Подобрать станцию в чате</span>';
  document.body.appendChild(btn);
  var waiting=null;
  function load(cb){
    if(window.NEchat){cb(); return;}
    if(waiting){waiting.push(cb); return;}
    waiting=[cb];
    var sc=document.createElement("script"); sc.src="assets/chat.js";
    sc.onload=function(){ window.NEchat.init({url:url,button:btn,goToCode:goToCode,fmtPrice:fmtPrice}); var q=waiting; waiting=null; q.forEach(function(f){f()}); };
    sc.onerror=function(){ waiting=null; btn.hidden=true; };
    document.head.appendChild(sc);
  }
  btn.addEventListener("click",function(){ load(function(){window.NEchat.toggle()}); });
  if("requestIdleCallback" in window) requestIdleCallback(function(){load(function(){})},{timeout:8000});
  else setTimeout(function(){load(function(){})},5000);
})();

buildAcc(); render();
})();
