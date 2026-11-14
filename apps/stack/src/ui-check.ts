import { type Browser, chromium, type Page } from "playwright-core";

// Uses the web interface of the running local stack in a real browser, the
// way three people would: a customer, an approver and an operator. It needs
// Google Chrome on this machine, and the stack started with `pnpm local:up`.
//
// Any error the page logs, and any script error, fails the check.

const PORTAL = process.env.PORTAL_PUBLIC_URL ?? "http://localhost:3000";
const PASSWORD = process.env.DEMO_PASSWORD ?? "local-demo-password";
// The accounts the local stack is provisioned with.
const CUSTOMER = "maya.okafor@example.org";
const APPROVER = "approver@harbor.example";
const OPERATOR = "operator@harbor.example";

const problems: string[] = [];

/** A fresh browser session, signed in through Keycloak's own login page. */
async function signedIn(browser: Browser, email: string, role: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`${role}: script error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`${role}: console error: ${message.text()}`);
  });

  await page.goto(PORTAL);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Now on Keycloak. The page itself never sees the password.
  await page.locator('input[name="username"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('[type="submit"]').first().click();
  await page.waitForURL(`${PORTAL}/`);
  await page.getByText(`Signed in as ${role}`).waitFor({ timeout: 20_000 });
  return page;
}

async function customer(browser: Browser) {
  const page = await signedIn(browser, CUSTOMER, "customer");
  const form = page.locator("section", { has: page.getByRole("heading", { name: "New request" }) });
  await form.locator('input[type="text"]').fill("Charged twice");
  await form
    .locator("textarea")
    .fill("My card was charged twice for my last invoice. Please refund the duplicate.");
  await form.getByRole("button", { name: "Send" }).click();

  // The request appears, and then the agent's reply, without reloading.
  const requests = page.locator("section", {
    has: page.getByRole("heading", { name: "Your requests" }),
  });
  await requests.getByText("Charged twice", { exact: true }).waitFor({ timeout: 20_000 });
  await requests.locator(".reply").filter({ hasText: "refunded" }).waitFor({ timeout: 90_000 });
  await requests.getByText("Resolved", { exact: true }).waitFor();
  console.log("  ok    a customer signs in, files a request and reads the agent's reply");

  // What the customer wrote is shown as text, whatever it contains.
  await form.locator('input[type="text"]').fill('<img src=x onerror="window.pwned=1">');
  await form.locator("textarea").fill("<script>window.pwned=1</script> PLEASE look at this");
  await form.getByRole("button", { name: "Send" }).click();
  await requests.getByText('<img src=x onerror="window.pwned=1">').waitFor({ timeout: 20_000 });
  if (await page.evaluate("'pwned' in window")) {
    problems.push("customer: text from a ticket ran as script");
  }
  console.log("  ok    markup in a ticket is shown as text and does not run");
  await page.context().close();
}

async function approver(browser: Browser) {
  const page = await signedIn(browser, APPROVER, "approver");
  for (const heading of [
    "Waiting for approval",
    "Waiting for a reply from staff",
    "Review the agent's work",
  ]) {
    await page.getByRole("heading", { name: heading }).waitFor();
  }
  // Each list has loaded and none reported a failure.
  await page.waitForFunction("!document.body.textContent.includes('Loading')");
  if ((await page.locator("p.error").count()) > 0) {
    problems.push(`approver: ${await page.locator("p.error").first().textContent()}`);
  }
  // An approver is not shown the kill switch.
  if ((await page.getByRole("heading", { name: "Kill switch" }).count()) > 0) {
    problems.push("approver: was shown the kill switch");
  }
  console.log("  ok    an approver sees approvals, hand-overs and the review queue");
  await page.context().close();
}

async function operator(browser: Browser) {
  const page = await signedIn(browser, OPERATOR, "operator");
  await page.getByRole("heading", { name: "Kill switch" }).waitFor();
  await page.getByText("The agent is running").waitFor();

  await page.getByPlaceholder("Reason").fill("Interface check");
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByText("The agent is paused").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByText("The agent is running").waitFor({ timeout: 20_000 });
  console.log("  ok    an operator pauses and resumes the agent");
  await page.context().close();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await customer(browser);
  await approver(browser);
  await operator(browser);
} catch (error) {
  problems.push(
    error instanceof Error ? (error.message.split("\n")[0] ?? "failed") : String(error),
  );
} finally {
  await browser.close();
}

if (problems.length > 0) {
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exit(1);
}
