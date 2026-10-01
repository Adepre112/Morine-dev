/* HTTPS transactional-email transport for Morine's password-reset mail.
 *
 * Render's FREE plan blocks outbound SMTP (ports 25/465/587), so Nodemailer
 * cannot reach Gmail from production. When EMAIL_PROVIDER=brevo the message is
 * handed to Brevo's REST API over ordinary HTTPS (port 443), which Render Free
 * allows. EMAIL_PROVIDER=smtp (or unset) selects the original Nodemailer path
 * in controllers/authController.js - this module never speaks SMTP.
 *
 * Required when EMAIL_PROVIDER=brevo (NAMES only, values are never logged):
 *   BREVO_API_KEY   Brevo API key, sent in the `api-key` request header.
 *   EMAIL_FROM      the sender address. It is reduced to a BARE address here
 *                   (see resolveSender) because Brevo's `sender.email` is
 *                   `format: email` and rejects a "Name <addr>" wrapper.
 *                   The address must also be VERIFIED in the Brevo account.
 *   EMAIL_FROM_NAME the sender display name, sent as `sender.name`.
 * Optional: EMAIL_TIMEOUT_MS (default 10000, capped at 60000).
 *
 * Secrets handled here: BREVO_API_KEY. It is read into the `api-key` request
 * header and nowhere else - never into a log line, never into an error
 * message, and safeDetail() scrubs it defensively out of any detail text
 * before that text can reach a console call. Reset tokens and passwords never
 * reach this module at all: it receives only { to, subject, html }. */

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_TIMEOUT_MS = 10000;

/* Same vocabulary as EMAIL_STATUS in controllers/authController.js, so the
   Render log shows one set of failure classes whichever transport sent the
   mail. Kept local rather than imported because authController requires THIS
   module, and requiring it back would be a cycle. */
const EMAIL_STATUS = {
  NOT_CONFIGURED: "NOT_CONFIGURED",     // env vars absent
  CONNECTION_FAILED: "CONNECTION_FAILED", // timeout / network / TLS
  AUTH_FAILED: "AUTH_FAILED",           // API key rejected (401/403)
  ENVELOPE_REJECTED: "ENVELOPE_REJECTED", // bad sender / recipient rejected
  MESSAGE_REJECTED: "MESSAGE_REJECTED", // provider refused the message
  SEND_FAILED: "SEND_FAILED",           // anything else
  SENT: "SENT",                         // provider accepted the message
};

/** "brevo" only when the operator opted in; anything else keeps legacy SMTP. */
function getEmailProvider() {
  return String(process.env.EMAIL_PROVIDER || "smtp").trim().toLowerCase();
}

/** Env var NAMES brevo mode still needs (NAMES only - never the values). */
function missingBrevoEnv() {
  return ["BREVO_API_KEY", "EMAIL_FROM", "EMAIL_FROM_NAME"].filter(
    (key) => !String(process.env[key] || "").trim()
  );
}

/* Brevo's POST /v3/smtp/email takes the sender as TWO fields: `sender.email`
   is declared `format: email` (a BARE address) and `sender.name` is a separate
   display-name field capped at 70 characters. The SMTP path in
   authController.js instead uses one RFC-5322 mailbox string
   ("Morine <noreply@example.com>"), which is what EMAIL_FROM was documented as
   and what many operators therefore typed into it. Handing that whole string to
   sender.email makes Brevo answer 400 and the mail is refused, so the address
   is extracted here instead of being trusted to already be bare. */
const ANGLE_ADDRESS = /^\s*(?:"([^"]*)"|([^<>]*?))\s*<\s*([^\s@<>"']+@[^\s@<>"']+)\s*>\s*$/;
const BARE_ADDRESS = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** Splits an RFC-5322 mailbox into its display name and bare address.
 *  "Morine <a@b.com>" -> { name: "Morine", email: "a@b.com" }
 *  "a@b.com"          -> { name: "",     email: "a@b.com" }
 *  Anything unparsable -> { name: "",     email: the trimmed input } so the
 *  caller can reject it by testing `email` against BARE_ADDRESS. */
function parseFromAddress(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { email: "", name: "" };
  const angled = s.match(ANGLE_ADDRESS);
  if (!angled) return { email: s, name: "" };
  return {
    email: angled[3].trim(),
    name: (angled[1] || angled[2] || "").trim(),
  };
}

/** The exact payload Brevo must receive. `email` is always a bare address;
 *  `name` is EMAIL_FROM_NAME, falling back to a display name embedded in
 *  EMAIL_FROM so a legacy "Name <addr>" value still produces a correct From.
 *  Returns { email, name, valid } - `valid` is false when EMAIL_FROM does not
 *  reduce to a bare address, which is the condition Brevo would reject. */
function resolveSender() {
  const parsed = parseFromAddress(process.env.EMAIL_FROM);
  const configuredName = String(process.env.EMAIL_FROM_NAME || "").trim();
  const name = (configuredName || parsed.name || "").slice(0, 70);
  return {
    email: parsed.email,
    name,
    valid: BARE_ADDRESS.test(parsed.email),
  };
}

function readTimeoutMs() {
  const raw = Number(process.env.EMAIL_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(raw, 60000);
}

/** Removes the API key, e-mail addresses and long token runs from any text
 *  that is about to be turned into a log detail. Mirrors redactForLog() in
 *  authController.js so both transports redact the same way. */
function safeDetail(text) {
  let s = String(text == null ? "" : text);
  const key = process.env.BREVO_API_KEY;
  if (key && key.length >= 8) s = s.split(key).join("[redacted-key]");
  return s
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, "[address]")
    .replace(/[A-Za-z0-9+/=]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** A delivery failure. `emailClass` is one of EMAIL_STATUS; `info` only ever
 *  carries an HTTP status number, a provider error code, a timeout in ms or
 *  a list of missing env var names - never a secret. */
class EmailSendError extends Error {
  constructor(message, emailClass, info) {
    super(message);
    this.name = "EmailSendError";
    this.emailClass = emailClass || EMAIL_STATUS.SEND_FAILED;
    this.info = info || null;
  }
}

/** Maps a non-2xx Brevo response onto one of EMAIL_STATUS.
 *
 *  400/404/422 is a parameter-validation family, and the only actionable split
 *  inside it is "the envelope was refused" (an unverified/malformed sender, a
 *  bad recipient address) versus everything else. Brevo words those several
 *  ways - "sender", "from", "recipient", "envelope", and the bare "address" in
 *  messages such as `Invalid 'to' address` - so all of them are matched. The
 *  match is word-bounded so an incidental substring cannot promote an unrelated
 *  failure to ENVELOPE_REJECTED. */
function classifyFailure(status, haystack) {
  if (status === 401 || status === 403) return EMAIL_STATUS.AUTH_FAILED;
  if (status === 554) return EMAIL_STATUS.MESSAGE_REJECTED;
  if (status === 400 || status === 404 || status === 422) {
    if (/\b(sender|from|recipient|envelope|address|addresses|adresse)s?\b/i.test(haystack)) {
      return EMAIL_STATUS.ENVELOPE_REJECTED;
    }
  }
  return EMAIL_STATUS.SEND_FAILED;
}

/** One log line naming the failure class an operator can act on. Built only
 *  from status/code/scrubbed message - safe to print. */
function describeEmailError(error) {
  const parts = ["class=" + ((error && error.emailClass) || EMAIL_STATUS.SEND_FAILED)];
  const info = (error && error.info) || {};
  if (typeof info.status === "number") parts.push("status=" + info.status);
  if (info.code) parts.push("code=" + safeDetail(String(info.code)));
  if (Array.isArray(info.missing) && info.missing.length) parts.push("missing=" + info.missing.join(","));
  if (typeof info.timeoutMs === "number") parts.push("timeoutMs=" + info.timeoutMs);
  parts.push("detail=" + JSON.stringify(safeDetail(error && error.message)));
  return parts.join(" ");
}

/** Sends one message through Brevo's REST API over HTTPS.
 *
 *  POST https://api.brevo.com/v3/smtp/email
 *  headers: Content-Type: application/json, api-key: <BREVO_API_KEY>
 *  body:    { sender: { name: EMAIL_FROM_NAME, email: <bare EMAIL_FROM> },
 *            to: [{ email }], subject, htmlContent }
 *
 *  Aborts after ~10s (EMAIL_TIMEOUT_MS overrides). Resolves { ok: true } when
 *  Brevo answers 2xx; throws EmailSendError otherwise. */
async function sendBrevoEmail(message) {
  const to = message && message.to;
  const subject = message && message.subject;
  const html = message && message.html;

  if (typeof fetch !== "function") {
    throw new EmailSendError(
      "native fetch() is unavailable - Render must run Node 18 or newer",
      EMAIL_STATUS.NOT_CONFIGURED,
      { missing: ["NODE_FETCH"] }
    );
  }

  const missing = missingBrevoEnv();
  if (missing.length) {
    throw new EmailSendError(
      "brevo is not configured (EMAIL_PROVIDER=brevo) - missing " + missing.join(", "),
      EMAIL_STATUS.NOT_CONFIGURED,
      { missing }
    );
  }
  if (!to) {
    throw new EmailSendError("brevo send has no recipient", EMAIL_STATUS.ENVELOPE_REJECTED, null);
  }

  /* Resolve the sender BEFORE opening a connection, so a misconfigured
   * EMAIL_FROM fails fast and locally instead of costing a round trip to Brevo
   * and coming back as an opaque 400. Brevo additionally requires this address
   * to be registered and verified on the account; that check is Brevo's and its
   * error is classified as ENVELOPE_REJECTED by classifyFailure(). */
  const sender = resolveSender();
  if (!sender.valid) {
    throw new EmailSendError(
      "EMAIL_FROM is not a usable sender address - set it to a BARE address " +
        "(noreply@yourdomain.com) verified in the Brevo account; Brevo's " +
        "sender.email must never contain a \"Name <addr>\" wrapper",
      EMAIL_STATUS.ENVELOPE_REJECTED,
      { status: 400, code: "invalid_sender" }
    );
  }

  const waitMs = readTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);

  let response;
  try {
    response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: sender.name, email: sender.email },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new EmailSendError(
        "brevo request timed out after " + waitMs + "ms",
        EMAIL_STATUS.CONNECTION_FAILED,
        { timeoutMs: waitMs }
      );
    }
    // Only the error NAME and a transport-level cause code (ECONNREFUSED,
    // ENOTFOUND, ...) are kept: fetch's own message is not logged because it
    // is not needed and this is a security-sensitive path.
    const cause = err && err.cause && err.cause.code ? String(err.cause.code) : "";
    throw new EmailSendError(
      "brevo request failed (" + ((err && err.name) || "Error") + (cause ? "/" + cause : "") + ")",
      EMAIL_STATUS.CONNECTION_FAILED,
      null
    );
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  let raw = "";
  let payload = null;
  try {
    raw = await response.text();
    if (raw) payload = JSON.parse(raw);
  } catch (err) {
    payload = null; // empty or non-JSON body - the status alone decides
  }

  if (response.ok) {
    return { ok: true, status, messageId: (payload && payload.messageId) || null };
  }

  const code = payload && payload.code ? String(payload.code) : "";
  const providerMessage = payload && payload.message ? String(payload.message) : raw;
  throw new EmailSendError(
    "brevo rejected the request - status=" + status +
      (code ? " code=" + code : "") +
      (providerMessage ? " detail=" + JSON.stringify(safeDetail(providerMessage)) : ""),
    classifyFailure(status, code + " " + providerMessage),
    { status, code }
  );
}

module.exports = {
  getEmailProvider,
  missingBrevoEnv,
  sendBrevoEmail,
  describeEmailError,
  parseFromAddress,
  resolveSender,
  EMAIL_STATUS,
  BREVO_API_URL,
};
