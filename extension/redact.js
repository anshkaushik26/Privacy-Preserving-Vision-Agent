/**
 * Shared PII detection + redaction rules.
 * Used by the content script (browser, attaches to `self.Redact`) and by
 * eval/run_redaction_eval.js (Node, via module.exports) so the extension and
 * the scoring harness never drift apart.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Redact = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  // Digit patterns use (?<!\d)/(?!\d) rather than \b: \b is a word-boundary,
  // and a digit run butting directly against a *letter* (no separating
  // space/punctuation - easy to get from concatenated DOM text with no
  // literal whitespace between sibling elements) has no \b there since both
  // digits and letters count as "word" characters, so the pattern would
  // silently fail to match at all. Anchoring on "not another digit" instead
  // is what we actually mean by "end of the number".
  const PHONE_RE = /(?<!\d)(?:\+\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}(?!\d)/g;
  const SSN_RE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
  // candidate digit runs (allowing spaces/dashes between digits, not after
  // the last one - so a trailing separator isn't swallowed into the match)
  // long enough to be a card number
  const CARD_CANDIDATE_RE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

  // --- Indian PII patterns (Phase 1: high-precision structured formats) ---
  // Aadhaar: exactly 12 digits, first digit 2-9 (real Aadhaar numbers never
  // start 0/1), optionally grouped in 4s. A bare 12-digit regex alone would
  // false-positive constantly, so this is gated by the real Verhoeff
  // checksum algorithm UIDAI uses - same principle as the Luhn check above.
  const AADHAAR_CANDIDATE_RE = /(?<!\d)[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?!\d)/g;
  // PAN: 5 letters + 4 digits + 1 letter, e.g. ABCDE1234F. Fixed format is
  // distinctive enough on its own without a checksum.
  const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
  // IFSC: 4-letter bank code + literal "0" (reserved) + 6 alphanumeric branch
  // code, e.g. HDFC0001234.
  const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
  // Voter ID / EPIC: 3 letters + 7 digits, e.g. ABC1234567.
  const VOTER_ID_RE = /\b[A-Z]{3}[0-9]{7}\b/g;
  // Indian passport: 1 letter + 7 digits, e.g. A1234567. No public checksum
  // to validate against, so this has more false-positive surface than
  // Aadhaar/PAN/IFSC - accepted for phase 1, same tradeoff as the existing
  // SSN-shaped `id` pattern.
  const PASSPORT_IN_RE = /\b[A-Z][0-9]{7}\b/g;
  // Driving licence: format varies by state, but the common representation
  // is 2-letter state code + 13 digits (RTO code + issue year + serial),
  // e.g. MH0220200012345 - structurally identical to plenty of ordinary
  // product/serial codes (verified: "AB1234567890123" as a fictional product
  // code collides), unlike PAN/IFSC/Aadhaar which have a real checksum or a
  // genuinely distinctive shape. Keyword-anchored instead of standalone.
  const DL_KEYWORDS = "driving licen[cs]e|dl (?:no\\.?|number)";
  const DRIVING_LICENCE_RE = new RegExp(`\\b(?:${DL_KEYWORDS})\\b[^0-9]{0,20}\\b[A-Z]{2}[ -]?\\d{13}\\b`, "gi");
  // Indian mobile: 10 digits starting 6-9. Real numbers are commonly written
  // 5-5-grouped ("98765 43210"), but that grouping is ONLY allowed here when
  // a +91/0 prefix is also present - a bare, unprefixed 5-5 split is
  // structurally identical to two unrelated adjacent 5-digit codes (e.g. zip
  // codes), so a bare number must be a single contiguous 10-digit block,
  // same as PHONE_RE already requires (verified against "90210 90211 90212"
  // false-positiving before this constraint was added).
  const MOBILE_IN_RE = /(?<!\d)(?:\+91[ -]?[6-9]\d{4}[ ]?\d{5}|0[6-9]\d{4}[ ]?\d{5}|[6-9]\d{9})(?!\d)/g;
  // UPI ID: looks like an email (user@handle) but the handle is a known PSP
  // suffix with no dot/TLD - EMAIL_RE already can't match these (it requires
  // a dotted domain), so there's no collision between the two patterns.
  const UPI_HANDLES = "ybl|okhdfcbank|okicici|oksbi|okaxis|paytm|apl|ibl|axl|axisbank|jio|freecharge|rbl|hdfcbank|icici|sbi|kotak|idfcbank|upi|yesbank|federal";
  // Negative lookahead blocks a false match on a real email whose domain
  // happens to start with a UPI handle name followed by a real TLD, e.g.
  // "x@ybl.com" is an email (ybl.com is a real domain), not a bare UPI
  // handle like "x@ybl" - the dot afterward is what tells them apart.
  const UPI_RE = new RegExp(`\\b[\\w.-]{2,256}@(?:${UPI_HANDLES})(?!\\.[a-zA-Z0-9])\\b`, "gi");
  // JWT-shaped token: three base64url segments, header segment always starts
  // "eyJ" (base64 for '{"'). Distinctive shape, low false-positive risk.
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

  // --- Phase 2: keyword-anchored patterns ---
  // These values (a bare 4-6 digit OTP, a bare 3-4 digit CVV, a bare 9-18
  // digit account number) are all far too generic to ever match standalone -
  // that IS the "don't run one huge regex over the page" problem this whole
  // phase exists to avoid. Each one only fires when an explicit keyword sits
  // right next to it; the value's own shape is never enough on its own.

  const OTP_KEYWORDS = "otp|one[- ]?time[- ]?password|one[- ]?time[- ]?pin|verification code";
  const OTP_RE = new RegExp(
    `\\b(?:${OTP_KEYWORDS})\\b[^0-9]{0,15}\\b\\d{4,6}\\b|\\b\\d{4,6}\\b[^0-9]{0,15}\\b(?:${OTP_KEYWORDS})\\b`,
    "gi"
  );

  // Free-text CVV mention (e.g. pasted into a chat/note) - the structural
  // cc-csc autocomplete check already covers an actual CVV *form field*
  // regardless of keywords, so this is purely the incidental-text case.
  const CVV_KEYWORDS = "cvv|cvc|security code|card verification (?:value|code)";
  const CVV_TEXT_RE = new RegExp(
    `\\b(?:${CVV_KEYWORDS})\\b[^0-9]{0,15}\\b\\d{3,4}\\b|\\b\\d{3,4}\\b[^0-9]{0,15}\\b(?:${CVV_KEYWORDS})\\b`,
    "gi"
  );

  // Free-text password mention (e.g. "password: hunter2" pasted into a note
  // or chat) - deliberately anchored on an explicit separator (: - =) rather
  // than also matching prose like "my password is great" with no separator,
  // trading some recall for not flagging ordinary sentences about passwords.
  const PASSWORD_KEYWORDS = "password|passwd|pwd|passcode|pass|pin code|passphrase";
  const PASSWORD_TEXT_RE = new RegExp(`\\b(?:${PASSWORD_KEYWORDS})\\b\\s*[:\\-=]\\s*\\S+`, "gi");

  // Bank account number: 9-18 digits has no checksum and collides with all
  // sorts of other numeric IDs (invoices, tracking numbers, order numbers) -
  // safe to flag only when a bank/account keyword immediately precedes it.
  const BANK_ACCOUNT_KEYWORDS = "account (?:number|no\\.?)|a\\/c (?:number|no\\.?)|bank account(?: number)?";
  const BANK_ACCOUNT_RE = new RegExp(`\\b(?:${BANK_ACCOUNT_KEYWORDS})\\b[^0-9]{0,15}\\b\\d{9,18}\\b`, "gi");

  // API keys / secrets: known real-provider prefixes are distinctive enough
  // to match standalone, no keyword needed - unlike a generic long random
  // string, which would be far too imprecise to flag on shape alone.
  const API_KEY_RE = /\b(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})\b/g;

  // Private address: loose by nature (no fixed format), so anchored on an
  // address-context keyword AND a 6-digit Indian PIN code both present
  // nearby - the loosest/highest-risk pattern in this phase, flagged as such.
  const ADDRESS_KEYWORDS = "address|street|road|colony|sector|nagar|apartment|flat no\\.?|house no\\.?";
  const ADDRESS_PINCODE_RE = new RegExp(`\\b(?:${ADDRESS_KEYWORDS})\\b[^\\n]{0,60}\\b\\d{6}\\b`, "gi");

  function luhnCheck(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return digits.length > 0 && sum % 10 === 0;
  }

  function maskCardNumbers(text) {
    let count = 0;
    const masked = text.replace(CARD_CANDIDATE_RE, (match) => {
      const digits = match.replace(/[ -]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
        count++;
        return "[CARD]";
      }
      return match;
    });
    return { text: masked, count };
  }

  // Verhoeff checksum tables (the real algorithm UIDAI uses for Aadhaar's
  // 12th check digit) - a bare 12-digit regex without this would flag huge
  // numbers of ordinary digit runs (order IDs, phone-like numbers, etc.).
  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];

  function verhoeffValid(numStr) {
    const digits = numStr.split("").reverse().map(Number);
    let c = 0;
    for (let i = 0; i < digits.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
    }
    return c === 0;
  }

  function maskAadhaar(text) {
    let count = 0;
    const masked = text.replace(AADHAAR_CANDIDATE_RE, (match) => {
      const digits = match.replace(/[ -]/g, "");
      if (digits.length === 12 && verhoeffValid(digits)) {
        count++;
        return "[AADHAAR]";
      }
      return match;
    });
    return { text: masked, count };
  }

  function maskPattern(text, re, tag) {
    let count = 0;
    const masked = text.replace(re, () => {
      count++;
      return tag;
    });
    return { text: masked, count };
  }

  /** Redacts emails, phone numbers, SSN-like IDs, Luhn-valid card numbers,
   * and (phase 1) Indian PII: Aadhaar, PAN, IFSC, Voter ID, passport, UPI
   * IDs, JWT-shaped tokens, and Indian mobile numbers, from free text. */
  function redactText(text) {
    if (!text) return { text: text || "", redactions: [] };
    const redactions = [];

    // UPI first: structurally distinct from EMAIL_RE (no dotted domain), but
    // checked first anyway so a UPI ID is always reported as "upi", never
    // absorbed into a generic "email" count.
    let step = maskPattern(text, UPI_RE, "[UPI]");
    if (step.count) redactions.push({ type: "upi", count: step.count });

    step = maskPattern(step.text, EMAIL_RE, "[EMAIL]");
    if (step.count) redactions.push({ type: "email", count: step.count });

    step = maskPattern(step.text, JWT_RE, "[TOKEN]");
    if (step.count) redactions.push({ type: "token", count: step.count });

    step = maskPattern(step.text, API_KEY_RE, "[API_KEY]");
    if (step.count) redactions.push({ type: "api-key", count: step.count });

    // Keyword-anchored (phase 2) checks run before the generic digit-shaped
    // patterns below, so an explicitly-labeled value (e.g. "account number:
    // 234123412346") gets its more specific, context-given category rather
    // than being silently absorbed into a coincidentally-matching generic
    // pattern (e.g. that same 12-digit string also happening to pass the
    // Aadhaar checksum).
    step = maskPattern(step.text, PASSWORD_TEXT_RE, "[PASSWORD]");
    if (step.count) redactions.push({ type: "password", count: step.count });

    step = maskPattern(step.text, OTP_RE, "[OTP]");
    if (step.count) redactions.push({ type: "otp", count: step.count });

    step = maskPattern(step.text, CVV_TEXT_RE, "[CVV]");
    if (step.count) redactions.push({ type: "cvv", count: step.count });

    step = maskPattern(step.text, BANK_ACCOUNT_RE, "[BANK_ACCOUNT]");
    if (step.count) redactions.push({ type: "bank-account", count: step.count });

    step = maskPattern(step.text, ADDRESS_PINCODE_RE, "[ADDRESS]");
    if (step.count) redactions.push({ type: "address", count: step.count });

    step = maskPattern(step.text, SSN_RE, "[ID]");
    if (step.count) redactions.push({ type: "id", count: step.count });

    step = maskAadhaar(step.text);
    if (step.count) redactions.push({ type: "aadhaar", count: step.count });

    step = maskPattern(step.text, PAN_RE, "[PAN]");
    if (step.count) redactions.push({ type: "pan", count: step.count });

    step = maskPattern(step.text, IFSC_RE, "[IFSC]");
    if (step.count) redactions.push({ type: "ifsc", count: step.count });

    step = maskPattern(step.text, VOTER_ID_RE, "[VOTER_ID]");
    if (step.count) redactions.push({ type: "voter-id", count: step.count });

    step = maskPattern(step.text, PASSPORT_IN_RE, "[PASSPORT]");
    if (step.count) redactions.push({ type: "passport", count: step.count });

    step = maskPattern(step.text, DRIVING_LICENCE_RE, "[DRIVING_LICENCE]");
    if (step.count) redactions.push({ type: "driving-licence", count: step.count });

    step = maskCardNumbers(step.text);
    if (step.count) redactions.push({ type: "card", count: step.count });

    step = maskPattern(step.text, PHONE_RE, "[PHONE]");
    let phoneCount = step.count;

    step = maskPattern(step.text, MOBILE_IN_RE, "[PHONE]");
    phoneCount += step.count;
    if (phoneCount) redactions.push({ type: "phone", count: phoneCount });

    return { text: step.text, redactions };
  }

  /**
   * Classifies whether a form element must never have its value read or
   * filled by the agent. Returns null (not sensitive) or a reason string.
   */
  function classifyElementSensitivity(attrs) {
    const type = (attrs.type || "").toLowerCase();
    const autocomplete = (attrs.autocomplete || "").toLowerCase();

    if (type === "password") return "password";
    if (/cc-number|cc-csc|cc-exp/.test(autocomplete)) return "card";
    if (type === "tel") return "phone";
    if (type === "email") {
      if (attrs.readOnly) return "email"; // an account's own address, on display
      // Structural signal, not wording: an editable email field sharing a
      // form with a password field is almost certainly your own login/signup
      // identifier - the same thing you'd tell the agent directly in a task
      // anyway, so it's safe to show. Anything else is presumptively about
      // some OTHER person (a message recipient, a contact, a share target),
      // regardless of what the page happens to label it - default to hiding
      // it rather than relying on the field saying "To" or "Recipients".
      return attrs.looksLikeLoginField ? null : "recipient";
    }
    if (attrs.name === "ssn" || /\bssn\b|government id/i.test(attrs.label || "")) return "id";
    // Phase 1 Indian-PII structural rules: a field explicitly typed for one
    // of these via the standard HTML autocomplete tokens is marked sensitive
    // by field-type alone, the same way a password field is - regardless of
    // whether it currently has a value the free-text scan would also catch.
    if (autocomplete === "bday") return "dob";
    if (/^(street-address|address-line1|address-line2|postal-code)$/.test(autocomplete)) return "address";
    if (autocomplete === "name") return "full-name";
    // "one-time-code" is the real HTML5-standard autocomplete token browsers
    // use for OTP autofill - far more reliable than any free-text keyword
    // match, so this is phase 2's one structural (not keyword-anchored) win.
    if (autocomplete === "one-time-code") return "otp";
    if (/\bdate of birth\b|\bdob\b/i.test(attrs.label || "") || attrs.name === "dob") return "dob";
    if (/\baddress\b/i.test(attrs.label || "")) return "address";
    return null;
  }

  // Sensitive categories the agent is still allowed to *type into* (never
  // read back) because a legitimate value can come from the task text
  // itself rather than from guessing - e.g. a recipient address the user
  // named in their instruction. Every other sensitive category can only
  // ever be filled by the human, because the agent has no legitimate way to
  // know a password or card number.
  const TYPABLE_SENSITIVE = new Set(["recipient"]);

  return {
    EMAIL_RE,
    PHONE_RE,
    SSN_RE,
    AADHAAR_CANDIDATE_RE,
    PAN_RE,
    IFSC_RE,
    VOTER_ID_RE,
    PASSPORT_IN_RE,
    DRIVING_LICENCE_RE,
    MOBILE_IN_RE,
    UPI_RE,
    JWT_RE,
    OTP_RE,
    CVV_TEXT_RE,
    PASSWORD_TEXT_RE,
    BANK_ACCOUNT_RE,
    API_KEY_RE,
    ADDRESS_PINCODE_RE,
    luhnCheck,
    verhoeffValid,
    maskCardNumbers,
    maskAadhaar,
    redactText,
    classifyElementSensitivity,
    TYPABLE_SENSITIVE,
  };
});
