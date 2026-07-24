const https = require("https");

const OWNER = "feopatito";
const REPO = "my-booking";
const FILE = "responses.json";

// Mapování osoby → Freelo task ID
const FREELO_TASKS = {
  bartak:   31360825,
  kozel:    31360826,
  krcil:    31360828,
  hajek:    31360829,
  mencak:   31360830,
  fiala:    31360832,
  stransky: 31360833,
};

const PERSON_NAMES = {
  bartak:   "Mgr. Roman Barták",
  kozel:    "Mgr. Petr Kozel",
  krcil:    "Mgr. Jan Krčil",
  hajek:    "MUDr. Josef Hájek",
  mencak:   "Ing. Tomáš Mencák",
  fiala:    "Bc. Pavel Fiala",
  stransky: "Mgr. Ondřej Stránský",
};

const VARIANT_LABELS = {
  a:   "Varianta A — 6.–9. 8. 2026",
  b:   "Varianta B — 13.–16. 8. 2026",
  oba: "Obě varianty (A i B)",
  ne:  "Nemohu ani jeden termín",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function request(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function gh(method, path, body) {
  const TOKEN = process.env.GH_token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!TOKEN) throw new Error("GH token not set");
  return request("api.github.com", path, method, {
    Authorization: "token " + TOKEN,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "my-booking-netlify",
    "Content-Type": "application/json",
  }, body);
}

async function notifyFreelo(personId, choice, note) {
  const taskId = FREELO_TASKS[personId];
  if (!taskId) return;
  const FREELO_TOKEN = process.env.FREELO_TOKEN || "";
  if (!FREELO_TOKEN) return;

  const auth = Buffer.from("tomas@feopatito.cz:" + FREELO_TOKEN).toString("base64");
  const variantLabel = VARIANT_LABELS[choice] || choice;
  const personName = PERSON_NAMES[personId] || personId;
  const noteText = note ? `\nPoznámka: ${note}` : "";
  const content = `✅ Potvrzení dostupnosti z booking stránky\n\n${personName} vyplnil/a termín:\n📅 ${variantLabel}${noteText}`;

  await request("api.freelo.io", `/v1/task/${taskId}/comments`, "POST", {
    Authorization: "Basic " + auth,
    "Content-Type": "application/json",
    "User-Agent": "my-booking-netlify",
  }, { content });
}

async function notifyEmail(personId, choice, name, note) {
  const SENDGRID_KEY = process.env.SENDGRID_KEY || "";
  if (!SENDGRID_KEY) return { skipped: true };

  const variantLabel = VARIANT_LABELS[choice] || choice;
  const personName = PERSON_NAMES[personId] || name || personId;
  const noteText = note ? `<br><b>Poznámka:</b> ${note}` : "";

  const payload = {
    personalizations: [{ to: [{ email: "tomas@feopatito.cz" }] }],
    from: { email: "booking@feopatito.cz", name: "MY Booking" },
    subject: `✅ ${personName} vyplnil/a termín natáčení`,
    content: [{
      type: "text/html",
      value: `<p><b>${personName}</b> potvrdil/a dostupnost na booking stránce.</p><p>📅 <b>${variantLabel}</b>${noteText}</p><p><small>Čas: ${new Date().toLocaleString("cs-CZ", { timeZone: "Europe/Prague" })}</small></p>`,
    }],
  };

  const r = await request("api.sendgrid.com", "/v3/mail/send", "POST", {
    Authorization: "Bearer " + SENDGRID_KEY,
    "Content-Type": "application/json",
    "User-Agent": "my-booking-netlify",
  }, payload);
  return { status: r.status };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  const path = (event.path || "").replace(/\/?\.netlify\/functions\/api/, "").replace(/^\/api/, "") || "/";

  // GET /read
  if (event.httpMethod === "GET" && path === "/read") {
    try {
      const r = await gh("GET", `/repos/${OWNER}/${REPO}/contents/${FILE}?t=${Date.now()}`);
      if (r.status !== 200) return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: r.body.message }) };
      const data = JSON.parse(Buffer.from((r.body.content || "").replace(/\n/g, ""), "base64").toString("utf-8"));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sha: r.body.sha, data }) };
    } catch (e) { return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }; }
  }

  // POST /write
  if (event.httpMethod === "POST" && path === "/write") {
    try {
      const { sha, data, message, personId, choice, name, note } = JSON.parse(event.body);
      const content = Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64");
      const r = await gh("PUT", `/repos/${OWNER}/${REPO}/contents/${FILE}`, {
        message: message || "odpoved",
        content,
        sha,
      });
      if (r.status !== 200 && r.status !== 201) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: r.body.message }) };

      // Notifikace — async, neblokují odpověď
      const [freeloResult, emailResult] = await Promise.allSettled([
        notifyFreelo(personId, choice, note),
        notifyEmail(personId, choice, name, note),
      ]);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          sha: r.body.content && r.body.content.sha,
          freelo: freeloResult.status,
          email: emailResult.status,
        }),
      };
    } catch (e) { return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }; }
  }

  return { statusCode: 404, headers: CORS, body: "not found" };
};
