import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const NAVER_INDEX_BASE = "https://m.stock.naver.com/api/index";
const DAUM_QUOTE_BASE = "https://finance.daum.net/api/quotes";
const CONFIGS = [
  { id: "kospi", naverCode: "KOSPI", daumCode: "KOSPI" },
  { id: "kosdaq", naverCode: "KOSDAQ", daumCode: "KOSDAQ" },
];

async function main() {
  const output = {
    updatedAt: Date.now(),
    indices: {},
    errors: {},
  };

  await Promise.all(CONFIGS.map(async (config) => {
    try {
      output.indices[config.id] = await fetchKoreanIndex(config);
    } catch (error) {
      output.errors[config.id] = shortError(error);
    }
  }));

  await mkdir("data", { recursive: true });
  await writeFile(
    path.join("data", "korean-index.json"),
    JSON.stringify(output, null, 2) + "\n",
    "utf8",
  );

  const okCount = Object.keys(output.indices).length;
  console.log(`Korean index cache updated: ${okCount}/${CONFIGS.length}`);
  if (!okCount) process.exitCode = 1;
}

async function fetchKoreanIndex(config) {
  const errors = [];
  for (const task of [
    () => fetchNaverIndex(config.naverCode),
    () => fetchDaumIndex(config.daumCode),
  ]) {
    try {
      const payload = await task();
      if (validatePayload(payload)) return payload;
    } catch (error) {
      errors.push(error);
    }
  }
  throw errors[0] || new Error("Naver/Daum index fetch failed");
}

async function fetchNaverIndex(code) {
  const basicUrl = `${NAVER_INDEX_BASE}/${encodeURIComponent(code)}/basic`;
  const payload = unwrapFirstPayload(await fetchJson(basicUrl));
  const price = pickNumberDeep(payload, ["closePrice", "nowVal", "currentPrice", "tradePrice", "price"]);
  if (!Number.isFinite(price)) throw new Error(`${code} Naver price missing`);

  const changePoint = pickNumberDeep(payload, ["compareToPreviousClosePrice", "changePrice", "diffPrice", "changeVal", "change"]);
  let changePct = pickNumberDeep(payload, ["fluctuationsRatio", "fluctuationRate", "compareToPreviousClosePriceRatio", "changeRate", "signedChangeRate"]);
  if (Number.isFinite(changePct) && Math.abs(changePct) <= 1 && /rate/i.test(String(findKeyDeep(payload, ["changeRate", "signedChangeRate"]) || ""))) {
    changePct *= 100;
  }

  const previous = pickNumberDeep(payload, ["previousClosePrice", "basePrice", "prevClosePrice"]) ||
    (Number.isFinite(changePoint) ? price - changePoint : null);
  if (!Number.isFinite(changePct) && Number.isFinite(previous) && previous) {
    changePct = ((price - previous) / previous) * 100;
  }

  const timeText = pickStringDeep(payload, ["localTradedAt", "tradeDateTime", "tradedAt", "asOfDateTime", "dateTime", "date"]);
  const updatedAt = parseKoreanIndexTime(timeText) || Date.now();
  const marketState = pickStringDeep(payload, ["marketStatus", "marketState", "tradeStatus", "status"]);
  const history = await fetchNaverIndexHistory(code).catch(() => []);

  return {
    price,
    previous,
    changePct,
    updatedAt,
    points: history.length ? history : buildTwoPointHistory(previous, price, updatedAt),
    mode: "naver",
    isLive: isIndexLiveFromPayload(updatedAt, marketState),
    source: "Naver Finance",
    official: true,
  };
}

async function fetchNaverIndexHistory(code) {
  const url = `${NAVER_INDEX_BASE}/${encodeURIComponent(code)}/price?pageSize=80&page=1`;
  const rows = unwrapRows(await fetchJson(url));
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const value = pickNumberDeep(row, ["closePrice", "nowVal", "currentPrice", "price"]);
      const time = parseKoreanIndexTime(pickStringDeep(row, ["localTradedAt", "date", "tradeDate", "tradedAt"]));
      return Number.isFinite(value) ? { time: time || Date.now(), value } : null;
    })
    .filter(Boolean)
    .reverse();
}

async function fetchDaumIndex(code) {
  const urls = [
    `${DAUM_QUOTE_BASE}/${encodeURIComponent(code)}?summary=false`,
    `${DAUM_QUOTE_BASE}/${encodeURIComponent(code)}`,
  ];
  let lastError;
  for (const url of urls) {
    try {
      const payload = unwrapFirstPayload(await fetchJson(url, {
        headers: {
          Referer: "https://finance.daum.net/",
          Origin: "https://finance.daum.net",
        },
      }));
      const price = pickNumberDeep(payload, ["tradePrice", "currentPrice", "price", "closePrice"]);
      if (!Number.isFinite(price)) throw new Error(`${code} Daum price missing`);
      let changePct = pickNumberDeep(payload, ["changeRate", "signedChangeRate", "changeRateValue", "fluctuationRate"]);
      if (Number.isFinite(changePct) && Math.abs(changePct) <= 1) changePct *= 100;
      const changePoint = pickNumberDeep(payload, ["changePrice", "signedChangePrice", "change", "compareToPreviousClosePrice"]);
      const previous = pickNumberDeep(payload, ["prevClosingPrice", "previousClosePrice", "basePrice"]) ||
        (Number.isFinite(changePoint) ? price - changePoint : null);
      if (!Number.isFinite(changePct) && Number.isFinite(previous) && previous) {
        changePct = ((price - previous) / previous) * 100;
      }
      const updatedAt = parseKoreanIndexTime(pickStringDeep(payload, ["date", "tradeDate", "tradeDateTime", "localTradedAt", "timestamp"])) || Date.now();
      return {
        price,
        previous,
        changePct,
        updatedAt,
        points: buildTwoPointHistory(previous, price, updatedAt),
        mode: "daum",
        isLive: isIndexLiveFromPayload(updatedAt),
        source: "Daum Finance",
        official: true,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`${code} Daum fetch failed`);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 MarketPulseKR GitHubAction",
        Accept: "application/json,text/plain,*/*",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function validatePayload(payload) {
  return Number.isFinite(payload?.price) && Number.isFinite(payload?.updatedAt);
}

function unwrapFirstPayload(data) {
  if (Array.isArray(data)) return data[0] || {};
  if (Array.isArray(data?.result)) return data.result[0] || {};
  if (Array.isArray(data?.data)) return data.data[0] || {};
  if (Array.isArray(data?.list)) return data.list[0] || {};
  return data?.result || data?.data || data || {};
}

function unwrapRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.prices)) return data.prices;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.result?.list)) return data.result.list;
  if (Array.isArray(data?.result?.prices)) return data.result.prices;
  return [];
}

function pickNumberDeep(object, keys) {
  if (!object || typeof object !== "object") return null;
  const stack = [object];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of keys) {
      const value = toNumber(current[key]);
      if (Number.isFinite(value)) return value;
    }
    Object.values(current).forEach((value) => {
      if (value && typeof value === "object") stack.push(value);
    });
  }
  return null;
}

function pickStringDeep(object, keys) {
  if (!object || typeof object !== "object") return null;
  const stack = [object];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of keys) {
      const value = current[key];
      if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
    }
    Object.values(current).forEach((value) => {
      if (value && typeof value === "object") stack.push(value);
    });
  }
  return null;
}

function findKeyDeep(object, keys) {
  if (!object || typeof object !== "object") return null;
  const stack = [object];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(current, key)) return key;
    }
    Object.values(current).forEach((value) => {
      if (value && typeof value === "object") stack.push(value);
    });
  }
  return null;
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "--") return null;
    const normalized = text.replace(/,/g, "").replace(/%/g, "").replace(/[^0-9+\-.]/g, "");
    if (!normalized || normalized === "+" || normalized === "-" || normalized === ".") return null;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseKoreanIndexTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{8}$/.test(raw)) {
    return parseTime(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T15:30:00+09:00`);
  }
  if (/^\d{14}$/.test(raw)) {
    return parseTime(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+09:00`);
  }
  let normalized = raw.replace(/\./g, "-").replace(/\s+/, "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += "T15:30:00+09:00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(normalized)) normalized += "+09:00";
  return parseTime(normalized);
}

function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isIndexLiveFromPayload(updatedAt, marketState = "") {
  const stateText = String(marketState || "").toUpperCase();
  if (/(CLOSE|CLOSED|장마감|AFTER)/.test(stateText)) return false;
  if (/(OPEN|REGULAR|TRADE|장중)/.test(stateText)) return true;
  return isKoreanMarketOpenNow() && Number.isFinite(updatedAt) && Date.now() - updatedAt < 10 * 60000;
}

function isKoreanMarketOpenNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (values.weekday === "Sat" || values.weekday === "Sun") return false;
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

function buildTwoPointHistory(previous, price, updatedAt) {
  if (Number.isFinite(previous) && Number.isFinite(price)) {
    return [
      { time: updatedAt - 24 * 60 * 60000, value: previous },
      { time: updatedAt, value: price },
    ];
  }
  return Number.isFinite(price) ? [{ time: updatedAt, value: price }] : [];
}

function shortError(error) {
  if (error?.name === "AbortError") return "시간 초과";
  return String(error?.message || error || "오류").slice(0, 120);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
