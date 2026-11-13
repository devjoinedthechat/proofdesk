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

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const base64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const claims = (token) =>
  JSON.parse(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")));

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
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? `Request failed (${response.status})`);
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

/** Runs an action from a button, showing its error next to the button if it fails. */
function action(label, run, attributes = {}) {
  const note = el("span", { class: "error" });
  const button = el(
    "button",
    {
      ...attributes,
      onclick: async () => {
        button.disabled = true;
        note.textContent = "";
        try {
          await run();
        } catch (error) {
          note.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      },
    },
    label,
  );
  return el("span", { class: "row" }, button, note);
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
      tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh }).catch(() => {
        tokens = null;
        render();
      }),
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

const AUTHORS = { agent: "Proofdesk", customer: "You", staff: "Our team" };

/** A ticket's messages after the first, oldest first. */
function conversation(messages, labels = AUTHORS) {
  return messages.map((message) =>
    el(
      "div",
      { class: `reply ${message.author}` },
      el("div", { class: "muted author" }, labels[message.author] ?? message.author),
      message.body,
    ),
  );
}

function customerView() {
  const list = el("div");
  let timer;

  async function load() {
    const { tickets } = await api("GET", "/tickets");
    list.replaceChildren(
      ...(tickets.length === 0 ? [el("p", { class: "muted" }, "No requests yet.")] : []),
      ...tickets.map((ticket) => {
        const [label, tone] = STATUS[ticket.status] ?? [ticket.status, "warn"];
        const answer = el("textarea", { maxlength: "10000", placeholder: "Your answer" });
        return el(
          "div",
          { class: "item" },
          el(
            "div",
            { class: "row" },
            el("strong", {}, ticket.subject),
            el("span", { class: `pill ${tone}` }, label),
          ),
          el("p", { class: "muted" }, ticket.body),
          conversation(ticket.messages),
          // The agent asked something. Answering carries the same request on.
          ticket.status === "waiting_customer"
            ? el(
                "div",
                {},
                answer,
                el(
                  "p",
                  {},
                  action("Reply", async () => {
                    await api("POST", `/tickets/${ticket.id}/messages`, { body: answer.value });
                    await load();
                  }),
                ),
              )
            : null,
        );
      }),
    );
    clearTimeout(timer);
    // Keep looking while something is still in progress.
    if (tickets.some((ticket) => ["open", "waiting_approval"].includes(ticket.status))) {
      timer = setTimeout(() => load().catch(() => {}), 2500);
    }
  }

  const category = el(
    "select",
    {},
    el("option", { value: "refund" }, "A refund"),
    el("option", { value: "plan_change" }, "A change to my plan or seats"),
  );
  const subject = el("input", { type: "text", maxlength: "200" });
  const body = el("textarea", { maxlength: "10000" });
  const email = el("input", { type: "email", autocomplete: "off" });
  const deletionNote = el("p", { class: "notice" });

  load().catch((error) => list.replaceChildren(el("p", { class: "error" }, error.message)));

  return [
    el(
      "section",
      {},
      el("h2", {}, "New request"),
      el("label", {}, "What is it about?"),
      category,
      el("label", {}, "Subject"),
      subject,
      el("label", {}, "Details"),
      body,
      el(
        "p",
        {},
        action(
          "Send",
          async () => {
            await api("POST", "/tickets", {
              category: category.value,
              subject: subject.value,
              body: body.value,
            });
            subject.value = "";
            body.value = "";
            await load();
          },
          { class: "primary" },
        ),
      ),
    ),
    el("section", {}, el("h2", {}, "Your requests"), list),
    el(
      "section",
      {},
      el("h2", {}, "Delete my account"),
      el(
        "p",
        { class: "muted" },
        "This closes your subscription and deletes your requests and your sign-in. Payment records the company must keep are kept. It cannot be undone. Type your email address to confirm.",
      ),
      email,
      el(
        "p",
        {},
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

const OUTCOMES = ["refunded", "plan_changed", "refused", "needs_clarification", "handed_to_staff"];
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
const options = (values) => values.map((value) => el("option", { value }, value));

function approverView() {
  const approvals = el("div");
  const queue = el("div");
  const handedOver = el("div");
  const staffLabels = { agent: "Agent", customer: "Customer", staff: "Staff" };

  async function loadHandedOver() {
    const { tickets } = await api("GET", "/staff/handed-over");
    handedOver.replaceChildren(
      ...(tickets.length === 0 ? [el("p", { class: "muted" }, "Nobody is waiting.")] : []),
      ...tickets.map((ticket) => {
        const reply = el("textarea", {
          maxlength: "4000",
          placeholder: "Your reply to the customer",
        });
        const send = (resolution) => async () => {
          await api("POST", `/staff/tickets/${ticket.id}/reply`, {
            body: reply.value,
            resolution,
          });
          await loadHandedOver();
        };
        return el(
          "div",
          { class: "item" },
          el(
            "div",
            { class: "row" },
            el("strong", {}, ticket.subject),
            el("span", { class: "pill warn" }, ticket.reasonCode ?? "handed over"),
          ),
          el("p", { class: "muted" }, ticket.body),
          conversation(ticket.messages, staffLabels),
          reply,
          el(
            "p",
            { class: "row" },
            action("Reply and resolve", send("resolved"), { class: "primary" }),
            action("Reply and decline", send("refused"), { class: "danger" }),
          ),
        );
      }),
    );
  }

  async function loadApprovals() {
    const { approvals: rows } = await api("GET", "/staff/approvals");
    approvals.replaceChildren(
      ...(rows.length === 0 ? [el("p", { class: "muted" }, "Nothing is waiting.")] : []),
      ...rows.map((row) => {
        const decide = (decision) => async () => {
          await api("POST", `/staff/approvals/${row.id}/decision`, { decision });
          // The decision travels to the ticket's workflow; give it a moment.
          setTimeout(() => loadApprovals().catch(() => {}), 1500);
        };
        return el(
          "div",
          { class: "item" },
          el(
            "p",
            {},
            el("strong", {}, row.tool),
            row.summary?.amountCents ? ` for ${money(row.summary.amountCents)}` : "",
            el("span", { class: "muted" }, ` · ticket ${row.ticketId}`),
          ),
          el("p", { class: "muted" }, row.reason),
          el(
            "div",
            { class: "row" },
            action("Approve", decide("approved"), { class: "primary" }),
            action("Reject", decide("rejected"), { class: "danger" }),
          ),
        );
      }),
    );
  }

  async function loadQueue() {
    const { tickets } = await api("GET", "/staff/review-queue");
    queue.replaceChildren(
      ...(tickets.length === 0 ? [el("p", { class: "muted" }, "Nothing to review.")] : []),
      ...tickets.map((ticket) => {
        const verdict = el(
          "select",
          {},
          el("option", { value: "agent_wrong" }, "The agent should have handled this"),
          el("option", { value: "agent_right" }, "The agent was right to hand it over"),
        );
        const outcome = el("select", {}, options(OUTCOMES));
        const reason = el("select", {}, options(REASONS));
        const refunds = ticket.invoices.flatMap((invoice) =>
          invoice.payments.map((payment) => {
            const box = el("input", { type: "checkbox" });
            const amount = el("input", {
              type: "number",
              min: "1",
              value: String(payment.amountCents),
              style: "width: 120px",
            });
            return {
              read: () =>
                box.checked ? { paymentId: payment.id, amountCents: Number(amount.value) } : null,
              node: el(
                "div",
                { class: "row" },
                box,
                el(
                  "span",
                  {},
                  `${invoice.number}: ${money(payment.amountCents)}, ${payment.status}, ${payment.createdAt.slice(0, 10)}`,
                  payment.refundedCents
                    ? ` (${money(payment.refundedCents)} already refunded)`
                    : "",
                ),
                el("span", { class: "muted" }, "refund, in cents:"),
                amount,
              ),
            };
          }),
        );
        return el(
          "div",
          { class: "item" },
          el(
            "div",
            { class: "row" },
            el("strong", {}, ticket.subject),
            el("span", { class: "pill warn" }, ticket.reasonCode ?? "handed over"),
          ),
          el("p", { class: "muted" }, ticket.body),
          el("label", {}, "Verdict"),
          verdict,
          el("label", {}, "What the result should have been"),
          el("div", { class: "row" }, outcome, reason),
          refunds.length > 0 ? el("label", {}, "Payments that should have been refunded") : null,
          refunds.map((refund) => refund.node),
          el(
            "p",
            {},
            action("Save verdict", async () => {
              await api("POST", `/staff/review-queue/${ticket.id}`, {
                verdict: verdict.value,
                expectedOutcome: outcome.value,
                expectedReason: reason.value,
                expectedRefunds: refunds.map((refund) => refund.read()).filter(Boolean),
              });
              await loadQueue();
            }),
          ),
        );
      }),
    );
  }

  const fail = (box) => (error) => box.replaceChildren(el("p", { class: "error" }, error.message));
  loadApprovals().catch(fail(approvals));
  loadHandedOver().catch(fail(handedOver));
  loadQueue().catch(fail(queue));

  return [
    el(
      "section",
      {},
      el(
        "div",
        { class: "row" },
        el("h2", {}, "Waiting for approval"),
        action("Refresh", loadApprovals),
      ),
      approvals,
    ),
    el(
      "section",
      {},
      el(
        "div",
        { class: "row" },
        el("h2", {}, "Waiting for a reply from staff"),
        action("Refresh", loadHandedOver),
      ),
      el(
        "p",
        { class: "muted" },
        "The agent passed these on. Your reply goes to the customer and closes the request.",
      ),
      handedOver,
    ),
    el(
      "section",
      {},
      el(
        "div",
        { class: "row" },
        el("h2", {}, "Review what the agent handed over"),
        action("Refresh", loadQueue),
      ),
      el(
        "p",
        { class: "muted" },
        "Say what should have happened. A verdict can be turned into a test the agent must pass from then on.",
      ),
      queue,
    ),
  ];
}

// ---------------------------------------------------------------- operator

const TOOLS = ["create_refund", "change_plan", "search_help_center"];

function operatorView() {
  const state = el("div");
  const reason = el("input", { type: "text", maxlength: "200", placeholder: "Reason" });
  const tool = el("select", {}, el("option", { value: "" }, "The whole agent"), options(TOOLS));

  async function load() {
    const { controls } = await api("GET", "/staff/agent-controls");
    const paused = controls.filter((control) => control.paused);
    state.replaceChildren(
      el(
        "p",
        {},
        paused.some((control) => control.scope === "agent")
          ? el("span", { class: "pill bad" }, "The agent is paused")
          : el("span", { class: "pill good" }, "The agent is running"),
      ),
      ...controls.map((control) =>
        el(
          "div",
          { class: "item" },
          el(
            "div",
            { class: "row" },
            el("strong", {}, control.scope === "agent" ? "Whole agent" : control.scope.slice(5)),
            el(
              "span",
              { class: `pill ${control.paused ? "bad" : "good"}` },
              control.paused ? "paused" : "running",
            ),
          ),
          el(
            "p",
            { class: "muted" },
            `${control.reason} · ${control.setBy} · ${control.setAt.slice(0, 19).replace("T", " ")}`,
          ),
        ),
      ),
    );
  }

  const set = (paused) => async () => {
    await api("POST", "/staff/agent-controls", {
      ...(tool.value ? { tool: tool.value } : {}),
      paused,
      reason: reason.value || (paused ? "Paused from the console" : "Resumed from the console"),
    });
    reason.value = "";
    await load();
  };
  load().catch((error) => state.replaceChildren(el("p", { class: "error" }, error.message)));

  return [
    el(
      "section",
      {},
      el("h2", {}, "Kill switch"),
      el(
        "p",
        { class: "muted" },
        "A pause takes effect at the agent's next step, including on tickets in progress and on refunds already approved. A paused agent makes no model calls; its tickets go to staff.",
      ),
      el("label", {}, "What to stop or restart"),
      tool,
      el("label", {}, "Reason"),
      reason,
      el(
        "p",
        { class: "row" },
        action("Pause", set(true), { class: "danger" }),
        action("Resume", set(false)),
      ),
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
        {},
        el("h2", {}, "Sign in"),
        el(
          "p",
          { class: "muted" },
          "Customers file requests and see the replies. Staff approve refunds, review what the agent handed over, and can stop the agent.",
        ),
        el("button", { class: "primary", onclick: signIn }, "Sign in"),
      ),
    );
    return;
  }
  const who = claims(tokens.access);
  const role = who.staff_role ?? (who.customer_id ? "customer" : "unknown");
  sessionBox.replaceChildren(
    el(
      "span",
      { class: "row" },
      el("span", { class: "muted" }, `Signed in as ${role}`),
      el("button", { onclick: signOut }, "Sign out"),
    ),
  );
  const view =
    role === "customer"
      ? customerView()
      : role === "approver"
        ? approverView()
        : role === "operator"
          ? operatorView()
          : [el("section", {}, el("p", {}, "This account has no role here."))];
  app.replaceChildren(...view);
}

try {
  await finishSignIn();
} catch (error) {
  app.replaceChildren(el("section", {}, el("p", { class: "error" }, error.message)));
}
render();
