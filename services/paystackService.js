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
export const initializeTransaction = async ({ email, amountKobo, reference, metadata }) => {
  if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET_KEY not configured.");
  const res = await paystackRequest("POST", "/transaction/initialize", {
    email,
    amount: amountKobo,
    reference,
    currency: "NGN",
    metadata: metadata || {},
  });
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
