const https = require("https");
const tls = require("tls");

const OWNER = "feopatito";
const REPO = "my-booking";
const FILE = "responses.json";

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

function httpsRequest(hostname, path, method, headers, body) {
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
  const TOKEN = proces…oken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!TOKEN) throw new Error("GH token not set");
  return httpsRequest("api.github.com", path, method, {
    Authorization: "token " + TOKEN,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "my-booking-netlify",
    "Content-Type": "application/json",
  }, body);
}

async function notifyFreelo(personId, choice, note) {
  const taskId = FREELO_TASKS[personId];
  if (!taskId) return { skipped: true };
  const FREELO_TOKEN = proces…OKEN || "";
  if (!FREELO_TOKEN) return { skipped: "no token" };

  const auth = Buffer.from("tomas@feopatito.cz:" + FREELO_TOKEN).toString("base64");
  const variantLabel = VARIANT_LABELS[choice] || choice;
  const personName = PERSON_NAMES[personId] || personId;
  const noteText = note ? "\nPoznámka: " + note : "";
  const content = "✅ Potvrzení dostupnosti z booking stránky\n\n" + personName + " vyplnil/a termín:\n📅 " + variantLabel + noteText;

  return httpsRequest("api.freelo.io", "/v1/task/" + taskId + "/comments", "POST", {
    Authorization: "Basic " + auth,
    "Content-Type": "application/json",
    "User-Agent": "my-booking-netlify",
  }, { content });
}

function smtpSend(subject, textBody) {
  const SMTP_PASS = process.env.SMTP_PASS || "";
  if (!SMTP_PASS) return Promise.resolve({ skipped: "no smtp pass" });

  return new Promise((resolve, reject) => {
    const host = "smtp.4every1.cz";
    const port = 465; // SMTPS (TLS od začátku)
    const user = "tomas@feopatito.cz";
    const to = "tomas@feopatito.cz";

    const b64creds = Buffer.from("\0" + user + "\0" + SMTP_PASS).toString("base64");
    const msgId = Date.now() + "@feopatito.cz";
    const date = new Date().toUTCString();

    const body = [
      "From: MY Booking <" + user + ">",
      "To: " + to,
      "Subject: " + subject,
      "Date: " + date,
      "Message-ID: <" + msgId + ">",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      textBody,
    ].join("\r\n");

    const socket = tls.connect({ host, port }, () => {
      let buf = "";
      let step = 0;

      const send = (cmd) => socket.write(cmd + "\r\n");

      socket.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\r\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const code = parseInt(line.slice(0, 3));
          if (step === 0 && code === 220) { send("EHLO netlify.com"); step = 1; }
          else if (step === 1 && code === 250) { send("AUTH PLAIN " + b64creds); step = 2; }
          else if (step === 2 && code === 235) { send("MAIL FROM:<" + user + ">"); step = 3; }
          else if (step === 3 && code === 250) { send("RCPT TO:<" + to + ">"); step = 4; }
          else if (step === 4 && code === 250) { send("DATA"); step = 5; }
          else if (step === 5 && code === 354) { send(body + "\r\n."); step = 6; }
          else if (step === 6 && code === 250) { send("QUIT"); step = 7; }
          else if (step === 7 && code === 221) { socket.end(); resolve({ ok: true }); }
          else if (code >= 400) { socket.end(); reject(new Error("SMTP error: " + line)); }
        }
      });
      socket.on("error", reject);
    });
  });
}

async function notifyEmail(personId, choice, name, note) {
  const variantLabel = VARIANT_LABELS[choice] || choice;
  const personName = PERSON_NAMES[personId] || name || personId;
  const noteText = note ? "\nPoznámka: " + note : "";
  const now = new Date().toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });

  const subject = "✅ " + personName + " vyplnil/a termín natáčení MY";
  const text = personName + " potvrdil/a dostupnost na booking stránce.\n\n📅 " + variantLabel + noteText + "\n\nČas: " + now;

  return smtpSend(subject, text);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  const path = (event.path || "").replace(/\/?\.netlify\/functions\/api/, "").replace(/^\/api/, "") || "/";

  if (event.httpMethod === "GET" && path === "/read") {
    try {
      const r = await gh("GET", "/repos/" + OWNER + "/" + REPO + "/contents/" + FILE + "?t=" + Date.now());
      if (r.status !== 200) return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: r.body.message }) };
      const data = JSON.parse(Buffer.from((r.body.content || "").replace(/\n/g, ""), "base64").toString("utf-8"));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sha: r.body.sha, data }) };
    } catch (e) { return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }; }
  }

  if (event.httpMethod === "POST" && path === "/write") {
    try {
      const { sha, data, message, personId, choice, name, note } = JSON.parse(event.body);
      const content = Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64");
      const r = await gh("PUT", "/repos/" + OWNER + "/" + REPO + "/contents/" + FILE, { message: message || "odpoved", content, sha });
      if (r.status !== 200 && r.status !== 201) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: r.body.message }) };

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
          email: emailResult.status + (emailResult.reason ? ": " + emailResult.reason.message : ""),
        }),
      };
    } catch (e) { return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }; }
  }

  return { statusCode: 404, headers: CORS, body: "not found" };
};
