import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

// Records a walkthrough of the running local stack as a series of short
// videos, one per scene, in a real browser. Start the stack first with
// `pnpm local:up`, on fresh data (`pnpm local:reset`), with a model key so
// that the agent's replies are a real model's.
//
//   node apps/stack/src/walkthrough.ts <output directory>
//
// The scenes are joined afterwards; see docs/walkthrough/README.md.

const OUT = process.argv[2] ?? "walkthrough";
const PORTAL = "http://localhost:3000";
const PASSWORD = process.env.DEMO_PASSWORD ?? "local-demo-password";
const SIZE = { width: 1280, height: 800 };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A line of text across the bottom of the page, saying what is being shown. */
async function caption(page: Page, text: string) {
  // Passed as source text: this file is not compiled against browser types.
  // The style is set through script, which the page's content security
  // policy allows.
  await page.evaluate(`(() => {
    let bar = document.getElementById("walkthrough-caption");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "walkthrough-caption";
      Object.assign(bar.style, {
        position: "fixed",
        left: "0",
        right: "0",
        bottom: "0",
        padding: "14px 24px",
        background: "rgba(16, 18, 22, 0.92)",
        color: "#ffffff",
        font: "500 18px/1.4 system-ui, sans-serif",
        zIndex: "2147483647",
      });
      document.body.append(bar);
    }
    bar.textContent = ${JSON.stringify(text)};
  })()`);
}

let scene = 0;
/** Runs one scene in its own browser session and saves its recording. */
async function record(
  browser: Browser,
  name: string,
  run: (page: Page, context: BrowserContext) => Promise<void>,
) {
  const context = await browser.newContext({
    viewport: SIZE,
    // Fixed, so that a recording shows nothing about the machine it was made on.
    timezoneId: "UTC",
    locale: "en-US",
    recordVideo: { dir: join(OUT, "raw"), size: SIZE },
  });
  const page = await context.newPage();
  try {
    await run(page, context);
    await pause(1200);
  } finally {
    const video = page.video();
    await context.close();
    const file = `${String(++scene).padStart(2, "0")}-${name}.webm`;
    if (video) renameSync(await video.path(), join(OUT, file));
    console.log(`recorded ${file}`);
  }
}

async function signIn(page: Page, email: string, say: string) {
  await page.goto(PORTAL);
  await caption(page, say);
  await pause(1500);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator('input[name="username"]').pressSequentially(email, { delay: 25 });
  await page.locator('input[name="password"]').pressSequentially(PASSWORD, { delay: 15 });
  await caption(page, "Sign-in happens at Keycloak. The page never sees the password.");
  await pause(1200);
  await page.locator('[type="submit"]').first().click();
  await page.waitForURL(`${PORTAL}/`);
  await page.getByText("Signed in as").waitFor();
}

async function fileRequest(page: Page, subject: string, body: string) {
  const form = page.locator("section", { has: page.getByRole("heading", { name: "New request" }) });
  await form.locator('input[type="text"]').pressSequentially(subject, { delay: 30 });
  await form.locator("textarea").pressSequentially(body, { delay: 18 });
  await pause(600);
  await form.getByRole("button", { name: "Send" }).click();
}

const requests = (page: Page) =>
  page.locator("section", { has: page.getByRole("heading", { name: "Your requests" }) });

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, "raw"), { recursive: true, force: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await record(browser, "customer-asks-and-answers", async (page) => {
    await signIn(page, "maya.okafor@example.org", "A customer signs in to file a request.");
    await caption(page, "The request does not say which charge it is about.");
    await fileRequest(page, "i want a refund", "i dont like my item i paid 20$ can i have refund");
    await requests(page).getByText("We asked you a question").waitFor({ timeout: 120_000 });
    await requests(page).locator(".reply").first().scrollIntoViewIfNeeded();
    await caption(
      page,
      "The agent read the billing records, found no $20 charge, and asked instead of guessing.",
    );
    await pause(6000);
    const answer = requests(page).getByPlaceholder("Your answer");
    await answer.pressSequentially(
      "Sorry, I meant this month's $87 invoice. It was charged twice, please refund the second payment.",
      { delay: 18 },
    );
    await caption(page, "The customer answers. The same conversation carries on.");
    await pause(800);
    await requests(page).getByRole("button", { name: "Reply" }).click();
    await requests(page).getByText("Resolved", { exact: true }).waitFor({ timeout: 120_000 });
    await requests(page).locator(".reply").last().scrollIntoViewIfNeeded();
    await caption(
      page,
      "Policy allowed the refund, billing paid it once, and the reply was checked against what was done.",
    );
    await pause(6500);
  });

  await record(browser, "large-refund-waits", async (page) => {
    await signIn(page, "mateus.rocha@example.org", "Another customer, at a second company.");
    await fileRequest(
      page,
      "Annual renewal charged twice",
      "Our renewal was charged to the company card twice, $980.00 each. Please refund the duplicate.",
    );
    await requests(page).getByText("Waiting for our team to approve").waitFor({ timeout: 120_000 });
    await caption(
      page,
      "$980 is above this company's limit. The refund is not paid. It waits for a person.",
    );
    await pause(5000);
  });

  await record(browser, "staff-approve", async (page) => {
    await signIn(page, "approver@tallyfield.example", "A member of staff signs in.");
    await page.getByRole("heading", { name: "Waiting for approval" }).waitFor();
    await caption(page, "The staff console: the refund, its amount, and why it needs approval.");
    await pause(4000);
    await page.getByRole("button", { name: "Approve" }).first().click();
    await caption(
      page,
      "Approved. The ticket's workflow has waited for this, however long it took.",
    );
    await page.getByText("Nothing is waiting.").waitFor({ timeout: 60_000 });
    await pause(2500);
  });

  await record(browser, "customer-sees-refund", async (page) => {
    await signIn(page, "mateus.rocha@example.org", "Back as the customer.");
    await requests(page).getByText("Resolved", { exact: true }).waitFor({ timeout: 120_000 });
    await requests(page).locator(".reply").last().scrollIntoViewIfNeeded();
    await caption(page, "The refund was paid after approval, exactly once.");
    await pause(5000);
  });

  await record(browser, "kill-switch", async (page) => {
    await signIn(page, "operator@harbor.example", "An operator signs in.");
    await page.getByRole("heading", { name: "Kill switch" }).waitFor();
    await caption(page, "The kill switch stops the agent at its next step, for this company.");
    await pause(2500);
    await page.getByPlaceholder("Reason").pressSequentially("Refunds look wrong", { delay: 30 });
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByText("The agent is paused").waitFor();
    await caption(page, "Paused. A paused agent makes no model calls; its tickets go to staff.");
    await pause(4000);
    await page.getByRole("button", { name: "Resume" }).click();
    await page.getByText("The agent is running").waitFor();
    await caption(
      page,
      "Only a person can resume it. Automation can pause the agent, never restart it.",
    );
    await pause(3500);
  });

  await record(browser, "workflows", async (page) => {
    await page.goto("http://localhost:8233/namespaces/proofdesk/workflows");
    await page.getByText("ticketWorkflow").first().waitFor({ timeout: 30_000 });
    await caption(
      page,
      "Temporal: each ticket is a durable workflow. A worker can die at any step.",
    );
    await pause(5000);
  });

  // Metrics are exported every ten seconds. Give the last ticket's time to arrive.
  await pause(25_000);
  await record(browser, "dashboard", async (page) => {
    await page.goto("http://localhost:3001/d/proofdesk?kiosk");
    await page.getByText("Tickets finished").first().waitFor({ timeout: 30_000 });
    await pause(2500);
    await caption(
      page,
      "Grafana: what the agent did and what it cost. Counts only, no customer text.",
    );
    await pause(6000);
  });
} finally {
  await browser.close();
  rmSync(join(OUT, "raw"), { recursive: true, force: true });
}
