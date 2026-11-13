import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENTS } from "@proofdesk/identity";
import { env } from "@proofdesk/service";
import type { DemoFile } from "./provision.ts";

// Files a ticket against the running local stack, as a customer would, and
// prints what happens to it.
//
//   refund    a duplicate charge; the agent refunds it
//   approval  a duplicate charge above the approval limit; the refund waits
//             until a member of staff approves it, which this script then does

const which = process.argv[2] ?? "refund";
if (which !== "refund" && which !== "approval") {
  console.error("Usage: demo [refund|approval]");
  process.exit(2);
}
const { demos, staff } = JSON.parse(
  readFileSync(join(env("STATE_DIR"), "demo.json"), "utf8"),
) as DemoFile;
const demo = demos[which];
const portal = env("PORTAL_URL");
const issuer = env("KEYCLOAK_ISSUER");
const password = env("DEMO_PASSWORD");

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: CLIENTS.devLogin,
      grant_type: "password",
      username: email,
      password,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`Sign-in failed for ${email} (${response.status})`);
  return body.access_token;
}

async function call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`${portal}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

type Ticket = { id: string; status: string; reply: string | null };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const customer = await signIn(demo.email);
console.log(`Signed in as ${demo.email}\n`);
console.log(`Subject: ${demo.subject}`);
console.log(`${demo.body}\n`);
const { ticket } = await call<{ ticket: Ticket }>("POST", "/tickets", customer, {
  category: "refund",
  subject: demo.subject,
  body: demo.body,
});
console.log(`Ticket ${ticket.id} submitted.`);

let approved = false;
const deadline = Date.now() + 180_000;
for (;;) {
  if (Date.now() > deadline) throw new Error("The ticket was not resolved within three minutes");
  await sleep(1500);
  const { tickets } = await call<{ tickets: Ticket[] }>(
    "GET",
    "/tickets",
    await signIn(demo.email),
  );
  const current = tickets.find((candidate) => candidate.id === ticket.id);
  if (!current) throw new Error("The ticket disappeared");

  if (current.status === "waiting_approval" && approved) {
    // The agent asked again after the first approval. That is for a person.
    console.log("\nThe agent has asked for approval a second time. Leaving that to staff.");
    console.log("To replay this demo from the start: pnpm local:reset && pnpm local:up");
    break;
  }
  if (current.status === "waiting_approval" && !approved) {
    const approver = staff[demo.tenantId]?.approver;
    if (!approver) throw new Error("No approver is set up for this company");
    const token = await signIn(approver);
    const { approvals } = await call<{
      approvals: { id: string; ticketId: string; reason: string; summary: unknown }[];
    }>("GET", "/staff/approvals", token);
    const pending = approvals.find((candidate) => candidate.ticketId === ticket.id);
    if (!pending) continue;
    console.log(`\nThe refund is waiting for staff: ${pending.reason}`);
    console.log(`  ${JSON.stringify(pending.summary)}`);
    await call("POST", `/staff/approvals/${pending.id}/decision`, token, { decision: "approved" });
    console.log(`Approved by ${approver}.`);
    approved = true;
    // Give the workflow a moment to take the decision before looking again.
    await sleep(3000);
    continue;
  }
  if (current.status !== "open" && current.status !== "waiting_approval") {
    console.log(`\nStatus: ${current.status}`);
    console.log(`Reply:  ${current.reply}`);
    break;
  }
}
