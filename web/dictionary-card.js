import { e } from "./core.js";

const usableSenses = dictionary => (Array.isArray(dictionary?.senses) ? dictionary.senses : [])
  .filter(sense => typeof sense?.text === "string" && sense.text.trim());

// Cross-occurrence feedback uses source dictionary definitions only. A raw
// label such as "n." and an adopted occurrence explanation are not definitions.
export function dictionaryAnnotationNote(item) {
  if (item.dictionary) {
    const senses = usableSenses(item.dictionary);
    return (senses.find(sense => sense.language === "zh") || senses[0])?.text.trim() || "";
  }
  // Inline notes can be stale or just a raw part-of-speech label. Their lookup
  // publishes dictionary-record when structured definitions become available.
  return "";
}

// These are source dictionary candidates, never an inferred contextual sense.
// Keep Chinese and English lines independent: ECDICT does not align them.
export function renderDictionaryCard(pop, item) {
  const dictionary = item.dictionary;
  if (!dictionary || !pop.isConnected) return;
  let body = pop.querySelector(".dictionary-candidates");
  if (!body) {
    body = document.createElement("section");
    body.className = "dictionary-candidates";
    pop.querySelector(".meaning").after(body);
  }
  const senses = usableSenses(dictionary);
  const chinese = senses.filter(sense => sense.language === "zh");
  const english = senses.filter(sense => sense.language === "en");
  const retained = item.source === "context-retained" || item.source === "model";
  const meaning = pop.querySelector(".meaning");
  meaning.hidden = !retained;
  const oldDetail = pop.querySelector(".word-gloss-detail") || pop.querySelector(":scope > p.muted");
  if (oldDetail) oldDetail.hidden = !retained;
  const line = sense => {
    const labels = [...new Set([sense.pos, ...(sense.labels || []), ...(sense.domains || [])].filter(Boolean))];
    return `<li>${labels.length ? `<span class="dictionary-label">${e(labels.join(" · "))}</span>` : ""}<span lang="${sense.language === "en" ? "en" : "zh-CN"}">${e(sense.text || sense.raw)}</span></li>`;
  };
  const preferred = chinese.length ? chinese : english;
  const source = dictionary.source?.name || "本地词典";
  const anchor = item.anchor;
  const words = anchor && (!anchor.segments?.length || anchor.segments.length === 1)
    ? [...anchor.quote.matchAll(/[A-Za-z\uFB00-\uFB06]+(?:['’-][A-Za-z\uFB00-\uFB06]+)*/g)] : [];
  body.innerHTML = `<div class="dictionary-caption">${e(source)} · 通用候选${dictionary.headword && dictionary.headword.toLowerCase() !== String(item.text).toLowerCase() ? ` · ${e(dictionary.headword)}` : ""}</div>
    ${!chinese.length ? `<p class="dictionary-missing">${english.length ? "暂无中文义项，以下保留英文释义。" : "词库暂无可靠释义，可主动解释此处用法。"}</p>` : ""}
    <ul class="dictionary-senses">${preferred.slice(0, 2).map(line).join("")}</ul>
    ${senses.length > 0 || dictionary.raw_detail ? `<details class="dictionary-full"><summary>完整义项与来源</summary>${chinese.length ? `<div class="dictionary-caption">中文候选</div><ul class="dictionary-senses">${chinese.map(line).join("")}</ul>` : ""}${english.length ? `<div class="dictionary-caption">英文候选 · 不与中文逐条对应</div><ul class="dictionary-senses">${english.map(line).join("")}</ul>` : ""}${dictionary.raw_detail ? `<details><summary>词库补充资料</summary><p class="dictionary-raw">${e(dictionary.raw_detail)}</p></details>` : ""}<p class="dictionary-caption">来源：${e(source)}${dictionary.source?.version ? ` · ${e(dictionary.source.version)}` : ""}。具体用法请结合原句。</p></details>` : ""}
    ${words.length > 1 ? `<details class="dictionary-members"><summary>单独查词</summary><div class="row wrap">${words.map(word => `<button type="button" data-dictionary-member="${word.index}" data-member-length="${word[0].length}">${e(word[0])}</button>`).join("")}</div></details>` : ""}`;
}
