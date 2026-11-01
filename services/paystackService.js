import https from "https";

// Thin wrapper around the Paystack REST API using only Node's built-in
// `https` module — no SDK dependency needed for two endpoints.
// All amounts are in kobo (NGN × 100).

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

const paystackRequest = (method, path, body) =>
  new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.paystack.co",
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid Paystack response"));
        }
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

// Initialize a transaction. Returns { authorization_url, reference }.
export const initializeTransaction = async ({ email, amountKobo, reference, metadata, callbackUrl }) => {
  if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET_KEY not configured.");
  const body = {
    email,
    amount: amountKobo,
    reference,
    currency: "NGN",
    metadata: metadata || {},
  };
  if (callbackUrl) body.callback_url = callbackUrl;
  const res = await paystackRequest("POST", "/transaction/initialize", body);
  if (!res.status) throw new Error(res.message || "Paystack initialization failed.");
  return res.data; // { authorization_url, access_code, reference }
};

// Verify a transaction by reference. Returns Paystack's data object.
export const verifyTransaction = async (reference) => {
  if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET_KEY not configured.");
  const res = await paystackRequest("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
  if (!res.status) throw new Error(res.message || "Paystack verification failed.");
  return res.data; // { status, amount, reference, customer, ... }
};

// ── Transfers (payouts) ─────────────────────────────────────────────────────

// Create a transfer recipient from a NUBAN account. Returns
// { recipient_code, details: { account_name, bank_name, ... } }.
// The full account number is only ever sent to Paystack — we store the
// returned recipient_code and the last 4 digits, nothing else.
export const createTransferRecipient = async ({ name, accountNumber, bankCode }) => {
  if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET_KEY not configured.");
  const res = await paystackRequest("POST", "/transferrecipient", {
    type: "nuban",
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: "NGN",
  });
  if (!res.status) throw new Error(res.message || "Could not verify bank account.");
  return res.data;
};

// Start a transfer from the Paystack balance. `reference` must be 16-50
// chars of lowercase letters, digits, "-" or "_". Returns
// { transfer_code, status, reference } — status may be "pending", "otp",
// "success" or "failed".
export const initiateTransfer = async ({ amountKobo, recipientCode, reference, reason }) => {
  if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET_KEY not configured.");
  const res = await paystackRequest("POST", "/transfer", {
    source: "balance",
    amount: amountKobo,
    recipient: recipientCode,
    reference,
    reason,
    currency: "NGN",
  });
  if (!res.status) throw new Error(res.message || "Paystack transfer failed.");
  return res.data;
};

// Look a transfer up by our reference. Returns Paystack's transfer object
// ({ status: "success" | "failed" | "reversed" | "pending" | "otp", ... }).
export const verifyTransfer = async (reference) => {
  if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET_KEY not configured.");
  const res = await paystackRequest("GET", `/transfer/verify/${encodeURIComponent(reference)}`);
  if (!res.status) throw new Error(res.message || "Paystack transfer lookup failed.");
  return res.data;
};
