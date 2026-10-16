'use strict';
const { config } = require('./config');
const { fetchJson, parseField } = require('./util');

const SPORTS = new Set(['sports', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'epl', 'ufc', 'mma', 'tennis', 'golf', 'f1', 'formula-1', 'cricket', 'esports', 'games', 'olympics', 'football', 'basketball', 'baseball', 'hockey', 'boxing', 'wnba', 'ncaa', 'college-football', 'college-basketball', 'la-liga', 'champions-league', 'world-cup', 'fifa', 'nascar', 'rugby']);
const CRYPTO = new Set(['crypto', 'bitcoin', 'ethereum', 'solana', 'xrp', 'crypto-prices', 'dogecoin', 'memecoins', 'defi', 'nft']);
const CATS = {
  politica: ['politics', 'elections', 'election', 'us-politics', 'trump', 'congress', 'global-elections', 'primaries', 'us-election', 'senate', 'house'],
  economia: ['economy', 'economic-policy', 'fed', 'fed-rates', 'inflation', 'finance', 'business', 'stocks', 'earnings', 'recession', 'tariffs', 'trade-war', 'commodities', 'economics', 'jobs-report', 'gdp'],
  tecnologia: ['tech', 'technology', 'ai', 'science', 'openai', 'big-tech', 'space', 'spacex', 'apple', 'google', 'tesla'],
  mundo: ['world', 'geopolitics', 'middle-east', 'ukraine', 'russia', 'china', 'israel', 'iran', 'world-affairs', 'global', 'europe', 'war'],
};
const CRYPTO_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|dogecoin|doge|crypto)\b|up or down|updown/i;
const CATEGORIES = Object.keys(CATS);

function classify(tags) {
  const slugs = (tags || []).map((t) => String(t.slug || t.label || t).toLowerCase());
  if (slugs.some((s) => SPORTS.has(s))) return { excluded: 'deporte' };
  if (slugs.some((s) => CRYPTO.has(s))) return { excluded: 'cripto' };
  for (const cat of CATEGORIES) if (slugs.some((s) => CATS[cat].includes(s))) return { category: cat };
  return { excluded: 'sin_categoria' };
}

function normalizeMarket(m, ev) {
  const outcomes = parseField(m.outcomes);
  const prices = parseField(m.outcomePrices);
  const tokens = parseField(m.clobTokenIds);
  if (!outcomes || outcomes.length !== 2 || !prices || prices.length !== 2 || !tokens || tokens.length !== 2) return null;
  const iy = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
  const inn = outcomes.findIndex((o) => String(o).toLowerCase() === 'no');
  if (iy < 0 || inn < 0) return null; // solo binarios Si/No
  const liq = Number(m.liquidityNum ?? m.liquidity ?? 0);
  return {
    market_id: String(m.id),
    condition_id: m.conditionId,
    question: m.question,
    description: m.description || '',
    resolution_source: m.resolutionSource || ev.resolutionSource || '',
    end_date: m.endDate || ev.endDate,
    event_id: String(ev.id),
    event_title: ev.title,
    token_yes: String(tokens[iy]),
    token_no: String(tokens[inn]),
    price_yes: Number(prices[iy]),
    liquidity: liq,
    fees_enabled: m.feesEnabled !== false && (m.feesEnabled === true || !!m.feeSchedule),
    fee_schedule: m.feeSchedule || null,
    active: m.active !== false,
    closed: !!m.closed,
    accepting: m.acceptingOrders !== false,
  };
}

async function fetchEvents() {
  const c = config();
  const now = Date.now();
  const lo = new Date(now + c.MIN_DAYS * 864e5).toISOString();
  const hi = new Date(now + c.MAX_DAYS * 864e5).toISOString();
  const out = [];
  for (let off = 0; off < 2000; off += 100) {
    const q = `active=true&closed=false&limit=100&offset=${off}&order=liquidity&ascending=false&end_date_min=${encodeURIComponent(lo)}&end_date_max=${encodeURIComponent(hi)}`;
    const page = await fetchJson(`${c.GAMMA_URL}/events?${q}`);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

// events: salida de Gamma. forecasted: Map market_id -> mid al ultimo pronostico.
function selectMarkets(events, forecasted = new Map(), todayIds = new Set(), limit) {
  const c = config();
  limit = limit ?? c.MARKETS_PER_DAY;
  const now = Date.now();
  const byCat = Object.fromEntries(CATEGORIES.map((k) => [k, []]));
  for (const ev of events) {
    const cl = classify(ev.tags);
    if (cl.excluded) continue;
    for (const raw of ev.markets || []) {
      const m = normalizeMarket(raw, ev);
      if (!m || !m.active || m.closed || !m.accepting) continue;
      if (CRYPTO_RE.test(m.question || '') || /updown/i.test(raw.slug || '')) continue;
      const days = (Date.parse(m.end_date) - now) / 864e5;
      if (!(days >= c.MIN_DAYS && days <= c.MAX_DAYS)) continue;
      if (!(m.liquidity >= c.MIN_LIQUIDITY)) continue;
      if (!(m.price_yes >= c.MIN_PRICE && m.price_yes <= c.MAX_PRICE)) continue;
      if (todayIds.has(m.market_id)) continue;
      if (forecasted.has(m.market_id) && Math.abs(m.price_yes - forecasted.get(m.market_id)) < c.REFORECAST_MOVE) continue;
      byCat[cl.category].push({ ...m, category: cl.category });
    }
  }
  for (const k of CATEGORIES) byCat[k].sort((a, b) => b.liquidity - a.liquidity);
  // reparto por categoria (round-robin), max N por evento
  const picked = [];
  const perEvent = new Map();
  const idx = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  let progress = true;
  while (picked.length < limit && progress) {
    progress = false;
    for (const k of CATEGORIES) {
      if (picked.length >= limit) break;
      while (idx[k] < byCat[k].length) {
        const m = byCat[k][idx[k]++];
        if ((perEvent.get(m.event_id) || 0) >= c.MAX_PER_EVENT_SELECT) continue;
        perEvent.set(m.event_id, (perEvent.get(m.event_id) || 0) + 1);
        picked.push(m);
        progress = true;
        break;
      }
    }
  }
  return picked;
}

// Lo unico que sale hacia la investigacion: sin precios, liquidez ni libro.
function publicCandidate(m) {
  return {
    market_id: m.market_id,
    question: m.question,
    description: m.description,
    resolution_source: m.resolution_source,
    end_date: m.end_date,
    category: m.category,
    event_id: m.event_id,
    event_title: m.event_title,
  };
}

async function fetchMarket(id) {
  const c = config();
  return fetchJson(`${c.GAMMA_URL}/markets/${encodeURIComponent(id)}`);
}

module.exports = { classify, normalizeMarket, fetchEvents, selectMarkets, publicCandidate, fetchMarket, CATEGORIES };
