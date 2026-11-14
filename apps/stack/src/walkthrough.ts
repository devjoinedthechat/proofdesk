import { writeFileSync } from "node:fs";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";

// Makes the walkthrough in the README: one animated SVG, built from stills of
// the running local stack taken in a real browser. Start the stack first with
// `pnpm local:up`, on fresh data (`pnpm local:reset`), with a model key so
// that the agent's replies are a real model's.
//
//   node apps/stack/src/walkthrough.ts [output file]
//
// Each still is the browser window at the moment that matters, scrolled to
// the part of the page the caption is about. The window is as wide as the
// page's own column, so nothing is cropped away and nothing is empty.

const OUT = process.argv[2] ?? "docs/walkthrough/proofdesk-walkthrough.svg";
const PORTAL = "http://localhost:3000";
const PASSWORD = process.env.DEMO_PASSWORD ?? "local-demo-password";
const SIZE = { width: 860, height: 600 };
/** Seconds each still is shown, and how long one fades into the next. */
const HOLD = 6;
const FADE = 0.5;

type Still = { caption: string; png: Buffer };
const stills: Still[] = [];

/** Takes a still with `target` at the top of the window. */
async function still(page: Page, target: Locator, caption: string) {
  // Room below the page, so that a short page can still be scrolled to its target.
  await page.evaluate(`document.body.style.minHeight = "${SIZE.height * 3}px"`);
  const box = await target.boundingBox();
  if (!box) throw new Error(`Nothing to show for: ${caption}`);
  // Passed as source text: this file is not compiled against browser types.
  await page.evaluate(`window.scrollBy(0, ${box.y - 40})`);
  // Lets the scroll and any transition finish before the picture is taken.
  await page.waitForTimeout(400);
  stills.push({ caption, png: await page.screenshot({ type: "png" }) });
  console.log(`still ${stills.length}: ${caption}`);
}

/** Runs one part in its own browser session, as one person. */
async function as(browser: Browser, email: string, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    // Fixed, so that a still shows nothing about the machine it was made on.
    timezoneId: "UTC",
    locale: "en-US",
  });
  const page = await context.newPage();
  try {
    await page.goto(PORTAL);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator('input[name="username"]').fill(email);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.locator('[type="submit"]').first().click();
    await page.waitForURL(`${PORTAL}/`);
    await page.getByText("Signed in as").waitFor();
    await run(page);
  } finally {
    await context.close();
  }
}

const section = (page: Page, heading: string) =>
  page.locator("section", { has: page.getByRole("heading", { name: heading }) });
const requests = (page: Page) => section(page, "Your requests");
const requestsHeading = (page: Page) => page.getByRole("heading", { name: "Your requests" });

async function fill(page: Page, subject: string, body: string) {
  const form = section(page, "New request");
  await form.locator('input[type="text"]').fill(subject);
  await form.locator("textarea").fill(body);
  return form;
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await as(browser, "maya.okafor@example.org", async (page) => {
    const form = await fill(
      page,
      "i want a refund",
      "i dont like my item i paid 20$ can i have refund",
    );
    await still(
      page,
      page.locator("header"),
      "A customer files a request. It does not say which charge it is about.",
    );
    await form.getByRole("button", { name: "Send" }).click();
    await requests(page).getByText("We asked you a question").waitFor({ timeout: 120_000 });
    await still(
      page,
      requestsHeading(page),
      "The agent read the billing records, found no $20 charge, and asked instead of guessing.",
    );
    await requests(page)
      .getByPlaceholder("Your answer")
      .fill(
        "Sorry, I meant this month's $87 invoice. It was charged twice, please refund the second payment.",
      );
    await requests(page).getByRole("button", { name: "Reply" }).click();
    await requests(page).getByText("Resolved", { exact: true }).waitFor({ timeout: 120_000 });
    await still(
      page,
      requestsHeading(page),
      "The customer answers in the same conversation. The refund is allowed, and paid once.",
    );
  });

  await as(browser, "mateus.rocha@example.org", async (page) => {
    const form = await fill(
      page,
      "Annual renewal charged twice",
      "Our renewal was charged to the company card twice, $980.00 each. Please refund the duplicate.",
    );
    await form.getByRole("button", { name: "Send" }).click();
    await requests(page).getByText("Waiting for our team to approve").waitFor({ timeout: 120_000 });
    await still(
      page,
      requestsHeading(page),
      "At a second company, $980 is above the limit. Nothing is paid until a person approves.",
    );
  });

  await as(browser, "approver@tallyfield.example", async (page) => {
    const waiting = section(page, "Waiting for approval");
    await waiting.getByRole("button", { name: "Approve" }).first().waitFor();
    await still(
      page,
      page.locator("header"),
      "The staff console shows the refund, its amount, and why it needs approval.",
    );
    await waiting.getByRole("button", { name: "Approve" }).first().click();
    await page.getByText("Nothing is waiting.").waitFor({ timeout: 60_000 });
  });

  await as(browser, "mateus.rocha@example.org", async (page) => {
    await requests(page).getByText("Resolved", { exact: true }).waitFor({ timeout: 120_000 });
    await still(
      page,
      requestsHeading(page),
      "Approved, then paid exactly once. The ticket's workflow waited for the decision.",
    );
  });

  await as(browser, "operator@harbor.example", async (page) => {
    await page.getByRole("heading", { name: "Kill switch" }).waitFor();
    await page.getByPlaceholder("Reason").fill("Refunds look wrong");
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByText("The agent is paused").waitFor();
    await still(
      page,
      page.locator("header"),
      "An operator's kill switch stops the agent at its next step. Only a person can resume it.",
    );
    await page.getByRole("button", { name: "Resume" }).click();
    await page.getByText("The agent is running").waitFor();
  });
} finally {
  await browser.close();
}

// ------------------------------------------------------------------ the SVG

const CAPTION = 60;
const { width, height } = SIZE;
const total = stills.length * HOLD;
const percent = (seconds: number) => `${((seconds / total) * 100).toFixed(3)}%`;
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const gap = 6;
const tick = (width - 48 - gap * (stills.length - 1)) / stills.length;
const parts = stills.map(({ caption, png }, index) => {
  const delay = `animation-delay:${index * HOLD}s`;
  return {
    image: `<image class="s" style="${delay}" width="${width}" height="${height}" href="data:image/png;base64,${png.toString("base64")}"/>`,
    caption: `<text class="s c" style="${delay}" x="24" y="${height + 41}">${escapeXml(caption)}</text>`,
    tick: `<rect class="s" style="${delay}" x="${24 + index * (tick + gap)}" y="${height + 12}" width="${tick}" height="3" rx="1.5" fill="#fff"/>`,
    track: `<rect x="${24 + index * (tick + gap)}" y="${height + 12}" width="${tick}" height="3" rx="1.5" fill="#fff" opacity=".22"/>`,
  };
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + CAPTION}" width="${width}" role="img" aria-label="${escapeXml(stills.map((one) => one.caption).join(" "))}">
<style>
.s{opacity:0;animation:show ${total}s linear infinite both}
.c{font:500 16px/1 system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;fill:#fff}
@keyframes show{0%{opacity:0}${percent(FADE)}{opacity:1}${percent(HOLD)}{opacity:1}${percent(HOLD + FADE)}{opacity:0}100%{opacity:0}}
</style>
<clipPath id="frame"><rect width="${width}" height="${height + CAPTION}" rx="10"/></clipPath>
<g clip-path="url(#frame)">
<rect width="${width}" height="${height}" fill="#fff"/>
${parts.map((part) => part.image).join("\n")}
<rect y="${height}" width="${width}" height="${CAPTION}" fill="#101216"/>
${parts.map((part) => part.track).join("")}
${parts.map((part) => part.tick).join("")}
${parts.map((part) => part.caption).join("\n")}
</g>
<rect x=".5" y=".5" width="${width - 1}" height="${height + CAPTION - 1}" rx="10" fill="none" stroke="#8b949e" stroke-opacity=".4"/>
</svg>
`;
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}: ${stills.length} stills, ${Math.round(svg.length / 1024)} KB`);
