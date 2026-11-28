const $ = (id) => document.getElementById(id);
const roleName = {body:"正文", header:"跑眉", footer:"页脚", number:"页码", footnote:"脚注", excluded:"已移出正文"};
const cases = $("cases");
let current, selected, highlight, busy = false;

function node(tag, text, name) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (name) item.className = name;
  return item;
}

async function request(url, body) {
  const response = await fetch(url, body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {});
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json();
}

function reposition(item, box, page) {
  const [x, y, right, bottom] = box;
  item.style.left = `${100 * x / page.width}%`;
  item.style.top = `${100 * y / page.height}%`;
  item.style.width = `${100 * (right - x) / page.width}%`;
  item.style.height = `${100 * (bottom - y) / page.height}%`;
}

function choose(id) {
  selected = id;
  for (const button of document.querySelectorAll("[data-object]"))
    button.setAttribute("aria-pressed", String(button.dataset.object === selected));
}

function markTranslation(index) {
  highlight = index;
  for (const button of $("translations").children)
    button.setAttribute("aria-pressed", String(Number(button.dataset.index) === highlight));
  const translation = current.translations[index];
  markRanges(translation?.ranges ?? [], "原文高亮");
}

function markRanges(ranges, label) {
  for (const mark of document.querySelectorAll(".highlight")) mark.remove();
  const pages = new Set();
  for (const range of ranges) {
    const page = current.pages.find((p) => p.number === range.page);
    if (!page) continue;
    const mark = node("div", "", "highlight");
    reposition(mark, range.box, page);
    $(`page-${range.page}`).append(mark);
    pages.add(range.page);
  }
  $("mapping").textContent = ranges.length
    ? `${label}：第 ${[...pages].join("、")} 页 · ${ranges.length} 个 UTF-16 来源范围`
    : "当前没有可对照的译文";
}

function drawPages() {
  const pageList = $("pages"), evidence = $("evidence");
  pageList.replaceChildren();
  evidence.replaceChildren();
  const objects = current.pages.flatMap((p) => p.objects);
  if (!objects.some((b) => b.id === selected))
    selected = (objects.find((b) => b.role === "footer") ?? objects.find((b) => b.role !== "body") ?? objects[0])?.id;
  for (const number of current.shown) {
    const page = current.pages.find((p) => p.number === number);
    const fig = node("figure", "", current.shown.length === 1 ? "sheet only" : "sheet");
    fig.append(node("figcaption", `原页 ${number}${page ? " · 数字文本" : ""}`));
    const display = node("div", "", `sheet-body${page ? "" : " waiting"}`);
    display.id = `page-${number}`;
    if (!page) {
      display.textContent = "下一页尚未就绪";
    } else {
      const image = node("img");
      image.alt = `第 ${number} 页 PDF 原件`;
      image.src = `/original/${current.id}/${number}`;
      display.append(image);
      for (const object of page.objects) {
        const button = node("button", "", "box");
        button.dataset.object = object.id;
        button.dataset.role = object.role;
        button.title = `${roleName[object.role]} · ${object.source}`;
        button.setAttribute("aria-label", button.title);
        button.onclick = () => choose(object.id);
        reposition(button, object.box, page);
        display.append(button);
      }
    }
    fig.append(display);
    pageList.append(fig);
  }
  for (const object of [...objects].sort((a,b) => (a.role === "body") - (b.role === "body"))) {
    const button = node("button");
    button.dataset.object = object.id;
    button.append(node("span", `${roleName[object.role]}${object.override ? "·手动" : ""}`, "role"),
      node("span", object.source, "evidence-source"), node("span", object.evidence, "reason"));
    button.onclick = () => choose(object.id);
    evidence.append(button);
  }
  choose(selected);
}

function show({active = false} = {}) {
  $("title").textContent = current.title;
  $("summary").textContent = `原页 ${current.shown.join(" → ")} · 选择样本、点击原页框，或切换译文高亮`;
  $("pending").hidden = current.shown.length !== 2;
  $("pending").textContent = current.hidden ? "恢复下一页" : "模拟下一页未就绪";
  const notice = $("notice");
  notice.hidden = !current.hidden && !(active && current.changed.length);
  notice.textContent = current.hidden
    ? (current.waiting ? "待续：下一页尚未就绪。未发送可能跨页的半段；独立段落不受影响。" : "下一页尚未就绪。")
    : `仅重算受影响接缝：原页 ${current.changed.map((n) => `${n} → ${n + 1}`).join("、")}`;
  for (const link of cases.children) {
    if (link.dataset.case === current.id) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  }
  drawPages();
  $("before").replaceChildren(...current.before.map((p) => node("p", p.source)));
  $("after").replaceChildren(...current.after.map((p) => {
    const text = node("p", p.source);
    if (p.notes.length) text.append(node("small", [...new Set(p.notes)].join("；")));
    if (p.waiting) text.append(node("small", "待续，未发送"));
    for (const repair of p.repairs) {
      const button = node("button", repair.text, "repair");
      button.setAttribute("aria-label", `定位断词：${repair.text}`);
      button.onclick = () => {
        markTranslation(-1);
        markRanges(repair.ranges, `断词原文 · ${repair.text}`);
      };
      text.append(button);
    }
    return text;
  }));
  $("before-payload").textContent = JSON.stringify(current.beforePayload, null, 2);
  $("after-payload").textContent = JSON.stringify(current.afterPayload, null, 2);
  $("translations").replaceChildren(...current.translations.map((t, i) => {
    const button = node("button", t.text);
    button.dataset.index = i;
    button.onclick = () => markTranslation(i);
    return button;
  }));
  const crossPage = current.translations.findIndex((t) =>
    new Set(t.ranges.map((r) => r.page).filter((n) => current.shown.includes(n))).size > 1);
  markTranslation(crossPage >= 0 ? crossPage : current.translations.length ? 0 : -1);
}

function failed(error) {
  $("notice").hidden = false;
  $("notice").textContent = error.message;
}

async function load(id) {
  if (busy) return;
  busy = true;
  try {
    current = await request(`/api/cases/${id}`);
    selected = null;
    show();
  } catch (error) {
    failed(error);
  } finally { busy = false; }
}

async function edit(action) {
  if (!current || busy || (action !== "pending" && !selected)) return;
  busy = true;
  try {
    current = await request(`/api/cases/${current.id}`, {action, id:selected});
    show({active:true});
  } catch (error) {
    failed(error);
  } finally { busy = false; }
}

$("pending").onclick = () => edit("pending");
for (const button of $("controls").children) button.onclick = () => edit(button.dataset.action);
try {
  const items = await request("/api/cases");
  for (const item of items) {
    const button = node("button", item.title);
    button.dataset.case = item.id;
    button.onclick = () => load(item.id);
    cases.append(button);
  }
  const initial = new URLSearchParams(location.search).get("case");
  await load((items.find((item) => item.id === initial) ?? items[0]).id);
} catch (error) {
  failed(error);
}
