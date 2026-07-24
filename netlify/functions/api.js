const https = require("https");

const OWNER = "feopatito";
const REPO = "my-booking";
const FILE = "responses.json";
const TOKEN = process.env.GITHUB_TOKEN;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "my-booking-netlify",
        "Content-Type": "application/json",
      },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });
        } catch (e) {
          reject(new Error("JSON parse error: " + d.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const path = (event.path || "")
    .replace(/\/?\.netlify\/functions\/api/, "")
    .replace(/^\/api/, "") || "/";

  // GET /read
  if (event.httpMethod === "GET" && path === "/read") {
    try {
      const r = await gh("GET", `/repos/${OWNER}/${REPO}/contents/${FILE}?t=${Date.now()}`);
      if (r.status !== 200) {
        return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: r.body.message }) };
      }
      const rawContent = r.body.content || "";
      const data = JSON.parse(Buffer.from(rawContent.replace(/\n/g, ""), "base64").toString("utf-8"));
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ sha: r.body.sha, data }),
      };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // POST /write
  if (event.httpMethod === "POST" && path === "/write") {
    try {
      const { sha, data, message } = JSON.parse(event.body);
      const content = Buffer.from(JSON.stringify(data, null, 2), "utf-8").toString("base64");
      const r = await gh("PUT", `/repos/${OWNER}/${REPO}/contents/${FILE}`, {
        message: message || "odpoved",
        content,
        sha,
      });
      if (r.status !== 200 && r.status !== 201) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: r.body.message }) };
      }
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, sha: r.body.content && r.body.content.sha }),
      };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 404, headers: CORS, body: "not found" };
};
