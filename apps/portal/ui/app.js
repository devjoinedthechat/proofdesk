// The portal's web interface. No framework and no build step: this file is
// served as it is.
//
// Sign-in is the authorization code flow with PKCE against Keycloak. Tokens
// are kept in memory only, so closing or reloading the page signs you out of
// this page (Keycloak's own session usually signs you straight back in).
//
// Everything that comes from the server is written to the page as text,
// never as HTML.

const app = document.getElementById("app");
const sessionBox = document.getElementById("session");
const config = await (await fetch("/ui/config.json")).json();
const oidc = `${config.issuer}/protocol/openid-connect`;
const redirectUri = `${location.origin}/`;

let tokens = null;
let refreshTimer;
/** Shown once on the sign-in page, when a session ended by itself. */
let notice = "";

// ---------------------------------------------------------------- helpers

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

let fieldIds = 0;
/** A control with its label, joined so that the label names it and focuses it. */
function field(label, control) {
  control.id = `field-${++fieldIds}`;
  return [el("label", { for: control.id }, label), control];
}

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const base64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const claims = (token) =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")), (c) =>
        c.charCodeAt(0),
      ),
    ),
  );

/** `duplicate_charge` or `amountCents` as words: "Duplicate charge", "Amount". */
function words(code) {
  const text = String(code)
    .replace(/Cents$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ago(iso) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 45) return "just now";
  if (seconds < 3570) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 84_600) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A time as "5 min ago", with the exact time on hover. Kept current below. */
function when(iso, prefix = "") {
  if (!iso) return null;
  return el(
    "time",
    { class: "meta", datetime: iso, title: new Date(iso).toLocaleString(), "data-prefix": prefix },
    prefix + ago(iso),
  );
}
setInterval(() => {
  for (const time of document.querySelectorAll("time[datetime]")) {
    time.textContent = (time.dataset.prefix ?? "") + ago(time.dateTime);
  }
}, 30_000);

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${tokens.access}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) endSession("Your session has ended. Sign in again to carry on.");
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? `Request failed (${response.status})`);
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

/**
 * Runs an action from a button, showing its error next to the button if it
 * fails. With `confirm`, the first press only asks: the button shows that
 * text for a few seconds, and a second press goes ahead.
 */
function action(label, run, attributes = {}, confirm) {
  const note = el("span", { class: "error", role: "alert" });
  let armed;
  const disarm = () => {
    clearTimeout(armed);
    armed = undefined;
    button.textContent = label;
  };
  const button = el(
    "button",
    {
      type: "button",
      ...attributes,
      onclick: async () => {
        if (confirm && !armed) {
          button.textContent = confirm;
          armed = setTimeout(disarm, 4000);
          return;
        }
        disarm();
        button.disabled = true;
        note.textContent = "";
        try {
          await run();
        } catch (error) {
          note.textContent = error.message;
        } finally {
          button.disabled = false;
          // A disabled button drops the keyboard's place on the page.
          if (button.isConnected && document.activeElement === document.body) button.focus();
        }
      },
    },
    label,
  );
  return el("span", { class: "row" }, button, note);
}

/**
 * A list that is redrawn from the server again and again without disturbing
 * what a person is doing in it. An entry is built once and kept for as long
 * as its signature stays the same, so a half-typed reply, a chosen verdict
 * and the keyboard's focus all survive a refresh.
 */
function keyedList(emptyText) {
  const list = el("div", { class: "list" }, el("p", { class: "muted" }, "Loading…"));
  const empty = el("p", { class: "muted empty" }, emptyText);
  const node = el("div", {}, list);
  const built = new Map();
  let problem;

  return {
    node,
    show(items, signatureOf, build) {
      problem?.remove();
      const seen = new Map();
      for (const item of items) {
        const signature = signatureOf(item);
        const old = built.get(item.id);
        seen.set(item.id, old?.signature === signature ? old : { signature, node: build(item) });
      }
      built.clear();
      for (const [id, entry] of seen) built.set(id, entry);
      const nodes = items.length === 0 ? [empty] : [...seen.values()].map((entry) => entry.node);
      // Only what changed is touched: taking a node out and putting it back
      // would drop the focus inside it.
      for (const child of [...list.children]) if (!nodes.includes(child)) child.remove();
      nodes.forEach((entry, index) => {
        if (list.children[index] !== entry) list.insertBefore(entry, list.children[index] ?? null);
      });
    },
    fail(error) {
      problem?.remove();
      problem = el("p", { class: "error", role: "alert" }, error.message);
      if (built.size === 0) list.replaceChildren();
      node.prepend(problem);
    },
  };
}

/**
 * Keeps a part of the page current: loads now, then again after `delay(data)`
 * milliseconds, for as long as the part is on the page and someone is signed
 * in. A delay of nothing means there is nothing more to wait for. Returns a
 * function that loads at once; an answer that a newer load has overtaken is
 * dropped.
 */
function live(anchor, load, show, fail, delay) {
  let timer;
  let latest = 0;
  async function refresh() {
    clearTimeout(timer);
    const mine = ++latest;
    let wait = 5000;
    try {
      const data = await load();
      if (mine !== latest) return;
      show(data);
      wait = delay(data);
    } catch (error) {
      if (mine !== latest || !tokens) return;
      fail(error);
    }
    if (wait) timer = setTimeout(tick, wait);
  }
  function tick() {
    if (!tokens || !anchor.isConnected) return;
    // Nobody is looking. Check again shortly instead of asking the server.
    if (document.hidden) timer = setTimeout(tick, 2000);
    else refresh();
  }
  refresh();
  return refresh;
}

// ---------------------------------------------------------------- sign-in

async function signIn() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  sessionStorage.setItem("pkce", JSON.stringify({ verifier, state }));
  location.assign(
    `${oidc}/auth?${new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`,
  );
}

function endSession(message) {
  if (!tokens) return;
  tokens = null;
  clearTimeout(refreshTimer);
  notice = message;
  render();
}

async function tokenRequest(parameters) {
  const response = await fetch(`${oidc}/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: config.clientId, ...parameters }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error_description ?? "Sign-in failed");
  tokens = { access: body.access_token, refresh: body.refresh_token, id: body.id_token };
  clearTimeout(refreshTimer);
  // Renew a little before the access token runs out.
  refreshTimer = setTimeout(
    () =>
      tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh }).catch(() =>
        endSession("Your session has ended. Sign in again to carry on."),
      ),
    Math.max(10, body.expires_in - 30) * 1000,
  );
}

/** Completes a sign-in when Keycloak has sent the browser back with a code. */
async function finishSignIn() {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  if (!code) return;
  const saved = JSON.parse(sessionStorage.getItem("pkce") ?? "null");
  sessionStorage.removeItem("pkce");
  history.replaceState(null, "", "/");
  if (!saved || saved.state !== query.get("state"))
    throw new Error("Sign-in could not be verified");
  await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: saved.verifier,
  });
}

function signOut() {
  const idToken = tokens?.id;
  tokens = null;
  location.assign(
    `${oidc}/logout?${new URLSearchParams({
      post_logout_redirect_uri: redirectUri,
      ...(idToken ? { id_token_hint: idToken } : { client_id: config.clientId }),
    })}`,
  );
}

// ---------------------------------------------------------------- customer

const STATUS = {
  open: ["Being handled", "warn"],
  waiting_approval: ["Waiting for our team to approve", "warn"],
  waiting_customer: ["We asked you a question", "warn"],
  handed_to_staff: ["With our team", "warn"],
  resolved: ["Resolved", "good"],
  refused: ["Declined", "bad"],
};
/** Statuses that change without the customer doing anything. */
const IN_PROGRESS = ["open", "waiting_approval", "handed_to_staff"];

const AUTHORS = { agent: "Proofdesk", customer: "You", staff: "Our team" };

/** A ticket's messages after the first, oldest first. */
function conversation(messages, labels = AUTHORS) {
  return messages.map((message) =>
    el(
      "div",
      { class: `reply ${message.author}` },
      el(
        "div",
        { class: "author" },
        labels[message.author] ?? message.author,
        when(message.createdAt, " · "),
      ),
      message.body,
    ),
  );
}

/** The head of a ticket: its subject, where it stands, and since when. */
const ticketHead = (subject, pill, time) =>
  el("div", { class: "row head" }, el("strong", {}, subject), pill, time);

function customerView() {
  const requests = keyedList("No requests yet.");

  function ticketCard(ticket, refresh) {
    const [label, tone] = STATUS[ticket.status] ?? [words(ticket.status), "warn"];
    const answer = el("textarea", {
      maxlength: "10000",
      placeholder: "Your answer",
      "aria-label": `Your answer about: ${ticket.subject}`,
    });
    return el(
      "article",
      { class: "item" },
      ticketHead(
        ticket.subject,
        el("span", { class: `pill ${tone}` }, label),
        when(ticket.createdAt),
      ),
      el("p", { class: "body" }, ticket.body),
      conversation(ticket.messages),
      // The agent asked something. Answering carries the same request on.
      ticket.status === "waiting_customer"
        ? el(
            "div",
            { class: "answer" },
            answer,
            action(
              "Reply",
              async () => {
                if (!answer.value.trim()) throw new Error("Write your answer first.");
                await api("POST", `/tickets/${ticket.id}/messages`, { body: answer.value });
                await refresh();
              },
              { class: "primary" },
            ),
          )
        : null,
    );
  }

  const refresh = live(
    requests.node,
    () => api("GET", "/tickets"),
    ({ tickets }) =>
      requests.show(
        tickets,
        (ticket) => `${ticket.status} ${ticket.messages.length}`,
        (ticket) => ticketCard(ticket, refresh),
      ),
    requests.fail,
    // Keep looking while something is still in progress.
    ({ tickets }) => (tickets.some((ticket) => IN_PROGRESS.includes(ticket.status)) ? 2500 : 0),
  );

  const category = el(
    "select",
    {},
    el("option", { value: "refund" }, "A refund"),
    el("option", { value: "plan_change" }, "A change to my plan or seats"),
  );
  const subject = el("input", { type: "text", maxlength: "200" });
  const body = el("textarea", { maxlength: "10000" });
  const email = el("input", { type: "email", autocomplete: "off" });
  const deletionNote = el("p", { class: "notice", role: "status" });

  return [
    el(
      "section",
      {},
      el("h2", {}, "New request"),
      field("What is it about?", category),
      field("Subject", subject),
      field("Details", body),
      el(
        "p",
        { class: "actions" },
        action(
          "Send",
          async () => {
            if (!subject.value.trim() || !body.value.trim()) {
              throw new Error("Add a subject and some details.");
            }
            await api("POST", "/tickets", {
              category: category.value,
              subject: subject.value,
              body: body.value,
            });
            subject.value = "";
            body.value = "";
            await refresh();
          },
          { class: "primary" },
        ),
      ),
    ),
    el("section", {}, el("h2", {}, "Your requests"), requests.node),
    el(
      "section",
      {},
      el("h2", {}, "Delete my account"),
      el(
        "p",
        { class: "muted" },
        "This closes your subscription and deletes your requests and your sign-in. Payment records the company must keep are kept. It cannot be undone.",
      ),
      field("Type your email address to confirm", email),
      el(
        "p",
        { class: "actions" },
        action(
          "Delete my account",
          async () => {
            try {
              await api("POST", "/account/deletion-request", { confirmEmail: email.value });
              deletionNote.textContent = "Your request has been accepted and is being carried out.";
            } catch (error) {
              if (error.code !== "sign_in_too_old") throw error;
              deletionNote.textContent =
                "For this, you need to have signed in within the last five minutes. Sign out, sign in again and repeat.";
            }
          },
          { class: "danger" },
        ),
      ),
      deletionNote,
    ),
  ];
}

// ---------------------------------------------------------------- approver

const TOOL_NAMES = {
  create_refund: "Refund",
  change_plan: "Plan change",
  search_help_center: "Help center search",
};
const toolName = (tool) => TOOL_NAMES[tool] ?? words(tool);

const OUTCOMES = {
  refunded: "Refunded",
  plan_changed: "Plan changed",
  refused: "Refused",
  needs_clarification: "Asked the customer a question",
  handed_to_staff: "Handed to staff",
};
const REASONS = [
  "duplicate_charge",
  "within_window",
  "outside_window",
  "already_refunded",
  "no_duplicate_found",
  "goodwill_limit_reached",
  "dispute_open",
  "invoice_not_found",
  "invoice_unclear",
  "not_charged",
  "plan_changed",
  "request_unclear",
  "plan_not_available",
  "other",
];
/** A menu that starts on nothing, so that a choice on record is one a person made. */
const choice = (entries) =>
  el(
    "select",
    {},
    el("option", { value: "", disabled: true, selected: true }, "Choose…"),
    entries.map(([value, label]) => el("option", { value }, label)),
  );

/** A section whose heading carries how many entries are waiting in it. */
function queueSection(heading, intro, list) {
  const count = el("span", { class: "count", hidden: true });
  return {
    count(number) {
      count.hidden = number === 0;
      count.textContent = String(number);
    },
    node: el(
      "section",
      {},
      el("div", { class: "row" }, el("h2", {}, heading), count),
      intro ? el("p", { class: "muted intro" }, intro) : null,
      list.node,
    ),
  };
}

function approverView() {
  const staffLabels = { agent: "Agent", customer: "Customer", staff: "Staff" };

  // ---- approvals

  const approvals = keyedList("Nothing is waiting.");
  const approvalsSection = queueSection("Waiting for approval", "", approvals);

  function approvalCard(row, refresh) {
    const summary = row.summary && typeof row.summary === "object" ? row.summary : {};
    const facts = Object.entries(summary).filter(
      ([key, value]) => key !== "tool" && key !== "amountCents" && typeof value !== "object",
    );
    const buttons = el("div", { class: "row actions" });
    const decide = (decision, done) => async () => {
      await api("POST", `/staff/approvals/${row.id}/decision`, { decision });
      // The decision travels to the ticket's workflow, and the entry leaves
      // the list once it has arrived.
      buttons.replaceChildren(el("span", { class: "muted", role: "status" }, done));
      setTimeout(refresh, 1000);
    };
    buttons.append(
      action("Approve", decide("approved", "Approved. Carrying it out…"), { class: "primary" }),
      action("Reject", decide("rejected", "Rejected. Telling the agent…"), { class: "danger" }),
    );
    return el(
      "article",
      { class: "item" },
      ticketHead(
        `${toolName(row.tool)}${summary.amountCents ? ` of ${money(summary.amountCents)}` : ""}`,
        el("span", { class: "pill warn" }, "Needs a decision"),
        when(row.requestedAt, "asked "),
      ),
      el("p", { class: "why" }, row.reason),
      facts.length > 0
        ? el(
            "dl",
            { class: "facts" },
            facts.flatMap(([key, value]) => [
              el("dt", {}, words(key)),
              el(
                "dd",
                {},
                key.endsWith("Cents")
                  ? money(value)
                  : /^[a-z]+(_[a-z]+)+$/.test(value)
                    ? words(value)
                    : String(value),
              ),
            ]),
          )
        : null,
      row.ticket
        ? el(
            "div",
            { class: "reply customer" },
            el("div", { class: "author" }, "The customer's request"),
            el("strong", {}, row.ticket.subject),
            "\n",
            row.ticket.body,
          )
        : null,
      buttons,
    );
  }

  const refreshApprovals = live(
    approvals.node,
    () => api("GET", "/staff/approvals"),
    ({ approvals: rows }) => {
      approvalsSection.count(rows.length);
      approvals.show(
        rows,
        () => "",
        (row) => approvalCard(row, refreshApprovals),
      );
    },
    approvals.fail,
    () => 5000,
  );

  // ---- tickets waiting for a person to answer

  const handedOver = keyedList("Nobody is waiting.");
  const handedOverSection = queueSection(
    "Waiting for a reply from staff",
    "The agent passed these on. Your reply goes to the customer and closes the request.",
    handedOver,
  );

  function handedOverCard(ticket, refresh) {
    const reply = el("textarea", {
      maxlength: "4000",
      placeholder: "Your reply to the customer",
      "aria-label": `Your reply about: ${ticket.subject}`,
    });
    const send = (resolution) => async () => {
      if (!reply.value.trim()) throw new Error("Write a reply first.");
      await api("POST", `/staff/tickets/${ticket.id}/reply`, { body: reply.value, resolution });
      await refresh();
    };
    return el(
      "article",
      { class: "item" },
      ticketHead(
        ticket.subject,
        el("span", { class: "pill warn" }, words(ticket.reasonCode ?? "handed over")),
        when(ticket.handedOverAt, "handed over "),
      ),
      el("p", { class: "body" }, ticket.body),
      conversation(ticket.messages, staffLabels),
      el(
        "div",
        { class: "answer" },
        reply,
        el(
          "div",
          { class: "row" },
          action("Reply and resolve", send("resolved"), { class: "primary" }),
          action(
            "Reply and decline",
            send("refused"),
            { class: "danger" },
            "Decline this request?",
          ),
        ),
      ),
    );
  }

  const refreshHandedOver = live(
    handedOver.node,
    () => api("GET", "/staff/handed-over"),
    ({ tickets }) => {
      handedOverSection.count(tickets.length);
      handedOver.show(
        tickets,
        (ticket) => String(ticket.messages.length),
        (ticket) => handedOverCard(ticket, refreshHandedOver),
      );
    },
    handedOver.fail,
    () => 10_000,
  );

  // ---- the review queue

  const queue = keyedList("Nothing to review.");
  const queueBox = queueSection(
    "Review the agent's work",
    "Tickets the agent handed over, and a random share of the ones it resolved itself. Say what should have happened. A verdict can be turned into a test the agent must pass from then on.",
    queue,
  );

  function reviewCard(ticket, refresh) {
    const sample = ticket.why === "sample";
    const verdict = choice(
      sample
        ? [
            ["agent_right", "The agent got this right"],
            ["agent_wrong", "The agent got this wrong"],
          ]
        : [
            ["agent_right", "The agent was right to hand it over"],
            ["agent_wrong", "The agent should have handled this"],
          ],
    );
    const outcome = choice(Object.entries(OUTCOMES));
    const reason = choice(
      [...new Set([...REASONS, ...(ticket.reasonCode ? [ticket.reasonCode] : [])])].map((code) => [
        code,
        words(code),
      ]),
    );
    reason.setAttribute("aria-label", "The reason");

    const refunds = ticket.invoices.flatMap((invoice) =>
      invoice.payments.map((payment) => {
        const box = el("input", { type: "checkbox" });
        const amount = el("input", {
          type: "number",
          min: "0.01",
          step: "0.01",
          value: (payment.amountCents / 100).toFixed(2),
          class: "amount",
          "aria-label": `Refund for ${invoice.number}, in dollars`,
        });
        return {
          read: () =>
            box.checked
              ? { paymentId: payment.id, amountCents: Math.round(Number(amount.value) * 100) }
              : null,
          node: el(
            "div",
            { class: "row" },
            el(
              "label",
              { class: "check" },
              box,
              `${invoice.number}: ${money(payment.amountCents)}, ${words(payment.status).toLowerCase()}, ${payment.createdAt.slice(0, 10)}`,
              payment.refundedCents ? ` (${money(payment.refundedCents)} already refunded)` : "",
            ),
            el("span", { class: "muted" }, "refund $"),
            amount,
          ),
        };
      }),
    );
    // Payments are named only for a refund.
    const refundBox = el(
      "fieldset",
      { hidden: true },
      el("legend", {}, "Payments that should have been refunded"),
      refunds.map((refund) => refund.node),
    );
    const showRefunds = () => {
      refundBox.hidden = outcome.value !== "refunded" || refunds.length === 0;
    };
    outcome.addEventListener("change", showRefunds);
    // Agreeing with the agent means the result it reached was the right one.
    verdict.addEventListener("change", () => {
      if (verdict.value !== "agent_right") return;
      outcome.value = sample ? ticket.outcome : "handed_to_staff";
      if (ticket.reasonCode) reason.value = ticket.reasonCode;
      showRefunds();
    });

    return el(
      "article",
      { class: "item" },
      ticketHead(
        ticket.subject,
        sample
          ? el(
              "span",
              { class: "pill good" },
              `Random check: ${(OUTCOMES[ticket.outcome] ?? words(ticket.outcome)).toLowerCase()}`,
            )
          : el("span", { class: "pill warn" }, words(ticket.reasonCode ?? "handed over")),
        when(ticket.resolvedAt),
      ),
      el("p", { class: "body" }, ticket.body),
      // For a random check, what the agent told the customer.
      sample && ticket.reply
        ? el("div", { class: "reply agent" }, el("div", { class: "author" }, "Agent"), ticket.reply)
        : null,
      field("Verdict", verdict),
      field("What the result should have been", outcome),
      reason,
      refundBox,
      el(
        "p",
        { class: "actions" },
        action("Save verdict", async () => {
          if (!verdict.value || !outcome.value || !reason.value) {
            throw new Error("Choose a verdict, a result and a reason.");
          }
          const expectedRefunds =
            outcome.value === "refunded"
              ? refunds.map((refund) => refund.read()).filter(Boolean)
              : [];
          if (outcome.value === "refunded" && refunds.length > 0 && expectedRefunds.length === 0) {
            throw new Error("Tick the payment that should have been refunded.");
          }
          if (expectedRefunds.some((refund) => !(refund.amountCents > 0))) {
            throw new Error("A refund needs an amount above zero.");
          }
          await api("POST", `/staff/review-queue/${ticket.id}`, {
            verdict: verdict.value,
            expectedOutcome: outcome.value,
            expectedReason: reason.value,
            expectedRefunds,
          });
          await refresh();
        }),
      ),
    );
  }

  const refreshQueue = live(
    queue.node,
    () => api("GET", "/staff/review-queue"),
    ({ tickets }) => {
      queueBox.count(tickets.length);
      queue.show(
        tickets,
        () => "",
        (ticket) => reviewCard(ticket, refreshQueue),
      );
    },
    queue.fail,
    () => 10_000,
  );

  return [approvalsSection.node, handedOverSection.node, queueBox.node];
}

// ---------------------------------------------------------------- operator

const TOOLS = ["create_refund", "change_plan", "search_help_center"];

function operatorView(who) {
  const headline = el("p", { class: "headline" }, el("span", { class: "muted" }, "Loading…"));
  const state = el("div", { class: "list switches" });
  const reason = el("input", { type: "text", maxlength: "200", placeholder: "Reason" });
  const tool = el(
    "select",
    {},
    el("option", { value: "" }, "The whole agent"),
    TOOLS.map((value) => el("option", { value }, toolName(value))),
  );
  const toggle = el("p", { class: "actions" });
  let controls = [];
  let shown;

  const set = (paused) => async () => {
    await api("POST", "/staff/agent-controls", {
      ...(tool.value ? { tool: tool.value } : {}),
      paused,
      reason:
        reason.value.trim() || (paused ? "Paused from the console" : "Resumed from the console"),
    });
    reason.value = "";
    await refresh();
  };

  /** One button, for the one thing that can be done to what is chosen. */
  function drawToggle() {
    const scope = tool.value ? `tool:${tool.value}` : "agent";
    const paused = controls.find((control) => control.scope === scope)?.paused ?? false;
    if (shown === `${scope} ${paused}`) return;
    shown = `${scope} ${paused}`;
    toggle.replaceChildren(
      paused
        ? action("Resume", set(false), { class: "primary" })
        : action("Pause", set(true), { class: "danger solid" }),
    );
  }
  tool.addEventListener("change", drawToggle);

  function show({ controls: rows }) {
    controls = rows;
    const agentPaused = rows.some((control) => control.scope === "agent" && control.paused);
    const toolsPaused = rows.filter((control) => control.scope !== "agent" && control.paused);
    headline.replaceChildren(
      agentPaused
        ? el("span", { class: "pill bad" }, "The agent is paused")
        : el("span", { class: "pill good" }, "The agent is running"),
      ...(!agentPaused && toolsPaused.length > 0
        ? [
            el(
              "span",
              { class: "pill warn" },
              `${toolsPaused.length} ${toolsPaused.length === 1 ? "tool" : "tools"} paused`,
            ),
          ]
        : []),
    );
    state.replaceChildren(
      ...rows.map((control) =>
        el(
          "div",
          { class: "item" },
          el(
            "div",
            { class: "row head" },
            el(
              "strong",
              {},
              control.scope === "agent" ? "Whole agent" : toolName(control.scope.slice(5)),
            ),
            el(
              "span",
              { class: `pill ${control.paused ? "bad" : "good"}` },
              control.paused ? "paused" : "running",
            ),
            when(control.setAt),
          ),
          el(
            "p",
            { class: "muted" },
            `${control.reason} · ${control.setBy === `staff:${who.sub}` ? "you" : control.setBy}`,
          ),
        ),
      ),
    );
    drawToggle();
  }

  const refresh = live(
    state,
    () => api("GET", "/staff/agent-controls"),
    show,
    (error) =>
      headline.replaceChildren(el("span", { class: "error", role: "alert" }, error.message)),
    () => 10_000,
  );

  return [
    el(
      "section",
      {},
      el("h2", {}, "Kill switch"),
      headline,
      el(
        "p",
        { class: "muted intro" },
        "A pause takes effect at the agent's next step, including on tickets in progress and on refunds already approved. A paused agent makes no model calls; its tickets go to staff.",
      ),
      field("What to stop or restart", tool),
      field("Reason", reason),
      toggle,
      state,
    ),
  ];
}

// ---------------------------------------------------------------- page

function render() {
  if (!tokens) {
    sessionBox.replaceChildren();
    app.replaceChildren(
      el(
        "section",
        { class: "welcome" },
        el("h2", {}, "Sign in"),
        notice ? el("p", { class: "notice", role: "status" }, notice) : null,
        el(
          "p",
          { class: "muted" },
          "Customers file requests and see the replies. Staff approve refunds, review what the agent handed over, and can stop the agent.",
        ),
        el("button", { type: "button", class: "primary", onclick: signIn }, "Sign in"),
      ),
    );
    notice = "";
    return;
  }
  const who = claims(tokens.access);
  const person = tokens.id ? claims(tokens.id) : {};
  const role = who.staff_role ?? (who.customer_id ? "customer" : "unknown");
  sessionBox.replaceChildren(
    el(
      "span",
      { class: "row" },
      person.name ? el("span", { class: "name" }, person.name) : null,
      el("span", { class: "muted" }, `Signed in as ${role}`),
      el("button", { type: "button", onclick: signOut }, "Sign out"),
    ),
  );
  const view =
    role === "customer"
      ? customerView()
      : role === "approver"
        ? approverView()
        : role === "operator"
          ? operatorView(who)
          : [el("section", {}, el("p", {}, "This account has no role here."))];
  app.replaceChildren(...view);
}

try {
  await finishSignIn();
} catch (error) {
  notice = error.message;
}
render();
