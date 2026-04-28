import { ElectrumClient } from "@vgrunner/electrum-cash";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname } from "path";

// ============================================================================
// ELECTRUM SERVERS
// ============================================================================

const SERVERS = [
  { host: "electrum.nexa.org", port: 20004, protocol: "wss" },
  { host: "rostrum.otoplo.com", port: 443, protocol: "wss" },
  { host: "onekey-electrum.bitcoinunlimited.info", port: 20004, protocol: "wss" },
  { host: "rostrum.nexa.ink", port: 20004, protocol: "wss" },
  { host: "electrum.nexa.org", port: 20003, protocol: "ws" },
];

let idx = 0;
let client = makeClient(idx);
let connected = false;
let connecting = false;

function makeClient(i) {
  const s = SERVERS[i];
  return new ElectrumClient("Rostrum", "1.4.3", s.host, s.port, s.protocol);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function ensureConnected() {
  if (connected) return;
  if (connecting) {
    while (connecting) await sleep(100);
    return;
  }
  connecting = true;

  const start = idx;
  do {
    try {
      await client.connect();
      connected = true;
      console.log(`Connected → ${SERVERS[idx].host}:${SERVERS[idx].port}`);
      break;
    } catch {
      console.error(`Failed → ${SERVERS[idx].host}`);
      connected = false;
      idx = (idx + 1) % SERVERS.length;
      client = makeClient(idx);
    }
  } while (idx !== start);

  connecting = false;
  if (!connected) throw new Error("All servers unreachable");
}

// ============================================================================
// CACHE + DEDUPE
// ============================================================================

const cache = new Map();
const pending = new Map();

const TTL = {
  balance: 10000,
  tokenBalance: 10000,
  transaction: Infinity,
  genesis: Infinity,
  headers: 30000,
  headerVerbose: 30000,
  utxos: 10000,
  nftList: 60000,
  block: Infinity,
  mempool: 10000,
  history: 10000,
};

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expires < now) cache.delete(k);
  }
}, 60000);

function key(...args) {
  return JSON.stringify(args);
}

async function request(method, params) {
  for (let attempt = 0; attempt < SERVERS.length; attempt++) {
    try {
      await ensureConnected();
      return await client.request(method, ...params);
    } catch {
      connected = false;
      idx = (idx + 1) % SERVERS.length;
      client = makeClient(idx);
    }
  }
  throw new Error(`All servers failed: ${method}`);
}

async function timed(method, params) {
  const t0 = Date.now();
  let ok = false;

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 30000)
    );

    const result = await Promise.race([request(method, params), timeout]);
    ok = true;
    return result;
  } finally {
    const ms = Date.now() - t0;
    metrics.push({ method, duration: ms, success: ok, timestamp: t0 });
    if (metrics.length > 1000) metrics.shift();
    if (ms > 5000) console.warn(`Slow request: ${method} ${ms}ms`);
  }
}

async function deduped(method, params) {
  const k = key(method, ...params);
  if (pending.has(k)) return pending.get(k);

  const p = timed(method, params).finally(() => pending.delete(k));
  pending.set(k, p);
  return p;
}

async function cached(ttl, method, params) {
  const k = key(method, ...params);
  const hit = cache.get(k);

  if (hit && hit.expires > Date.now()) return hit.data;

  const data = await deduped(method, params);
  if (cache.size < 10000)
    cache.set(k, { data, expires: Date.now() + ttl });

  return data;
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

const isAddr = v => typeof v === "string" && v.length > 0 && v.length < 200;
const isTxHash = v => /^[a-fA-F0-9]{64}$/.test(v);
const isHeight = v => {
  const n = parseInt(v);
  return !isNaN(n) && n >= 0 && n < 1e8;
};
const isGroup = v => typeof v === "string" && v.length > 0 && v.length < 200;

const lim = v => Math.min(Math.max(parseInt(v) || 0, 0), 1000);
const off = v => Math.max(parseInt(v) || 0, 0);

// ============================================================================
// METRICS
// ============================================================================

const metrics = [];
const START = Date.now();

// ============================================================================
// SIMPLE ROUTER
// ============================================================================

async function parseBody(req) {
  return new Promise(resolve => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");

  // ------------------------------
  // STATIC FILES (public/)
  // ------------------------------
  if (req.method === "GET" && url.pathname.startsWith("/")) {
    const filePath = "public" + (url.pathname === "/" ? "/index.html" : url.pathname);
    try {
      const data = await readFile(filePath);
      const type = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
      }[extname(filePath)] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": type });
      return res.end(data);
    } catch {}
  }

  // ------------------------------
  // API ROUTES
  // ------------------------------

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, { status: "ok" });
  }

  // BALANCE
  if (url.pathname.startsWith("/balance/")) {
    const address = url.pathname.split("/")[2];
    if (!isAddr(address)) return send(res, 400, { error: "Invalid address" });

    try {
      const balance = await cached(TTL.balance, "blockchain.address.get_balance", [address]);
      return send(res, 200, { balance });
    } catch {
      return send(res, 500, { error: "Failed to get balance" });
    }
  }

  // RAW TX
  if (url.pathname.startsWith("/rawtx/")) {
    const tx = url.pathname.split("/")[2];
    if (!isTxHash(tx)) return send(res, 400, { error: "Invalid tx hash" });

    try {
      const transaction = await cached(TTL.transaction, "blockchain.transaction.get", [tx, false]);
      return send(res, 200, { transaction });
    } catch {
      return send(res, 500, { error: "Failed to get raw tx" });
    }
  }

  // FULL TX
  if (url.pathname.startsWith("/tx/")) {
    const tx = url.pathname.split("/")[2];
    if (!isTxHash(tx)) return send(res, 400, { error: "Invalid tx hash" });

    try {
      const transaction = await cached(TTL.transaction, "blockchain.transaction.get", [tx, true]);
      return send(res, 200, { transaction });
    } catch {
      return send(res, 500, { error: "Failed to get tx" });
    }
  }

  // ADDRESS HISTORY
  if (url.pathname.startsWith("/transactions/")) {
    const address = url.pathname.split("/")[2];
    if (!isAddr(address)) return send(res, 400, { error: "Invalid address" });

    try {
      const transactions = await cached(TTL.history, "blockchain.address.get_history", [
        address,
        {
          limit: lim(url.searchParams.get("limit")),
          offset: off(url.searchParams.get("offset")),
          include_tokens: true,
        },
      ]);
      return send(res, 200, { transactions });
    } catch {
      return send(res, 500, { error: "Failed to get transactions" });
    }
  }

  // TOKEN BALANCE
  if (url.pathname.startsWith("/tokenbalance/")) {
    const address = url.pathname.split("/")[2];
    if (!isAddr(address)) return send(res, 400, { error: "Invalid address" });

    try {
      const balance = await cached(TTL.tokenBalance, "token.address.get_balance", [address]);
      return send(res, 200, { balance });
    } catch {
      return send(res, 500, { error: "Failed to get token balance" });
    }
  }

  // TOKEN HISTORY
  if (url.pathname.startsWith("/tokentransactions/")) {
    const address = url.pathname.split("/")[2];
    if (!isAddr(address)) return send(res, 400, { error: "Invalid address" });

    try {
      const tokentransactions = await cached(TTL.history, "token.address.get_history", [
        address,
        {
          limit: lim(url.searchParams.get("limit")),
          offset: off(url.searchParams.get("offset")),
          include_tokens: true,
        },
      ]);
      return send(res, 200, { tokentransactions });
    } catch {
      return send(res, 500, { error: "Failed to get token transactions" });
    }
  }

  // GENESIS
  if (url.pathname.startsWith("/genesis/")) {
    const group = url.pathname.split("/")[2];
    if (!isGroup(group)) return send(res, 400, { error: "Invalid group id" });

    try {
      const genesis = await cached(TTL.genesis, "token.genesis.info", [group]);
      return send(res, 200, { genesis });
    } catch {
      return send(res, 500, { error: "Failed to get genesis" });
    }
  }

  // NFT LIST
  if (url.pathname.startsWith("/nftlist/")) {
    const group = url.pathname.split("/")[2];
    if (!isGroup(group)) return send(res, 400, { error: "Invalid group id" });

    try {
      const nftlist = await cached(TTL.nftList, "token.nft.list", [group]);
      return send(res, 200, { nftlist });
    } catch {
      return send(res, 500, { error: "Failed to get NFT list" });
    }
  }

  // UTXOS
  if (url.pathname.startsWith("/utxos/")) {
    const address = url.pathname.split("/")[2];
    if (!isAddr(address)) return send(res, 400, { error: "Invalid address" });

    try {
      const utxos = await cached(TTL.utxos, "blockchain.address.listunspent", [
        address,
        "include_tokens",
      ]);
      return send(res, 200, { utxos });
    } catch {
      return send(res, 500, { error: "Failed to get UTXOs" });
    }
  }

  // HEADERS
  if (url.pathname === "/headers") {
    try {
      const headers = await cached(TTL.headers, "blockchain.headers.tip", []);
      return send(res, 200, { headers });
    } catch {
      return send(res, 500, { error: "Failed to get headers" });
    }
  }

  // VERBOSE TIP
  if (url.pathname === "/header/verbose") {
    try {
      const tip = await cached(TTL.headerVerbose, "blockchain.headers.tip", []);
      const header = await cached(TTL.headerVerbose, "blockchain.block.header_verbose", [
        tip.height,
      ]);
      return send(res, 200, { header });
    } catch {
      return send(res, 500, { error: "Failed to get verbose header" });
    }
  }

  // VERBOSE HEADER BY HEIGHT/HASH
  if (url.pathname.startsWith("/header/verbose/")) {
    const h = url.pathname.split("/")[3];
    const param = /^\d+$/.test(h) ? parseInt(h) : h;

    if (typeof param === "number" && !isHeight(h))
      return send(res, 400, { error: "Invalid height" });

    try {
      const header = await cached(TTL.headerVerbose, "blockchain.block.header_verbose", [param]);
      return send(res, 200, { header });
    } catch {
      return send(res, 500, { error: "Failed to get verbose header" });
    }
  }

  // BLOCK
  if (url.pathname.startsWith("/block/")) {
    const height = url.pathname.split("/")[2];
    if (!isHeight(height)) return send(res, 400, { error: "Invalid height" });

    try {
      const blockdata = await cached(TTL.block, "blockchain.block.get", [parseInt(height)]);
      return send(res, 200, { blockdata });
    } catch {
      return send(res, 500, { error: "Failed to get block" });
    }
  }

  // MEMPOOL
  if (url.pathname === "/mempool") {
    try {
      const mempool = await cached(TTL.mempool, "mempool.count", []);
      return send(res, 200, { mempool });
    } catch {
      return send(res, 500, { error: "Failed to get mempool" });
    }
  }

  // BROADCAST
  if (req.method === "POST" && url.pathname === "/broadcast") {
    const body = await parseBody(req);
    const tx = body.tx;

    if (!tx || typeof tx !== "string" || tx.length > 100000)
      return send(res, 400, { error: "Invalid transaction" });

    try {
      const txId = await deduped("blockchain.transaction.broadcast", [tx]);
      return send(res, 200, { txId });
    } catch {
      return send(res, 500, { error: "Failed to broadcast" });
    }
  }

  // METRICS
  if (url.pathname === "/metrics") {
    const now = Date.now();
    const recent = metrics.filter(m => m.timestamp > now - 300000);
    const total = recent.length;
    const ok = recent.filter(m => m.success).length;

    return send(res, 200, {
      totalRequests: total,
      successRate: total ? ok / total : 0,
      averageDuration: total ? recent.reduce((s, m) => s + m.duration, 0) / total : 0,
      slowRequests: recent.filter(m => m.duration > 5000).length,
      cacheSize: cache.size,
      pendingRequests: pending.size,
      connected,
      currentServer: `${SERVERS[idx].host}:${SERVERS[idx].port}`,
      uptime: (now - START) / 1000,
    });
  }

  // FALLBACK
  send(res, 404, { error: "Not found" });
}

// ============================================================================
// START SERVER
// ============================================================================

await ensureConnected().catch(e =>
  console.error("Startup connect failed:", e.message)
);

createServer(handle).listen(8000, () =>
  console.log("Server running → http://localhost:8000")
);