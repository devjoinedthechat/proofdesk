import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENTS } from "@proofdesk/identity";
import { env } from "@proofdesk/service";
import type { DemoFile, DemoName } from "./provision.ts";

// Uses the running local stack as its people would, and prints what happens.
//
//   refund    a duplicate charge; the agent refunds it
//   approval  a duplicate charge above the approval limit; the refund waits
//             until a member of staff approves it, which this script then does
//   reply     a ticket that does not say which charge; the agent asks, the
//             customer answers, and the same conversation carries on
//   plan      a request for more seats; billing and access change together
//   handover  an operator pauses the agent, so the ticket goes to staff; a
//             member of staff answers it; the operator resumes the agent
//   delete    a customer asks for their account to be deleted

const NAMES = ["refund", "approval", "reply", "plan", "handover", "delete"] as const;
type Name = (typeof NAMES)[number];
const which = (process.argv[2] ?? "refund") as Name;
if (!NAMES.includes(which)) {
  console.error(`Usage: demo [${NAMES.join("|")}]`);
  process.exit(2);
}
const { demos, staff } = JSON.parse(
  readFileSync(join(env("STATE_DIR"), "demo.json"), "utf8"),
) as DemoFile;
// The hand-over demo uses the approval demo's customer and company.
const customerOf: Record<Name, DemoName> = {
  refund: "refund",
  approval: "approval",
  reply: "reply",
  plan: "plan",
  handover: "approval",
  delete: "delete",
};
const demo = demos[customerOf[which]];
const portal = env("PORTAL_URL");
// Signs in where Keycloak can be reached from here, which inside the stack's
// network is not its public address.
const issuer = process.env.KEYCLOAK_BACKCHANNEL_URL ?? env("KEYCLOAK_ISSUER");
const password = env("DEMO_PASSWORD");

async function tokenFor(email: string): Promise<string | undefined> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: CLIENTS.devLogin,
      grant_type: "password",
      username: email,
      password,
    }),
  });
  return ((await response.json()) as { access_token?: string }).access_token;
}

async function signIn(email: string): Promise<string> {
  const token = await tokenFor(email);
  if (!token) throw new Error(`Sign-in failed for ${email}`);
  return token;
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
const approver = staff[demo.tenantId]?.approver;
const operator = staff[demo.tenantId]?.operator;
if (!approver || !operator) throw new Error("No staff are set up for this company");

/** Looks at the ticket until `done` says it has reached a state worth acting on. */
async function watch(ticketId: string, done: (ticket: Ticket) => boolean): Promise<Ticket> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("The ticket did not move within three minutes");
    await sleep(1500);
    const { tickets } = await call<{ tickets: Ticket[] }>(
      "GET",
      "/tickets",
      await signIn(demo.email),
    );
    const current = tickets.find((candidate) => candidate.id === ticketId);
    if (!current) throw new Error("The ticket disappeared");
    if (done(current)) return current;
  }
}

const settled = (ticket: Ticket) => ticket.status !== "open";
const show = (ticket: Ticket) => {
  console.log(`\nStatus: ${ticket.status}`);
  console.log(`Reply:  ${ticket.reply}`);
};

// ------------------------------------------------------------------ delete

if (which === "delete") {
  console.log(`Signed in as ${demo.email}`);
  const { request } = await call<{ request: { id: string } }>(
    "POST",
    "/account/deletion-request",
    await signIn(demo.email),
    { confirmEmail: demo.email },
  );
  console.log(`Deletion request ${request.id} accepted.`);
  const deadline = Date.now() + 120_000;
  while (await tokenFor(demo.email)) {
    if (Date.now() > deadline) throw new Error("The account still exists after two minutes");
    await sleep(1500);
  }
  console.log("\nThe account is gone: signing in as that customer no longer works.");
  process.exit(0);
}

// ------------------------------------------------------------------ tickets

if (which === "handover") {
  await call("POST", "/staff/agent-controls", await signIn(operator), {
    paused: true,
    reason: "Demonstrating the kill switch",
  });
  console.log(`${operator} paused the agent for this company.\n`);
}

console.log(`Signed in as ${demo.email}\n`);
console.log(`Subject: ${demo.subject}`);
console.log(`${demo.body}\n`);
const { ticket } = await call<{ ticket: Ticket }>("POST", "/tickets", await signIn(demo.email), {
  category: demo.category,
  subject: demo.subject,
  body: demo.body,
});
console.log(`Ticket ${ticket.id} submitted.`);
let current = await watch(ticket.id, settled);

if (current.status === "waiting_approval") {
  const token = await signIn(approver);
  const { approvals } = await call<{
    approvals: { id: string; ticketId: string; reason: string; summary: unknown }[];
  }>("GET", "/staff/approvals", token);
  const pending = approvals.find((candidate) => candidate.ticketId === ticket.id);
  if (!pending) throw new Error("The ticket is waiting for approval, and no approval is listed");
  console.log(`\nThe refund is waiting for staff: ${pending.reason}`);
  console.log(`  ${JSON.stringify(pending.summary)}`);
  await call("POST", `/staff/approvals/${pending.id}/decision`, token, { decision: "approved" });
  console.log(`Approved by ${approver}.`);
  // Give the workflow a moment to take the decision before looking again.
  await sleep(3000);
  current = await watch(ticket.id, (seen) => settled(seen) && seen.status !== "waiting_approval");
}

if (current.status === "waiting_customer" && demo.answer) {
  show(current);
  console.log(`\nThe customer answers: ${demo.answer}`);
  await call("POST", `/tickets/${ticket.id}/messages`, await signIn(demo.email), {
    body: demo.answer,
  });
  current = await watch(ticket.id, (seen) => settled(seen) && seen.status !== "waiting_customer");
}

show(current);

if (current.status === "handed_to_staff" && which === "handover") {
  const reply = "A member of our team has looked at this and will correct the charge today.";
  await call("POST", `/staff/tickets/${ticket.id}/reply`, await signIn(approver), {
    body: reply,
    resolution: "resolved",
  });
  console.log(`\n${approver} answered the customer.`);
  show(await watch(ticket.id, (seen) => seen.status === "resolved"));
}

if (which === "handover") {
  await call("POST", "/staff/agent-controls", await signIn(operator), {
    paused: false,
    reason: "Demonstration over",
  });
  console.log(`\n${operator} resumed the agent.`);
}
