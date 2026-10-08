import { test, expect } from "@playwright/test";
import { enableAll } from "./reader-helpers.js";
import { probePaper } from "./paper-probe.js";
test.use({
  channel: "chrome",
  trace: "off",
  deviceScaleFactor: 2.2,
  viewport: { width: 796, height: 1135 },
  launchOptions: { args: ["--use-angle=metal", "--enable-gpu"] },
});
test("portrait single page: held diagonal folds must not stretch the paper material", async ({
  page,
  request,
}, info) => {
  test.setTimeout(45000);
  await enableAll(request);
  await page.addInitScript(() => {
    localStorage.setItem("wr2:page-layout", JSON.stringify("single"));
    localStorage.setItem("wr2:page-motion", JSON.stringify("curl"));
  });
  const doc = await (
    await request.post("/api/documents", {
      data: {
        title: "Paper distortion diagnostic",
        text: Array(30)
          .fill(
            "The reasoning of these two men did not carry conviction, since knowledge is acquired in relations. ".repeat(
              6,
            ),
          )
          .join("\n\n"),
      },
    })
  ).json();
  await page.goto("/#/read/" + doc.id);
  await expect(page.locator(".reader")).toHaveAttribute(
    "data-curl-warm",
    "true",
  );
  const leaf = await page.locator("#article .page-leaf").boundingBox();
  const edge = await page.locator("#reading-edge-next").boundingBox();
  const observations = [];
  let worst = { stretch: 0 };
  for (const grab of [0.18, 0.55, 0.82]) {
    const start = {
      x: edge.x + edge.width / 2,
      y: leaf.y + leaf.height * grab,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const dy of [0.15, 0.34, 0.6])
      for (const progress of [0.12, 0.31, 0.55, 0.85]) {
        await page.mouse.move(
          start.x - progress * 2 * leaf.width,
          start.y + (grab > 0.5 ? -1 : 1) * dy * leaf.height,
          { steps: 6 },
        );
        await expect(page.locator("#page-curl-layer")).toBeVisible();
        const data = await probePaper(page);
        const aspect = data.uniforms.u_leaf[3] / data.uniforms.u_leaf[2];
        let stretch = 0,
          where = null;
        for (let y = 0; y <= 24; y++)
          for (let x = 0; x <= 96; x++)
            for (const [dx, dy2, axis] of [
              [1, 0, "x"],
              [0, 1, "y"],
            ]) {
              if (x + dx > 96 || y + dy2 > 24) continue;
              const a = data.rows[y].points[x],
                b = data.rows[y + dy2].points[x + dx];
              const ratio =
                Math.hypot(b[0] - a[0], (b[1] - a[1]) * aspect, b[2] - a[2]) /
                (dx ? 1 / 96 : aspect / 24);
              if (ratio > stretch) {
                stretch = ratio;
                where = { x, y, axis, band: x / 96 < 0.12 ? "root" : "outer" };
              }
            }
        const metrics = { grab, dy, progress, stretch, where };
        observations.push(metrics);
        if (stretch > worst.stretch) {
          worst = metrics;
          await info.attach("worst-" + observations.length + ".json", {
            body: JSON.stringify({ metrics, data }),
            contentType: "application/json",
          });
          await info.attach("worst-" + observations.length + ".png", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        }
      }
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
  await info.attach("twist-summary.json", {
    body: JSON.stringify({ leaf, observations, worst }, null, 2),
    contentType: "application/json",
  });
  expect(
    worst.stretch,
    "material stretch cannot be explained by perspective or a cylindrical bend",
  ).toBeLessThanOrEqual(1.02);
});
