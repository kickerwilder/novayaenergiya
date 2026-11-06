/* Появление блоков при прокрутке: IntersectionObserver, только opacity и transform.
   Скрытое состояние (.js .reveal) включает inline-скрипт в <head>; без JS всё видно.
   window.NEreveal(elements) подключает к наблюдению элементы, добавленные позже (первые карточки каталога). */
(function(){
"use strict";
var mq=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)");
var reduced=!!(mq&&mq.matches);
var io=null;

function done(el){
  el.classList.add("in");
  /* после показа убираем служебные классы, чтобы они не мешали другим стилям (например, .card.off) */
  var clean=function(e){
    if(e&&e.target!==el) return;
    el.removeEventListener("transitionend",clean);
    el.classList.remove("reveal","in"); el.style.transitionDelay="";
  };
  if(reduced) clean(); else el.addEventListener("transitionend",clean);
}

if(!reduced&&"IntersectionObserver" in window){
  io=new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if(!en.isIntersecting) return;
      io.unobserve(en.target); done(en.target);
    });
  },{threshold:0,rootMargin:"0px 0px -8% 0px"});
}

function watch(list){
  Array.prototype.forEach.call(list,function(el){
    if(io) io.observe(el); else done(el);
  });
}
window.NEreveal=watch;
watch(document.querySelectorAll(".reveal"));
window.__revealOK=true;
})();
