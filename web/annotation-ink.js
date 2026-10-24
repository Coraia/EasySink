// Shared by exposure receipts and opt-in evidence: inspect the displayed ink,
// including compositor glyphs, rather than the hidden canonical source.
export function annotationInk({text = false} = {}) {
  const shown = new Map(), opacity = new Map();
  const visible = node => {
    const r = node.getBoundingClientRect(), style = getComputedStyle(node);
    if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') return false;
    const clip = node.closest('.page-leaf')?.getBoundingClientRect() || document.querySelector('#article').getBoundingClientRect();
    return r.right > Math.max(0,clip.left) && r.left < Math.min(innerWidth,clip.right) &&
      r.bottom > Math.max(0,clip.top) && r.top < Math.min(innerHeight,clip.bottom);
  };
  const add = (index,node,key) => {
    if (!Number.isInteger(index) || !visible(node)) return;
    if (!shown.has(index)) shown.set(index,new Map());
    if (text) shown.get(index).set(key,node.textContent);
  };
  for (const node of document.querySelectorAll('#article [data-annotation]')) {
    const index = +node.dataset.annotation;
    if (!text && shown.has(index)) continue;
    const gloss = node.matches('.gloss') ? node : node.querySelector('.gloss');
    if (gloss && !gloss.classList.contains('reflow-moving')) add(index,gloss,gloss.dataset.reflowKey || 'whole');
  }
  for (const glyph of document.querySelectorAll('#article [data-reflow-annotation]')) {
    const index = +glyph.dataset.reflowAnnotation;
    if (!text && shown.has(index)) continue;
    const group = glyph.closest('.reflow-motion-group'), root = glyph.closest('.annotation-reflow-ghosts');
    for (const node of [group,root]) if (!opacity.has(node)) opacity.set(node,+getComputedStyle(node).opacity);
    if (opacity.get(group)*opacity.get(root) > .25) add(index,glyph,glyph.dataset.reflowVisual);
  }
  return new Map([...shown].map(([index,parts])=>[index,text ?
    (parts.get('whole') ?? [...parts].sort(([a],[b])=>+a.slice(a.lastIndexOf(':')+1)-+b.slice(b.lastIndexOf(':')+1)).map(([,value])=>value).join('').replace(/^〈|〉$/g,'')) : true]));
}
