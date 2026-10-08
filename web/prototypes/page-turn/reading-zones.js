// Independent interaction policy: focus, chrome dismissal, and blank-page taps.
// All navigation still uses the reader's canonical turn() and source anchors.
export function installReadingZones({turn,finishTurn,closeTransient,transientOpen,panelOpen}) {
  const chrome=document.getElementById('reader-chrome');
  const trigger=document.getElementById('show-tools');
  const stage=document.getElementById('stage');
  let pointer=null,released=null;
  const focusTrigger=()=>trigger.focus({preventScroll:true});
  function close(restoreFocus=true){
    chrome.hidden=true;trigger.hidden=false;stage.inert=false;
    trigger.setAttribute('aria-expanded','false');document.body.dataset.chrome='closed';
    if(restoreFocus)focusTrigger();
  }
  function open(){
    if(panelOpen())return;
    finishTurn();closeTransient();chrome.hidden=false;trigger.hidden=true;stage.inert=true;
    trigger.setAttribute('aria-expanded','true');document.body.dataset.chrome='open';
    document.getElementById('fullscreen').focus({preventScroll:true});
  }
  const consume=e=>{e.preventDefault();e.stopImmediatePropagation();};
  // Range rectangles include visible punctuation outside the .word spans, but
  // exclude line/paragraph gaps. The paragraph's entire box is not a tap shield.
  function onInk(target,x,y){
    if(target.closest('.word,.gloss,.syntax,#translation'))return true;
    const text=target.closest('.fragment p,.fragment h1,.chapter-kicker,.page-heading,.page-number');
    if(!text)return false;
    const range=document.createRange();range.selectNodeContents(text);
    return Array.from(range.getClientRects()).some(r=>r.width>0&&r.height>0&&x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom);
  }
  document.addEventListener('pointerdown',e=>{
    released=null;pointer={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};
  },true);
  document.addEventListener('pointermove',e=>{
    if(pointer?.id===e.pointerId&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>6)pointer.moved=true;
  },true);
  document.addEventListener('pointerup',e=>{
    if(pointer?.id===e.pointerId)released=pointer;pointer=null;
  },true);
  document.addEventListener('pointercancel',()=>{pointer=null;released=null;},true);
  document.addEventListener('click',e=>{
    const target=e.target instanceof Element?e.target:e.target.parentElement;
    const gesture=released;released=null;
    // A drag release may create a selection panel later in pointerup. Never
    // dismiss that panel or flip the page with the following compatibility click.
    if(gesture?.moved&&!target.closest('input,textarea,select')){consume(e);return;}
    if(!chrome.hidden){
      if(target.closest('#reader-chrome button:not(#chrome-dismiss),#reader-chrome a')){
        // Let the tool open its panel while its anchor still has a real rectangle,
        // then dismiss the chrome in the same event turn. No click passes to prose.
        queueMicrotask(()=>close(false));
      }else{close();consume(e);}
      return;
    }
    if(target.closest('#show-tools')){open();consume(e);return;}
    if(panelOpen()||target.closest('#popover,#word-pop,#selection,#translation,.syntax,button,a,input,textarea,select'))return;
    if(transientOpen()){closeTransient();consume(e);return;}
    if(window.getSelection()?.toString().trim()||e.detail!==1||onInk(target,e.clientX,e.clientY))return;
    // Top band has a dedicated accessible trigger. All remaining blank space
    // follows the screen midpoint, in both single and double-page layouts.
    consume(e);turn(e.clientX<innerWidth/2?-1:1);
  },true);
  document.addEventListener('keydown',e=>{
    if(!chrome.hidden&&e.key==='Escape'){close();consume(e);}
  },true);
  close(false);
  return {open,close,isOpen:()=>!chrome.hidden,focusTrigger};
}
