import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  enableAll,
  read,
  readerDefaults,
  tools,
  focus,
  selectParagraph,
} from "./reader-helpers.js";
const provider = `http://127.0.0.1:${process.env.WR_E2E_PROVIDER_PORT || "18768"}`;
const large = execFileSync(".venv/bin/python", [
  "tests/browser/performance-book.py",
]);
async function config(request, model = "slow-assist") {
  await request.put("/api/ai/config", {
    data: {
      text: {
        enabled: true,
        model,
        api_key: "e2e-no-secret",
        base_url: provider + "/v1",
      },
    },
  });
}
async function selected(request) {
  const d = await (
    await request.post("/api/documents", {
      data: {
        title: "AI in-flight acceptance",
        text: "The reasoning did not carry conviction, since knowledge is acquired in relations.",
      },
    })
  ).json();
  const b = d.blocks[0];
  const start = b.text.indexOf("conviction");
  return {
    id: d.id,
    anchor: {
      version: d.version,
      block_id: b.id,
      start,
      end: start + 10,
      quote: "conviction",
    },
  };
}
async function observed(request) {
  return (await (await request.get(provider + "/observed")).json()).chat;
}
async function waitCall(request, start) {
  await expect
    .poll(async () => (await observed(request)).length)
    .toBeGreaterThan(start);
}
async function evidence(info, name, value) {
  await info.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: "application/json",
  });
}
test.beforeEach(async ({ request, page }) => {
  await enableAll(request);
  await readerDefaults(page);
});
test("same AI identity/request id shares one two-stage provider flow and returns one saved result", async ({
  request,
}, info) => {
  await config(request);
  const { id, anchor } = await selected(request),
    before = (await observed(request)).length;
  const data = { anchor, request_id: "duplicate-" + id };
  const rs = await Promise.all([
    request.post(`/api/documents/${id}/context`, { data }),
    request.post(`/api/documents/${id}/context`, { data }),
  ]);
  expect(rs.map((r) => r.status())).toEqual([200, 200]);
  const bodies = await Promise.all(rs.map((r) => r.json()));
  expect(bodies[0].id).toBe(bodies[1].id);
  await evidence(
    info,
    "inflight-witness.json",
    await (await request.get("/__e2e/assist-debug")).json(),
  );
  expect((await observed(request)).length - before).toBe(2);
  const cache = await request.post(`/api/documents/${id}/context`, {
    data: { anchor, request_id: "cache-" + id },
  });
  expect((await cache.json()).cached).toBe(true);
  await request.delete(`/api/documents/${id}/assist-requests/duplicate-${id}`);
  expect(
    await (await request.get(`/api/documents/${id}/assists`)).json(),
  ).toHaveLength(1);
  await evidence(info, "ai-dedup.json", {
    providerCalls: 2,
    records: bodies.map((b) => b.id),
    cacheProtected: true,
  });
});
test("cancel one shared consumer preserves another; uncertain sole cancel blocks an unsafe retry", async ({
  request,
}, info) => {
  await config(request);
  const { id, anchor } = await selected(request),
    before = (await observed(request)).length;
  const a = request.post(`/api/documents/${id}/context`, {
    data: { anchor, request_id: "shared-a" },
  });
  const b = request.post(`/api/documents/${id}/context`, {
    data: { anchor, request_id: "shared-b" },
  });
  await waitCall(request, before);
  await expect
    .poll(
      async () =>
        (await (await request.get("/__e2e/assists")).json()).find(
          (s) => s.doc_id === id && s.request_id === "shared-b",
        )?.consumers,
    )
    .toBe(2);
  await request.delete(`/api/documents/${id}/assist-requests/shared-a`);
  expect((await a).status()).toBe(499);
  expect((await b).status()).toBe(200);
  expect((await observed(request)).length - before).toBe(2);
  expect(
    await (await request.get(`/api/documents/${id}/assists`)).json(),
  ).toHaveLength(1);
  const second = await selected(request),
    count = (await observed(request)).length;
  const pending = request.post(`/api/documents/${second.id}/context`, {
    data: { anchor: second.anchor, request_id: "sole" },
  });
  await waitCall(request, count);
  const t = Date.now();
  await request.delete(`/api/documents/${second.id}/assist-requests/sole`);
  expect((await pending).status()).toBe(499);
  const cancelMs = Date.now() - t;
  expect(cancelMs).toBeLessThan(500);
  expect(
    await (await request.get(`/api/documents/${second.id}/assists`)).json(),
  ).toHaveLength(0);
  await config(request, "e2e-model");
  const retry = await request.post(`/api/documents/${second.id}/context`, {
    data: { anchor: second.anchor, request_id: "retry" },
  });
  expect(retry.status()).toBe(409);
  expect(await retry.text()).toContain("不会自动重发");
  await config(request, "broken-json");
  const failed = await selected(request);
  expect(
    (
      await request.post(`/api/documents/${failed.id}/context`, {
        data: { anchor: failed.anchor, request_id: "failed" },
      })
    ).status(),
  ).toBe(502);
  await config(request, "e2e-model");
  expect(
    (
      await request.post(`/api/documents/${failed.id}/context`, {
        data: { anchor: failed.anchor, request_id: "recovered", regenerate: true },
      })
    ).status(),
  ).toBe(200);
  await evidence(info, "ai-cancel.json", {
    sharedProviderCalls: 2,
    cancelMs,
    soleNoLateRecord: true,
    unsafeRetryBlocked: true,
  });
});
test("review requests share work and cancel promptly without changing original notes", async ({
  request,
}, info) => {
  await config(request);
  const { id } = await selected(request);
  const n = await (
    await request.post("/api/notes", {
      data: { doc_id: id, body: "Original thought" },
    })
  ).json();
  const before = (await observed(request)).length,
    data = { sources: [-n.id], request_id: "review" };
  const work = request.post(`/api/documents/${id}/review`, { data });
  await waitCall(request, before);
  const t = Date.now();
  await request.delete(`/api/documents/${id}/assist-requests/review`);
  expect((await work).status()).toBe(499);
  expect(Date.now() - t).toBeLessThan(500);
  expect(
    (await (await request.get(`/api/documents/${id}/review`)).json()).body,
  ).toBe("");
  expect(
    (await (await request.get("/api/notes?doc_id=" + id)).json())[0].body,
  ).toBe("Original thought");
  await config(request, "e2e-model");
  const rs = await Promise.all(
    ["r1", "r2"].map((request_id) =>
      request.post(`/api/documents/${id}/review`, {
        data: { sources: [-n.id], request_id },
      }),
    ),
  );
  expect(rs.map((r) => r.status())).toEqual([200, 200]);
  await evidence(info, "review-cancel.json", {
    cancelMs: Date.now() - t,
    originalPreserved: true,
  });
});
test("large import permits concurrent health/profile calls and persists a whole book without opening", async ({
  request,
  page,
}, info) => {
  test.setTimeout(60000);
  const t = Date.now();
  const upload = request.post("/api/import", {
    multipart: {
      file: {
        name: "responsiveness.epub",
        mimeType: "application/epub+zip",
        buffer: large,
      },
    },
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 40));
  const probes = await Promise.all(
    ["/health", "/api/profile"].map(async (path) => {
      const start = Date.now(),
        r = await request.get(path);
      return { path, status: r.status(), ms: Date.now() - start };
    }),
  );
  probes.forEach((p) => {
    expect(p.status).toBe(200);
    expect(p.ms).toBeLessThan(700);
  });
  const response = await upload;
  expect(response.ok()).toBeTruthy();
  const book = await response.json();
  expect(book.chapters).toHaveLength(4);
  expect(
    (await (await request.get("/api/library/books")).json()).some(
      (b) => b.id === book.book_id,
    ),
  ).toBe(true);
  await page.goto("/");
  await expect(
    page.locator("#article-grid .book-card").filter({
      has: page.getByRole("heading", { name: book.title, exact: true }),
    }),
  ).toHaveCount(1);
  await evidence(info, "import-responsiveness.json", {
    importMs: Date.now() - t,
    probes,
    bookId: book.book_id,
    chapters: 4,
  });
});
test("nested EPUB quotes/lists/table cells/code survive import and render without stray separators", async ({
  request,
  page,
}, info) => {
  const buffer = execFileSync(".venv/bin/python", [
    "tests/browser/epub_fixtures.py",
    "nested-semantic",
  ]);
  const response = await request.post("/api/import", {
    multipart: {
      file: { name: "nested.epub", mimeType: "application/epub+zip", buffer },
    },
  });
  expect(response.ok()).toBeTruthy();
  const book = await response.json();
  const d = await (
    await request.get(
      "/api/documents/" + book.chapters[0].doc_id + "?compact=true",
    )
  ).json();
  expect(d.blocks.filter((b) => b.type === "quote").map((b) => b.text)).toEqual(
    ["Quoted author statement.", "Second quoted paragraph."],
  );
  expect(
    d.blocks.filter((b) => b.type === "list-item").map((b) => b.text),
  ).toEqual(["Nested list entry.", "Child entry.", "Parent continuation."]);
  expect(
    d.blocks.filter((b) => b.type === "table-row").map((b) => b.cells),
  ).toEqual([
    ["Column A value.", "Column B value."],
    ["Empty neighbour", ""],
  ]);
  expect(d.blocks.some((b) => b.text === "·")).toBe(false);
  expect(d.blocks.find((b) => b.type === "code").text).toBe(
    "if ready:\n    proceed()",
  );
  expect(d.blocks.map((b) => b.text).join("")).not.toContain("hidden script");
  await read(page, d.id);
  await expect(page.locator("#article blockquote")).toHaveCount(2);
  await expect(page.locator("#article .list-block").first()).toBeVisible();
  await evidence(info, "epub-semantics.json", { blocks: d.blocks });
  await info.attach("epub-semantics.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("disabled AI and immediately invalid provider output settle without hanging watchers", async ({
  request,
}, info) => {
  const { id, anchor } = await selected(request);
  const timings = [];
  for (let i = 0; i < 8; i++) {
    const t = Date.now();
    const res = await request.post(`/api/documents/${id}/context`, {
      data: { anchor, request_id: "disabled-" + i },
      timeout: 2000,
    });
    expect(res.status()).toBe(400);
    timings.push(Date.now() - t);
  }
  await evidence(info, "immediate-ai-errors.json", { timings });
});
