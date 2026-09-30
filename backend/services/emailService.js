/* HTTPS transactional-email transport for Morine's password-reset mail.
 *
 * Render's FREE plan blocks outbound SMTP (ports 25/465/587), so Nodemailer
 * cannot reach Gmail from production. When EMAIL_PROVIDER=brevo the message is
 * handed to Brevo's REST API over ordinary HTTPS (port 443), which Render Free
 * allows. EMAIL_PROVIDER=smtp (or unset) selects the original Nodemailer path
 * in controllers/authController.js - this module never speaks SMTP.
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

/** Maps a non-2xx Brevo response onto one of EMAIL_STATUS. */
function classifyFailure(status, haystack) {
  if (status === 401 || status === 403) return EMAIL_STATUS.AUTH_FAILED;
  if (status === 554) return EMAIL_STATUS.MESSAGE_REJECTED;
  if (status === 400 || status === 404 || status === 422) {
    if (/sender|from|recipient|envelope/i.test(haystack)) return EMAIL_STATUS.ENVELOPE_REJECTED;
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
 *  body:    { sender: { name, email }, to: [{ email }], subject, htmlContent }
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
        sender: { name: process.env.EMAIL_FROM_NAME, email: process.env.EMAIL_FROM },
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
  EMAIL_STATUS,
  BREVO_API_URL,
};
