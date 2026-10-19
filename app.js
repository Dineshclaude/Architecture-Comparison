/* Matching Architecture Simulator — plain JS, no dependencies. */
'use strict';

/* ---------- Models (USD per 1M tokens, Anthropic list prices) ---------- */
const MODELS = [
  { id: 'claude-fable-5-1',  name: 'Claude Fable 5.1',  inP: 10,   outP: 50,  effort: true,  tps: 45,  ttft: 1.5 },
  { id: 'claude-opus-5-5',   name: 'Claude Opus 5.5',   inP: 4,    outP: 20,  effort: true,  tps: 55,  ttft: 1.2 },
  { id: 'claude-opus-5',     name: 'Claude Opus 5',     inP: 5,    outP: 25,  effort: true,  tps: 55,  ttft: 1.2 },
  { id: 'claude-opus-4-8',   name: 'Claude Opus 4.8',   inP: 5,    outP: 25,  effort: true,  tps: 55,  ttft: 1.2 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inP: 2,    outP: 10,  effort: true,  tps: 80,  ttft: 0.8 },
  { id: 'claude-sonnet-5',   name: 'Claude Sonnet 5',   inP: 2,    outP: 10,  effort: true,  tps: 80,  ttft: 0.8 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', inP: 3,    outP: 15,  effort: true,  tps: 70,  ttft: 0.9 },
  { id: 'claude-haiku-5-5',  name: 'Claude Haiku 5.5',  inP: 0.10, outP: 0.50, effort: true, tps: 150, ttft: 0.4 },
  { id: 'claude-haiku-4-5',  name: 'Claude Haiku 4.5',  inP: 1,    outP: 5,   effort: false, tps: 140, ttft: 0.5 },
];
// tps = output tokens/sec, ttft = time-to-first-token (s). These are rough, editable estimates, not published figures.
const PREFILL_TPS = 10000; // input tokens processed per second
const MODEL = Object.fromEntries(MODELS.map(m => [m.id, m]));
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Extra (hidden) thinking tokens billed as output, per call, by effort level.
const THINK = { low: 0, medium: 250, high: 700, xhigh: 1400, max: 2800 };
// Range multipliers: [low, est, high]
const R_IN = [0.75, 1, 1.3], R_OUT = [0.75, 1, 1.35], R_THINK = [0.5, 1, 1.6];

/* ---------- Architecture definitions ---------- */
const ceil = Math.ceil;
const A3_STAGES = [
  { id: 'jobParse', name: 'Job parsing (once per job)', unit: 'job', calls: () => 1, tok: () => [1800, 2500],
    note: 'Must-haves, preferred, skills, 10–30 evaluation questions, rules' },
  { id: 'cvFallback', name: 'CV parsing — LLM fallback only', unit: 'cv', calls: p => p.cvFallbackRate / 100, tok: () => [3000, 900],
    note: 'Only when local NLP parsing confidence is low' },
  { id: 'jev', name: 'Jev batch evaluation of stored criteria', unit: 'cv', calls: p => ceil(p.jevJobs / p.batchSize),
    tok: p => [1200 + 1000 * p.batchSize, 500 * p.batchSize], note: 'Probability + confidence per stored question, batched' },
  { id: 'explain', name: 'Explanations (templates; optional LLM)', unit: 'cv', calls: p => p.jevJobs * p.explainRate / 100,
    tok: () => [1500, 250], dModel: 'claude-haiku-5-5', dEffort: 'low', note: 'Normally $0 — templates' },
];
const A3_PARAMS = [
  { k: 'cvFallbackRate', label: 'CV LLM-fallback rate %', def: 15 },
  { k: 'jevJobs', label: 'Jobs evaluated by Jev / CV', def: 10 },
  { k: 'batchSize', label: 'Jobs per Jev batch', def: 5 },
  { k: 'explainRate', label: 'Jobs explained by LLM %', def: 0 },
];
const A3_JOB = [
  { k: 'io', t: 'Job created', s: 'Posted via the recruiter’s site / ATS' },
  { k: 'llm', stage: 'jobParse', t: 'One LLM call parses the job', s: 'Requirements, skills, questions, importance, disqualifiers' },
  { k: 'db', ms: 60, t: 'Embed locally + store', s: 'Questions stored & reused for every future CV' },
];
const A3_CV = [
  { k: 'io', t: 'CV submitted (ephemeral)', s: 'Never stored centrally' },
  { k: 'local', ms: 300, t: 'Local extraction + light NLP', s: 'Deterministic parsing first' },
  { k: 'llm', stage: 'cvFallback', t: 'LLM only if confidence low', s: 'Fallback parser' },
  { k: 'local', ms: 40, t: 'Local CV embedding', s: 'No API cost' },
  { k: 'db', ms: 40, t: 'SQL / PostGIS hard filters', s: 'Location, salary, work mode' },
  { k: 'db', ms: 80, t: 'Hybrid retrieval → ~100', s: 'Vector + lexical + skill overlap' },
  { k: 'local', ms: 40, t: 'Non-AI rerank → 20–30', s: 'Then adaptive pruning → 8–12' },
  { k: 'llm', stage: 'jev', t: 'Jev evaluates stored criteria', s: 'Batched probabilities + confidence' },
  { k: 'local', ms: 5, t: 'Deterministic ranking', s: 'Computed in code, not by an LLM' },
  { k: 'llm', stage: 'explain', t: 'Template explanations', s: 'Optional LLM for a small share' },
  { k: 'io', t: 'ATS feedback loop', s: 'Shortlist/interview/placement trains tenant ranker' },
];
const ROUTED = ['jobParse', 'cvFallback', 'jev'];
const routerNode = { k: 'router', ms: 15, t: 'Model router', s: 'Confidence · schema validity · OCR quality · complexity' };
const insertRouters = (flow) => flow.flatMap(n => (n.stage && ROUTED.includes(n.stage)) ? [routerNode, n] : [n]);

const ARCHS = {
  A1: {
    name: 'Architecture 1', title: 'Fixed-weight scoring', color: 'var(--a1)', hex: '#7c9cff',
    blurb: 'FastAPI backend with Postgres + pgvector + PostGIS. Jobs are parsed once at ingest; each CV is parsed, embedded, filtered, and the top 20 jobs are each scored individually by an LLM using client-specific weights. Results are cached.',
    params: [
      { k: 'topK', label: 'Jobs scored by LLM / CV', def: 20 },
      { k: 'fallbackRate', label: 'Fallback trigger rate %', def: 15 },
      { k: 'fallbackJobs', label: 'Fallback jobs scored', def: 5 },
    ],
    stages: [
      { id: 'jobParse', name: 'Job requirement extraction', unit: 'job', calls: () => 1, tok: () => [1500, 600] },
      { id: 'cvParse', name: 'CV → structured candidate data', unit: 'cv', cached: true, calls: () => 1, tok: () => [3000, 900] },
      { id: 'score', name: 'Per-job scoring + 2 explanations', unit: 'cv', cached: true, calls: p => p.topK, tok: () => [2200, 700],
        note: 'Weighted hard/soft skills, education, experience, certs, languages → 0–100' },
      { id: 'fallback', name: 'Fallback scoring (5 newest jobs)', unit: 'cv', cached: true, calls: p => p.fallbackRate / 100 * p.fallbackJobs, tok: () => [2200, 700] },
    ],
    jobFlow: [
      { k: 'io', t: 'Job from recruitment site', s: 'Sent to central matching API' },
      { k: 'local', ms: 30, t: 'FastAPI matching API', s: 'Validation & orchestration' },
      { k: 'llm', stage: 'jobParse', t: 'LLM extracts requirements', s: 'Hard/soft skills, education, experience, certs, languages' },
      { k: 'local', ms: 80, t: '1536-d job embedding', s: 'Vector from structured job' },
      { k: 'db', ms: 20, t: 'Postgres + pgvector + PostGIS', s: 'Salary, work mode, sector, location' },
    ],
    cvFlow: [
      { k: 'io', t: 'CV uploaded', s: 'Candidate or recruiter' },
      { k: 'local', ms: 400, t: 'Extract & clean text', s: 'PDF/DOCX → text' },
      { k: 'llm', stage: 'cvParse', t: 'LLM structures the CV', s: 'Structured candidate profile' },
      { k: 'local', ms: 200, t: 'CV embedding + geolocate', s: 'Candidate location' },
      { k: 'db', ms: 120, t: 'Filters + pgvector search', s: 'Up to 1,000 jobs for radius → PostGIS prune' },
      { k: 'llm', stage: 'score', t: 'Top 20 scored one by one', s: 'Client weightings → 0–100 + 2 explanations' },
      { k: 'llm', stage: 'fallback', t: 'Threshold + fallback', s: '5 newest jobs if nothing passes' },
      { k: 'db', ms: 15, t: 'Cache ranked results', s: 'Repeat searches skip AI' },
    ],
    items: [
      { name: 'CV text extraction / OCR', cost: 0.0008, unit: 'cv' },
      { name: 'Embeddings — CV (1536-d)', cost: 0.0001, unit: 'cv' },
      { name: 'Embeddings — job (1536-d)', cost: 0.0001, unit: 'job' },
      { name: 'Geocoding', cost: 0.0005, unit: 'cv' },
      { name: 'FastAPI compute (AWS ECS/Lambda)', cost: 0.0003, unit: 'cv' },
      { name: 'PostgreSQL + pgvector + PostGIS (RDS)', cost: 150, unit: 'month' },
    ],
  },
  A2: {
    name: 'Architecture 2', title: 'Per-job generated questions', color: 'var(--a2)', hex: '#ff9f5a',
    blurb: 'CV structured by an LLM, top 20 jobs retrieved by pgvector. For every CV–job pair an LLM generates 10–30 job-specific questions, Jev scores them, and a cheap LLM writes an explanation. Adaptive, but questions are regenerated for every comparison.',
    params: [{ k: 'topK', label: 'Jobs evaluated / CV', def: 20 }],
    stages: [
      { id: 'cvParse', name: 'CV → structured JSON', unit: 'cv', calls: () => 1, tok: () => [3000, 900] },
      { id: 'questions', name: 'Generate 10–30 questions per job', unit: 'cv', calls: p => p.topK, tok: () => [1200, 1000], note: 'Regenerated for each CV–job pair' },
      { id: 'jev', name: 'Jev scores each question', unit: 'cv', calls: p => p.topK, tok: () => [2200, 600], note: 'Score + confidence per criterion' },
      { id: 'explain', name: 'Explanation per job', unit: 'cv', calls: p => p.topK, tok: () => [1500, 250], dModel: 'claude-haiku-5-5', dEffort: 'low' },
    ],
    jobFlow: [
      { k: 'io', t: 'Job posted', s: 'From recruitment site' },
      { k: 'local', ms: 60, t: 'Embed job', s: 'No LLM at ingest' },
      { k: 'db', ms: 20, t: 'Store in pgvector', s: 'With filters metadata' },
    ],
    cvFlow: [
      { k: 'io', t: 'CV submitted', s: '' },
      { k: 'local', ms: 400, t: 'Extract & clean text', s: '' },
      { k: 'llm', stage: 'cvParse', t: 'LLM → structured JSON', s: 'Skills, education, experience, certs, languages, sector, location' },
      { k: 'db', ms: 160, t: 'Embed + pgvector top 20', s: 'Location, remote, salary, job-type filters' },
      { k: 'llm', stage: 'questions', t: 'LLM writes 10–30 questions', s: 'Per job, every time' },
      { k: 'llm', stage: 'jev', t: 'Jev scores criteria', s: 'Score + confidence each' },
      { k: 'local', ms: 10, t: 'Combine into match score', s: 'Optional weighting' },
      { k: 'llm', stage: 'explain', t: 'Cheap LLM explanation', s: 'Why suitable / not suitable' },
    ],
    items: [
      { name: 'CV text extraction / OCR', cost: 0.0008, unit: 'cv' },
      { name: 'Embeddings — CV', cost: 0.0001, unit: 'cv' },
      { name: 'Embeddings — job', cost: 0.0001, unit: 'job' },
      { name: 'AWS Lambda orchestration', cost: 0.0004, unit: 'cv' },
      { name: 'PostgreSQL + pgvector (RDS)', cost: 150, unit: 'month' },
    ],
  },
  A3: {
    name: 'Architecture 3', title: 'Pre-computed criteria', color: 'var(--a3)', hex: '#5fe3a1',
    blurb: 'Expensive AI work moves to job creation: one LLM call stores the questions. CVs are handled locally first, hybrid retrieval narrows ~100 → 8–12 jobs with a non-AI reranker, Jev evaluates stored criteria in batches, and ranking/explanations are deterministic.',
    params: A3_PARAMS, stages: A3_STAGES, jobFlow: A3_JOB, cvFlow: A3_CV,
    items: [
      { name: 'Local text extraction + lightweight NLP', cost: 0.0003, unit: 'cv' },
      { name: 'Local embedding — CV', cost: 0.00008, unit: 'cv' },
      { name: 'Local embedding — job', cost: 0.0001, unit: 'job' },
      { name: 'Hybrid retrieval + non-AI reranker (SQL/PostGIS)', cost: 0.0003, unit: 'cv' },
      { name: 'AWS Lambda orchestration', cost: 0.0004, unit: 'cv' },
      { name: 'PostgreSQL + PostGIS (RDS)', cost: 150, unit: 'month' },
      { name: 'Tenant ranking-model training', cost: 20, unit: 'month' },
    ],
  },
  A4: {
    name: 'Architecture 3 + Routing', title: 'Cost- and confidence-aware model routing', color: 'var(--a4)', hex: '#ff6bb5',
    blurb: 'Architecture 3 with a cascading router. Easy cases are resolved by rules/local parsers (no API), moderate ones go to a cheap model, and only ambiguous or low-confidence cases escalate to the stage’s stronger model.',
    params: A3_PARAMS,
    stages: A3_STAGES.map(s => ({ ...s, route: ROUTED.includes(s.id) })),
    jobFlow: insertRouters(A3_JOB), cvFlow: insertRouters(A3_CV),
    items: [
      { name: 'Local text extraction + lightweight NLP', cost: 0.0003, unit: 'cv' },
      { name: 'Local embedding — CV', cost: 0.00008, unit: 'cv' },
      { name: 'Local embedding — job', cost: 0.0001, unit: 'job' },
      { name: 'Hybrid retrieval + non-AI reranker (SQL/PostGIS)', cost: 0.0003, unit: 'cv' },
      { name: 'AWS Lambda orchestration', cost: 0.0004, unit: 'cv' },
      { name: 'Router service / confidence checks', cost: 0.0001, unit: 'cv' },
      { name: 'PostgreSQL + PostGIS (RDS)', cost: 150, unit: 'month' },
      { name: 'Tenant ranking-model training', cost: 20, unit: 'month' },
    ],
  },
  A5: {
    name: 'Architecture 4', title: 'Local ML retrieve-and-rerank', color: 'var(--a5)', hex: '#c9a0ff',
    blurb: 'Jobs and CVs are parsed deterministically and embedded by a local bi-encoder. pgvector retrieves ~100 jobs, a local fine-tuned cross-encoder reranks them to ~20, rules and probability calibration finish the job. The normal path makes zero API calls; only uncertain cases escalate to a stronger local reranker and then a tiny, cached LLM fallback over 3–5 jobs.',
    params: [
      { k: 'fallbackRate', label: 'CVs reaching LLM fallback %', def: 5 },
      { k: 'fallbackJobs', label: 'Uncertain jobs in fallback (3–5)', def: 4 },
      { k: 'fbCacheHit', label: 'Fallback cache hit %', def: 10 },
    ],
    stages: [
      { id: 'fallback', name: 'LLM fallback — top 3–5 uncertain jobs', unit: 'cv', calls: p => p.fallbackRate / 100 * (1 - p.fbCacheHit / 100),
        tok: p => [1500 + 1000 * p.fallbackJobs, 400 * p.fallbackJobs], note: 'One batched call, result cached for consistency' },
    ],
    jobFlow: [
      { k: 'io', t: 'Job posted', s: 'Processed once' },
      { k: 'local', ms: 60, t: 'Clean + deterministic parse', s: 'Title, skills, experience, salary, location, work mode, mandatory reqs' },
      { k: 'ml', ms: 40, t: 'Local bi-encoder embedding', s: 'Job vector' },
      { k: 'db', ms: 20, t: 'Postgres + pgvector + PostGIS', s: 'Vector + structured fields' },
    ],
    cvFlow: [
      { k: 'io', t: 'CV uploaded', s: 'Processed ephemerally' },
      { k: 'local', ms: 300, t: 'Extract, clean, deterministic parse', s: 'Structured candidate info' },
      { k: 'ml', ms: 40, t: 'Bi-encoder CV embedding', s: 'Same model as jobs' },
      { k: 'db', ms: 40, t: 'Hard filters', s: 'Location, work mode, type, salary, mandatory' },
      { k: 'db', ms: 60, t: 'pgvector → top ~100', s: 'Fast ANN retrieval' },
      { k: 'ml', ms: 400, t: 'Cross-encoder rerank → top 20', s: 'Fine-tuned; reads CV + job together' },
      { k: 'local', ms: 15, t: 'Mandatory rules + calibration', s: 'Reliable probability scores' },
      { k: 'local', ms: 5, t: 'High confidence → templates', s: 'Deterministic explanations, return' },
      { k: 'ml', ms: 160, t: 'Uncertain → stronger local reranker', s: 'Expected cost (≈20% of CVs)' },
      { k: 'llm', stage: 'fallback', t: 'LLM fallback (rare)', s: 'Top 3–5 uncertain jobs only, cached' },
      { k: 'io', t: 'Ranked results', s: 'Same input + model version → same ranking' },
    ],
    items: [
      { name: 'CV text extraction (local)', cost: 0.0003, unit: 'cv' },
      { name: 'Bi-encoder inference — CV', cost: 0.00005, unit: 'cv' },
      { name: 'Bi-encoder inference — job', cost: 0.00005, unit: 'job' },
      { name: 'Cross-encoder inference (top 100 pairs)', cost: 0.0004, unit: 'cv' },
      { name: 'AWS Lambda orchestration', cost: 0.0004, unit: 'cv' },
      { name: 'GPU/CPU hosting for local models', cost: 600, unit: 'month' },
      { name: 'Fine-tuning + labelled data upkeep', cost: 100, unit: 'month' },
      { name: 'PostgreSQL + pgvector + PostGIS (RDS)', cost: 150, unit: 'month' },
    ],
  },
};
const KEYS = Object.keys(ARCHS);
const UNITS = { cv: 'per CV', job: 'per job', month: 'per month', once: 'one-off' };
const SPLIT_DEF = { jobParse: { det: 5, cheap: 70 }, cvFallback: { det: 40, cheap: 45 }, jev: { det: 15, cheap: 65 } };

/* ---------- State ---------- */
const STORE = 'matching-sim-v2';
function defaults() {
  const s = {
    cvs: 1000, jobs: 500, months: 1, repeat: 10, concurrency: 10, tab: 'overview',
    global: { model: 'claude-sonnet-5-5', effort: 'medium' },
    prices: {}, params: {}, stages: {}, items: {}, ms: {},
    route: { cheapModel: 'claude-haiku-5-5', cheapEffort: 'low', cascade: true, splits: JSON.parse(JSON.stringify(SPLIT_DEF)) },
  };
  MODELS.forEach(m => s.prices[m.id] = { inP: m.inP, outP: m.outP, tps: m.tps, ttft: m.ttft });
  KEYS.forEach(k => {
    const a = ARCHS[k];
    s.params[k] = Object.fromEntries(a.params.map(p => [p.k, p.def]));
    s.stages[k] = Object.fromEntries(a.stages.map(st => [st.id, { model: st.dModel || s.global.model, effort: st.dEffort || s.global.effort }]));
    s.items[k] = a.items.map(i => ({ ...i }));
    s.ms[k] = {};
    [['job', a.jobFlow], ['cv', a.cvFlow]].forEach(([l, f]) => f.forEach((n, i) => { if (n.ms != null) s.ms[k][l + i] = n.ms; }));
  });
  return s;
}
let S = defaults();
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved) {
    const d = defaults();
    S = { ...d, ...saved, global: { ...d.global, ...saved.global }, route: { ...d.route, ...saved.route, splits: { ...d.route.splits, ...(saved.route || {}).splits } } };
    KEYS.forEach(k => {
      S.params[k] = { ...d.params[k], ...(saved.params || {})[k] };
      S.prices = Object.fromEntries(MODELS.map(m => [m.id, { ...d.prices[m.id], ...((saved.prices || {})[m.id]) }]));
      S.ms[k] = { ...d.ms[k], ...((saved.ms || {})[k]) };
      Object.keys(d.stages[k]).forEach(id => S.stages[k][id] = { ...d.stages[k][id], ...((saved.stages || {})[k] || {})[id] });
      S.items[k] = ((saved.items || {})[k]) || d.items[k];
    });
  }
} catch (e) { /* ignore */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };

/* ---------- Calculation ---------- */
function tierCost(calls, I, O, modelId, effort) {
  const m = MODEL[modelId], pr = S.prices[modelId];
  const T = m.effort ? THINK[effort] : 0;
  const inTok = R_IN.map(r => calls * I * r);
  const outTok = R_OUT.map((r, i) => calls * (O * r + T * R_THINK[i]));
  const cost = inTok.map((x, i) => (x * pr.inP + outTok[i] * pr.outP) / 1e6);
  // single-call latency (s): time-to-first-token + prefill + generation (output + thinking)
  const lat = R_IN.map((r, i) => pr.ttft + (I * r) / PREFILL_TPS + (O * R_OUT[i] + T * R_THINK[i]) / pr.tps);
  return { calls, model: modelId, effort: m.effort ? effort : 'n/a', inTok, outTok, cost, lat };
}
const add3 = (a, b) => a.map((x, i) => x + b[i]);

function stageCalc(k, st) {
  const p = S.params[k], cfg = S.stages[k][st.id];
  const [dI, dO] = st.tok(p);
  const I = cfg.in ?? dI, O = cfg.out ?? dO;
  const units = st.unit === 'job' ? S.jobs : S.cvs * (st.cached ? 1 - S.repeat / 100 : 1);
  const base = units * st.calls(p);
  let tiers = [], skipped = 0, label = null;
  if (st.route) {
    const sp = S.route.splits[st.id];
    const det = Math.min(1, sp.det / 100), cheap = Math.min(1 - det, sp.cheap / 100), strong = Math.max(0, 1 - det - cheap);
    skipped = base * det;
    const cheapCalls = base * (cheap + (S.route.cascade ? strong : 0));
    tiers = [
      { ...tierCost(cheapCalls, I, O, S.route.cheapModel, S.route.cheapEffort), tier: 'Cheap tier', w: cheap + (S.route.cascade ? strong : 0) },
      { ...tierCost(base * strong, I, O, cfg.model, cfg.effort), tier: 'Escalated (strong)', w: strong },
    ];
    label = { det, cheap, strong };
  } else tiers = [{ ...tierCost(base, I, O, cfg.model, cfg.effort), w: 1 }];
  const sum = f => tiers.reduce((a, t) => add3(a, t[f]), [0, 0, 0]);
  const calls = tiers.reduce((a, t) => a + t.calls, 0);
  // Expected wall-clock per unit: calls run in parallel up to S.concurrency; fractional call counts are probabilities.
  const cpu = st.calls(p), rounds = cpu < 1 ? cpu : ceil(cpu / Math.max(1, S.concurrency));
  const lat = [0, 1, 2].map(i => rounds * tiers.reduce((a, t) => a + t.w * t.lat[i], 0));
  return { st, cfg, I, O, base, units, calls, skipped, tiers, label, lat, inTok: sum('inTok'), outTok: sum('outTok'), cost: sum('cost') };
}

function compute(k) {
  const a = ARCHS[k];
  const stages = a.stages.map(st => stageCalc(k, st));
  const llm = stages.reduce((x, s) => add3(x, s.cost), [0, 0, 0]);
  const other = S.items[k].map(it => {
    const n = { cv: S.cvs, job: S.jobs, month: S.months, once: 1 }[it.unit];
    return { ...it, total: (+it.cost || 0) * n };
  });
  const otherTotal = other.reduce((x, i) => x + i.total, 0);
  const total = llm.map(x => x + otherTotal);
  const msSum = lane => (lane === 'job' ? a.jobFlow : a.cvFlow).reduce((x, n, i) => x + (+S.ms[k][lane + i] || 0), 0) / 1000;
  const llmLat = unit => stages.filter(s => s.st.unit === unit).reduce((x, s) => add3(x, s.lat), [0, 0, 0]);
  const lat = { job: llmLat('job').map(x => x + msSum('job')), cv: llmLat('cv').map(x => x + msSum('cv')) };
  return {
    k, stages, llm, other, otherTotal, total, lat, localCv: msSum('cv'),
    calls: stages.reduce((x, s) => x + s.calls, 0),
    tokIn: stages.reduce((x, s) => x + s.inTok[1], 0),
    tokOut: stages.reduce((x, s) => x + s.outTok[1], 0),
  };
}

/* ---------- Formatting ---------- */
const money = x => {
  if (!isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1000) return '$' + Math.round(x).toLocaleString();
  if (a >= 1) return '$' + x.toFixed(2);
  if (a === 0) return '$0';
  if (a >= 0.01) return '$' + x.toFixed(3);
  return '$' + x.toPrecision(2);
};
const compact = x => {
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (x / 1e3).toFixed(1) + 'K';
  return Math.round(x).toLocaleString();
};
const dur = x => {
  if (!isFinite(x)) return '—';
  if (x < 1) return Math.round(x * 1000) + ' ms';
  if (x < 60) return x.toFixed(x < 10 ? 2 : 1) + ' s';
  return Math.floor(x / 60) + 'm ' + Math.round(x % 60) + 's';
};
const calls = x => x >= 100 ? Math.round(x).toLocaleString() : (Math.round(x * 100) / 100).toString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const modelOpts = sel => MODELS.map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${m.name}</option>`).join('');
const effortOpts = sel => EFFORTS.map(e => `<option ${e === sel ? 'selected' : ''}>${e}</option>`).join('');
const PALETTE = ['#7c9cff', '#ff9f5a', '#5fe3a1', '#ff6bb5', '#4cc9f0', '#c9a0ff', '#ffd166'];

/* ---------- Controls (static DOM) ---------- */
const $ = id => document.getElementById(id);
const logMap = (pos, max) => Math.max(0, Math.round(Math.pow(10, (pos / 1000) * Math.log10(max + 1)) - 1));
const logInv = (v, max) => Math.round(Math.log10(v + 1) / Math.log10(max + 1) * 1000);
const CV_MAX = 200000, JOB_MAX = 100000;

function initControls() {
  $('gModel').innerHTML = modelOpts(S.global.model);
  $('gEffort').innerHTML = effortOpts(S.global.effort);
  syncControls();
  $('cvsRange').oninput = e => { S.cvs = logMap(+e.target.value, CV_MAX); $('cvsNum').value = S.cvs; commit(); };
  $('jobsRange').oninput = e => { S.jobs = logMap(+e.target.value, JOB_MAX); $('jobsNum').value = S.jobs; commit(); };
  $('cvsNum').oninput = e => { S.cvs = Math.max(0, +e.target.value || 0); $('cvsRange').value = logInv(Math.min(S.cvs, CV_MAX), CV_MAX); commit(); };
  $('jobsNum').oninput = e => { S.jobs = Math.max(0, +e.target.value || 0); $('jobsRange').value = logInv(Math.min(S.jobs, JOB_MAX), JOB_MAX); commit(); };
  $('monthsNum').oninput = e => { S.months = Math.max(0, +e.target.value || 0); commit(); };
  $('concNum').oninput = e => { S.concurrency = Math.max(1, +e.target.value || 1); commit(); };
  $('repeatNum').oninput = e => { S.repeat = Math.min(100, Math.max(0, +e.target.value || 0)); commit(); };
  $('gModel').onchange = e => S.global.model = e.target.value;
  $('gEffort').onchange = e => S.global.effort = e.target.value;
  $('applyAll').onclick = () => {
    KEYS.forEach(k => ARCHS[k].stages.forEach(st => {
      S.stages[k][st.id].model = S.global.model; S.stages[k][st.id].effort = S.global.effort;
    }));
    commit();
  };
  $('pricingTable').innerHTML = `<table><tr><th>Model</th><th class="num">Input $/MTok</th><th class="num">Output $/MTok</th><th class="num">Output tok/s</th><th class="num">TTFT (s)</th><th>Model ID</th></tr>${
    MODELS.map(m => `<tr><td>${m.name}</td>
      <td class="num"><input type="number" step="any" min="0" data-price="${m.id}.inP" value="${S.prices[m.id].inP}"></td>
      <td class="num"><input type="number" step="any" min="0" data-price="${m.id}.outP" value="${S.prices[m.id].outP}"></td>
      <td class="num"><input type="number" step="any" min="1" data-price="${m.id}.tps" value="${S.prices[m.id].tps}"></td>
      <td class="num"><input type="number" step="any" min="0" data-price="${m.id}.ttft" value="${S.prices[m.id].ttft}"></td>
      <td><code>${m.id}</code></td></tr>`).join('')}</table>`;
  $('pricingTable').onchange = e => {
    const [id, f] = e.target.dataset.price.split('.');
    S.prices[id][f] = Math.max(f === 'tps' ? 1 : 0, +e.target.value || 0); commit();
  };
}
function syncControls() {
  $('cvsNum').value = S.cvs; $('jobsNum').value = S.jobs;
  $('cvsRange').value = logInv(Math.min(S.cvs, CV_MAX), CV_MAX);
  $('jobsRange').value = logInv(Math.min(S.jobs, JOB_MAX), JOB_MAX);
  $('monthsNum').value = S.months; $('repeatNum').value = S.repeat; $('concNum').value = S.concurrency;
}
function commit() { save(); render(); }

/* ---------- Rendering ---------- */
let simTimer = null;
function stopSim() { clearTimeout(simTimer); simTimer = null; }

function renderTabs() {
  const tabs = [['overview', 'Overview', null], ...KEYS.map(k => [k, ARCHS[k].name.replace('Architecture ', 'Arch '), ARCHS[k].hex])];
  $('tabs').innerHTML = tabs.map(([id, label, c]) =>
    `<button class="tab ${S.tab === id ? 'active' : ''}" data-tab="${id}">${c ? `<span class="dot" style="background:${c}"></span>` : ''}${label}</button>`).join('');
}

function render() {
  stopSim();
  renderTabs();
  const scroll = window.scrollY;
  $('view').innerHTML = S.tab === 'overview' ? viewOverview() : viewArch(S.tab);
  window.scrollTo(0, scroll);
}

/* ----- Overview ----- */
function viewOverview() {
  const R = KEYS.map(compute);
  const cheapest = R.reduce((m, r) => r.total[1] < m.total[1] ? r : m, R[0]);
  const fastest = R.reduce((m, r) => r.lat.cv[1] < m.lat.cv[1] ? r : m, R[0]);
  const maxLat = Math.max(...R.map(r => r.lat.cv[2]), 1e-9);
  const maxHi = Math.max(...R.map(r => r.total[2]), 1e-9);
  const cards = R.map(r => {
    const a = ARCHS[r.k];
    return `<div class="card" style="--c:${a.hex}">
      ${r === cheapest ? '<span class="badge">LOWEST COST</span>' : r === fastest ? '<span class="badge">FASTEST</span>' : ''}
      <h4>${a.name}</h4><div class="ttl">${a.title}</div>
      <div class="big">${money(r.total[1])}</div>
      <div class="range">range ${money(r.total[0])} – ${money(r.total[2])}</div>
      <div class="kv">
        <span>LLM API cost (est.)</span><span>${money(r.llm[1])}</span>
        <span>Other costs</span><span>${money(r.otherTotal)}</span>
        <span>LLM API calls</span><span>${compact(r.calls)}</span>
        <span>Input tokens</span><span>${compact(r.tokIn)}</span>
        <span>Output tokens (incl. thinking)</span><span>${compact(r.tokOut)}</span>
        <span>CV match latency (est.)</span><span>${dur(r.lat.cv[1])}</span>
        <span>Job ingest latency</span><span>${dur(r.lat.job[1])}</span>
        <span>Cost per CV matched</span><span>${S.cvs ? money(r.total[1] / S.cvs) : '—'}</span>
        <span>API calls per CV</span><span>${S.cvs ? calls(r.stages.filter(s => s.st.unit === 'cv').reduce((x, s) => x + s.calls, 0) / S.cvs) : '—'}</span>
      </div></div>`;
  }).join('');

  const bars = R.map(r => {
    const a = ARCHS[r.k], w = x => (x / maxHi * 100).toFixed(2);
    return `<div class="bar-row">
      <div><b>${a.name}</b><div class="range">${a.title}</div></div>
      <div class="bar" title="LLM ${money(r.llm[1])} · other ${money(r.otherTotal)}">
        <div class="seg" style="width:${w(r.llm[1])}%;background:${a.hex}"></div>
        <div class="seg" style="width:${w(r.otherTotal)}%;background:${a.hex};opacity:.4"></div>
        <div class="rng" style="left:${w(r.total[0])}%;width:${Math.max(0.3, w(r.total[2]) - w(r.total[0]))}%"></div>
      </div>
      <div class="num"><b>${money(r.total[1])}</b></div></div>`;
  }).join('');

  const latBars = R.map(r => {
    const a = ARCHS[r.k], w = x => (x / maxLat * 100).toFixed(2), llmPart = r.lat.cv[1] - r.localCv;
    return `<div class="bar-row"><div><b>${a.name}</b><div class="range">${a.title}</div></div>
      <div class="bar" title="LLM ${dur(llmPart)} · local ${dur(r.localCv)}">
        <div class="seg" style="width:${w(llmPart)}%;background:${a.hex}"></div>
        <div class="seg" style="width:${w(r.localCv)}%;background:${a.hex};opacity:.4"></div>
        <div class="rng" style="left:${w(r.lat.cv[0])}%;width:${Math.max(0.3, w(r.lat.cv[2]) - w(r.lat.cv[0]))}%"></div></div>
      <div class="num"><b>${dur(r.lat.cv[1])}</b><div class="range">LLM ${dur(llmPart)} · local ${dur(r.localCv)}</div></div></div>`;
  }).join('');
  const rows = R.map(r => `<tr><td><span class="dot" style="background:${ARCHS[r.k].hex}"></span> ${ARCHS[r.k].name}</td>
    <td class="num">${compact(r.calls)}</td><td class="num">${dur(r.lat.cv[1])}<div class="range">${dur(r.lat.cv[0])} – ${dur(r.lat.cv[2])}</div></td><td class="num">${compact(r.tokIn)}</td><td class="num">${compact(r.tokOut)}</td>
    <td class="num">${money(r.llm[0])} – ${money(r.llm[2])}</td><td class="num">${money(r.otherTotal)}</td>
    <td class="num"><b>${money(r.total[1])}</b></td></tr>`).join('');

  return `
  <section class="panel"><h2>Total cost comparison</h2>
    <div class="range">${S.cvs.toLocaleString()} CVs · ${S.jobs.toLocaleString()} jobs · ${S.months} month(s). Solid = LLM API, faded = other costs, hatched = min–max range.</div>
    <div style="margin-top:14px">${bars}</div></section>
  <div class="cards">${cards}</div>
  <section class="panel"><h2>Latency per CV match (end-to-end)</h2>
    <div class="range">Solid = estimate, hatched = min–max. Assumes up to ${S.concurrency} LLM calls in parallel; cache hits not counted. LLM time = time-to-first-token + prefill + generation (incl. thinking).</div>
    <div style="margin-top:14px">${latBars}</div></section>
  <section class="panel"><h2>Side-by-side</h2><div class="tbl-wrap"><table>
    <tr><th>Architecture</th><th class="num">LLM calls</th><th class="num">Latency / CV</th><th class="num">Input tok</th><th class="num">Output tok</th><th class="num">LLM cost range</th><th class="num">Other</th><th class="num">Total (est.)</th></tr>${rows}</table></div></section>
  <section class="panel"><h2>Cost vs. number of CVs</h2>
    <div class="range">Job count held at ${S.jobs.toLocaleString()}. Log–log scale; the dashed line is your current CV count.</div>
    ${scaleChart()}</section>`;
}

function scaleChart() {
  const W = 900, H = 320, L = 64, B = 34, T = 14, Rr = 16;
  const pts = []; for (let e = 0; e <= 5.3; e += 0.1) pts.push(Math.round(Math.pow(10, e)));
  const saved = S.cvs;
  const data = KEYS.map(k => pts.map(n => { S.cvs = n; return compute(k).total[1]; }));
  S.cvs = saved;
  const all = data.flat().filter(v => v > 0);
  if (!all.length) return '';
  const y0 = Math.floor(Math.log10(Math.min(...all))), y1 = Math.ceil(Math.log10(Math.max(...all)));
  const x = n => L + (Math.log10(n) / 5.3) * (W - L - Rr);
  const y = v => T + (1 - (Math.log10(Math.max(v, 1e-12)) - y0) / Math.max(1, y1 - y0)) * (H - T - B);
  let g = '';
  for (let e = y0; e <= y1; e++) g += `<line x1="${L}" x2="${W - Rr}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" stroke="#27325f"/><text x="${L - 8}" y="${y(10 ** e) + 4}" text-anchor="end" fill="#93a0cf" font-size="11">${money(10 ** e)}</text>`;
  [1, 10, 100, 1e3, 1e4, 1e5].forEach(n => g += `<text x="${x(n)}" y="${H - 10}" text-anchor="middle" fill="#93a0cf" font-size="11">${compact(n)}</text>`);
  const lines = KEYS.map((k, i) => `<polyline fill="none" stroke="${ARCHS[k].hex}" stroke-width="2.5" points="${pts.map((n, j) => `${x(n).toFixed(1)},${y(data[i][j]).toFixed(1)}`).join(' ')}"/>`).join('');
  const cur = S.cvs > 0 ? `<line x1="${x(Math.min(S.cvs, 2e5))}" x2="${x(Math.min(S.cvs, 2e5))}" y1="${T}" y2="${H - B}" stroke="#fff" stroke-dasharray="4 4" opacity=".6"/>` : '';
  const legend = KEYS.map(k => `<span><i style="background:${ARCHS[k].hex}"></i>${ARCHS[k].name}</span>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost vs CV volume">${g}${lines}${cur}</svg><div class="legend">${legend}</div>`;
}

/* ----- Architecture view ----- */
function nodeHTML(n, R, k, id) {
  let stat = '', data = '', split = '';
  if (n.stage) {
    const s = R.stages.find(x => x.st.id === n.stage);
    const per = s.units ? s.calls / s.units : 0, pc = s.units ? s.cost[1] / s.units : 0, pt = s.units ? (s.inTok[1] + s.outTok[1]) / s.units : 0;
    const pl = s.units ? s.lat[1] : 0;
    stat = `<div class="stat"><span>${calls(per)} call${per === 1 ? '' : 's'}</span><span>${money(pc)}</span></div><div class="stat lat"><span>⏱ latency</span><span>${dur(pl)}</span></div>`;
    data = `data-calls="${per}" data-cost="${pc}" data-tok="${pt}" data-lat="${pl}" data-unit="${s.st.unit}"`;
    if (s.label) split = `<div class="split" title="rules ${(s.label.det * 100).toFixed(0)}% · cheap ${(s.label.cheap * 100).toFixed(0)}% · strong ${(s.label.strong * 100).toFixed(0)}%">
      <i style="width:${s.label.det * 100}%;background:#5fe3a1"></i><i style="width:${s.label.cheap * 100}%;background:#4cc9f0"></i><i style="width:${s.label.strong * 100}%;background:#ff6bb5"></i></div>`;
  }
  if (n.ms != null) {
    const ms = +S.ms[k][id] || 0;
    stat = `<div class="stat lat"><span>⏱ latency</span><span>${dur(ms / 1000)}</span></div>`;
    data = `data-lat="${ms / 1000}"`;
  }
  const tag = { llm: 'LLM', db: 'DB', local: 'LOCAL', ml: 'LOCAL ML', router: 'ROUTER', io: 'I/O' }[n.k];
  return `<div class="node k-${n.k}" ${data}><span class="tag ${n.k}">${tag}</span><div class="t">${esc(n.t)}</div><div class="s">${esc(n.s)}</div>${split}${stat}</div>`;
}
const lane = (title, sub, flow, R, k, key, lat) => `<div class="lane" data-lane="${key}"><div class="lane-h"><b>${title}</b><span>${sub} · latency ${dur(lat[0])} – ${dur(lat[2])} (est. ${dur(lat[1])})</span></div>
  <div class="flow">${flow.map((n, i) => (i ? '<div class="conn"></div>' : '') + nodeHTML(n, R, k, key + i)).join('')}</div></div>`;

function viewArch(k) {
  const a = ARCHS[k], R = compute(k);
  const params = a.params.map(p => `<label>${p.label}<br><input type="number" step="any" min="0" data-path="params.${k}.${p.k}" data-t="n" value="${S.params[k][p.k]}"></label>`).join('');
  const routeCfg = k !== 'A4' ? '' : `
    <div class="params" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
      <label>Cheap-tier model (Flash-Lite-class)<br><select data-path="route.cheapModel" data-t="s">${modelOpts(S.route.cheapModel)}</select></label>
      <label>Cheap-tier effort<br><select data-path="route.cheapEffort" data-t="s">${effortOpts(S.route.cheapEffort)}</select></label>
      <label><br><input type="checkbox" data-path="route.cascade" data-t="b" ${S.route.cascade ? 'checked' : ''}> Escalated cases also pay for the failed cheap attempt</label>
    </div>`;

  let body = '';
  R.stages.forEach(s => {
    const st = s.st, c = s.cfg, base = `stages.${k}.${st.id}`;
    const top = s.tiers[0];
    const showModel = !st.route;
    body += `<tr>
      <td><b>${esc(st.name)}</b><div class="range">${st.unit === 'job' ? 'once per job' : 'per CV'}${st.cached ? ' · cache-adjusted' : ''}${st.note ? ' · ' + esc(st.note) : ''}</div></td>
      <td class="num">${calls(s.calls)}${s.skipped ? `<div class="range">+${calls(s.skipped)} skipped by rules</div>` : ''}</td>
      <td>${showModel ? `<select data-path="${base}.model" data-t="s">${modelOpts(c.model)}</select>` : `<span class="range">Escalation model:</span><br><select data-path="${base}.model" data-t="s">${modelOpts(c.model)}</select>`}</td>
      <td>${MODEL[c.model].effort ? `<select data-path="${base}.effort" data-t="s">${effortOpts(c.effort)}</select>` : '<span class="range">n/a</span>'}</td>
      <td class="num"><input type="number" min="0" data-path="${base}.in" data-t="o" value="${s.I}"></td>
      <td class="num"><input type="number" min="0" data-path="${base}.out" data-t="o" value="${s.O}"></td>
      <td class="num">${compact(s.inTok[1])} in<br>${compact(s.outTok[1])} out</td>
      <td class="num">${dur(s.lat[1])}<div class="range">${dur(s.lat[0])} – ${dur(s.lat[2])}</div></td>
      <td class="num"><b>${money(s.cost[1])}</b><div class="range">${money(s.cost[0])} – ${money(s.cost[2])}</div></td></tr>`;
    if (st.route) {
      const sp = S.route.splits[st.id];
      body += `<tr class="sub"><td colspan="9">Routing split —
        rules/local (no API) <input type="number" min="0" max="100" data-path="route.splits.${st.id}.det" data-t="n" value="${sp.det}">%
        &nbsp; cheap model <input type="number" min="0" max="100" data-path="route.splits.${st.id}.cheap" data-t="n" value="${sp.cheap}">%
        &nbsp; escalated <b>${(s.label.strong * 100).toFixed(0)}%</b> (remainder)
        &nbsp;→ ${s.tiers.map(t => `${t.tier}: ${calls(t.calls)} calls on ${MODEL[t.model].name}${t.effort !== 'n/a' ? ' / ' + t.effort : ''} = ${money(t.cost[1])}`).join(' · ')}</td></tr>`;
    }
  });

  const total = R.llm;
  const segs = R.stages.filter(s => s.cost[1] > 0).map((s, i) => ({ n: s.st.name, v: s.cost[1], c: PALETTE[i % PALETTE.length] }));
  if (R.otherTotal > 0) segs.push({ n: 'Other costs', v: R.otherTotal, c: '#5b6794' });
  const sumSeg = segs.reduce((x, s) => x + s.v, 0) || 1;
  const stack = `<div class="bar" style="height:28px">${segs.map(s => `<div class="seg" style="width:${s.v / sumSeg * 100}%;background:${s.c}" title="${esc(s.n)} ${money(s.v)}"></div>`).join('')}</div>
    <div class="legend">${segs.map(s => `<span><i style="background:${s.c}"></i>${esc(s.n)} — ${money(s.v)} (${(s.v / sumSeg * 100).toFixed(0)}%)</span>`).join('')}</div>`;

  const items = S.items[k].map((it, i) => `<tr>
    <td><input type="text" data-path="items.${k}.${i}.name" data-t="s" value="${esc(it.name)}"></td>
    <td class="num"><input type="number" step="any" min="0" data-path="items.${k}.${i}.cost" data-t="n" value="${it.cost}"></td>
    <td><select data-path="items.${k}.${i}.unit" data-t="s">${Object.entries(UNITS).map(([u, l]) => `<option value="${u}" ${u === it.unit ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td class="num">${money(R.other[i].total)}</td>
    <td><button class="x" data-act="del" data-k="${k}" data-i="${i}" title="Remove">×</button></td></tr>`).join('');

  const msRows = [['job', 'Job', a.jobFlow], ['cv', 'CV', a.cvFlow]].flatMap(([l, lab, f]) =>
    f.map((n, i) => n.ms != null ? `<tr><td>${lab}</td><td>${esc(n.t)} <span class="tag ${n.k}">${{ ml: 'LOCAL ML', local: 'LOCAL', db: 'DB', router: 'ROUTER' }[n.k]}</span></td>
      <td class="num"><input type="number" min="0" step="any" data-path="ms.${k}.${l}${i}" data-t="n" value="${S.ms[k][l + i]}"> ms</td></tr>` : '')).join('');
  const jobsN = S.jobs, cvsN = S.cvs;
  return `
  <section class="panel">
    <div class="arch-head"><div><h2><span class="dot" style="background:${a.hex}"></span> ${a.name} — ${a.title}</h2><p>${a.blurb}</p></div>
      <button class="btn ghost sm" data-act="reset" data-k="${k}">Reset token overrides</button></div>
    <div class="params">${params}</div>${routeCfg}
  </section>

  <section class="panel">
    <div class="sim-bar"><button class="btn" data-act="play">▶ Run simulation</button>
      <div class="ticker" id="ticker"><span>Stage<b id="tkStage">—</b></span><span>LLM calls<b id="tkCalls">0</b></span><span>Tokens<b id="tkTok">0</b></span><span>Cost<b id="tkCost">$0</b></span><span>Job latency<b id="tkJob">0 ms</b></span><span>CV latency<b id="tkCvLat">0 ms</b></span></div></div>
    <div class="range">The simulation walks one job ingest and one CV match through the pipeline, accumulating average calls, tokens and cost.</div>
    ${lane('Job ingestion', `runs once per job · ${jobsN.toLocaleString()} jobs`, a.jobFlow, R, k, 'job', R.lat.job)}
    ${lane('CV matching', `runs per CV · ${cvsN.toLocaleString()} CVs`, a.cvFlow, R, k, 'cv', R.lat.cv)}
    <div class="legend"><span><span class="tag llm">LLM</span> Claude API call</span><span><span class="tag db">DB</span> Postgres / vector / geo</span><span><span class="tag local">LOCAL</span> deterministic / local compute</span><span><span class="tag ml">LOCAL ML</span> self-hosted model</span><span><span class="tag router">ROUTER</span> model router</span><span><span class="tag io">I/O</span> inputs / outputs</span></div>
  </section>

  <section class="panel"><h3>LLM stages — tokens &amp; cost</h3>
    <div class="tbl-wrap"><table>
      <tr><th>Stage</th><th class="num">Calls</th><th>Model</th><th>Effort</th><th class="num">In tok/call</th><th class="num">Out tok/call</th><th class="num">Total tokens (est.)</th><th class="num">Latency / unit</th><th class="num">Cost (est. · range)</th></tr>
      ${body}
      <tr class="tot"><td>LLM total</td><td class="num">${calls(R.calls)}</td><td></td><td></td><td></td><td></td>
        <td class="num">${compact(R.tokIn)} in<br>${compact(R.tokOut)} out</td><td></td><td class="num">${money(total[1])}<div class="range">${money(total[0])} – ${money(total[2])}</div></td></tr>
    </table></div>
    <p class="note">Output tokens include hidden thinking tokens for the chosen effort (billed as output). Latency/unit is per CV (or per job) with up to ${S.concurrency} calls in parallel. Edit tokens/call to match your real prompts.</p>
  </section>

  <div class="two">
    <section class="panel"><h3>Other costs (non-LLM)</h3>
      <div class="tbl-wrap"><table><tr><th>Name</th><th class="num">Cost (USD)</th><th>Unit</th><th class="num">Total</th><th></th></tr>${items}
        <tr class="tot"><td colspan="3">Other total</td><td class="num">${money(R.otherTotal)}</td><td></td></tr></table></div>
      <div style="margin-top:10px"><button class="btn ghost sm" data-act="add" data-k="${k}">+ Add cost line</button></div>
      <p class="note">Rename any line or set its price and unit (per CV, per job, per month, one-off). Defaults are placeholders — replace with your real AWS/Lambda/NLP costs.</p></section>
    <section class="panel"><h3>Total</h3>
      <div class="total-box"><div><div class="l">Total (est.)</div><div class="v">${money(R.total[1])}</div><div class="range">${money(R.total[0])} – ${money(R.total[2])}</div></div>
        <div><div class="l">LLM API</div><div class="v">${money(total[1])}</div></div>
        <div><div class="l">Other</div><div class="v">${money(R.otherTotal)}</div></div>
        <div><div class="l">Per CV</div><div class="v">${cvsN ? money(R.total[1] / cvsN) : '—'}</div></div>
        <div><div class="l">CV match latency</div><div class="v">${dur(R.lat.cv[1])}</div><div class="range">${dur(R.lat.cv[0])} – ${dur(R.lat.cv[2])}</div></div>
        <div><div class="l">Job ingest latency</div><div class="v">${dur(R.lat.job[1])}</div></div></div>
      <div style="margin-top:18px">${stack}</div></section>
  </div>
  <section class="panel"><h3>Non-LLM step latency (editable)</h3>
    <div class="tbl-wrap"><table><tr><th>Lane</th><th>Step</th><th class="num">Latency</th></tr>${msRows}</table></div>
    <p class="note">Steps run sequentially. Defaults are rough guesses (e.g. local cross-encoder over 100 pairs ≈ 400 ms) — replace with your own measurements.</p></section>`;
}

/* ---------- Simulation ---------- */
function runSim() {
  stopSim();
  const flows = [...document.querySelectorAll('.flow')];
  const steps = [];
  flows.forEach(f => [...f.children].forEach(el => steps.push(el)));
  document.querySelectorAll('.node,.conn').forEach(el => el.classList.remove('active', 'done'));
  flows.forEach(f => f.classList.add('running'));
  const acc = { calls: 0, tok: 0, cost: 0, job: 0, cv: 0 };
  ['tkCalls', 'tkTok', 'tkCost', 'tkJob', 'tkCvLat'].forEach(id => $(id).textContent = id === 'tkCost' ? '$0' : id.startsWith('tkJ') || id === 'tkCvLat' ? '0 ms' : '0');
  let i = 0;
  const tick = () => {
    if (i > 0) { const p = steps[i - 1]; p.classList.remove('active'); p.classList.add('done'); }
    if (i >= steps.length) { $('tkStage').textContent = 'Done'; flows.forEach(f => f.classList.remove('running')); return; }
    const el = steps[i];
    if (el.classList.contains('node')) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      $('tkStage').textContent = el.querySelector('.t').textContent;
      if (el.dataset.lat) {
        const l = el.closest('.lane').dataset.lane;
        acc[l] += +el.dataset.lat;
        $(l === 'job' ? 'tkJob' : 'tkCvLat').textContent = dur(acc[l]);
      }
      if (el.dataset.calls) {
        acc.calls += +el.dataset.calls; acc.tok += +el.dataset.tok; acc.cost += +el.dataset.cost;
        $('tkCalls').textContent = calls(acc.calls); $('tkTok').textContent = compact(acc.tok); $('tkCost').textContent = money(acc.cost);
      }
    } else el.classList.add('active');
    i++;
    simTimer = setTimeout(tick, el.classList.contains('node') ? 750 : 120);
  };
  tick();
}

/* ---------- Events ---------- */
function setPath(path, val) {
  const parts = path.split('.'); let o = S;
  parts.slice(0, -1).forEach(p => o = o[p]);
  const last = parts[parts.length - 1];
  if (val === undefined) delete o[last]; else o[last] = val;
}
$('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  S.tab = b.dataset.tab; save(); render(); window.scrollTo({ top: 0 });
});
$('view').addEventListener('change', e => {
  const t = e.target, path = t.dataset.path; if (!path) return;
  const type = t.dataset.t;
  let v;
  if (type === 'n') v = Math.max(0, +t.value || 0);
  else if (type === 'b') v = t.checked;
  else if (type === 'o') v = t.value === '' ? undefined : Math.max(0, +t.value || 0);
  else v = t.value;
  setPath(path, v); commit();
});
$('view').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, k = b.dataset.k;
  if (act === 'play') runSim();
  if (act === 'add') { S.items[k].push({ name: 'New cost item', cost: 0, unit: 'cv' }); commit(); }
  if (act === 'del') { S.items[k].splice(+b.dataset.i, 1); commit(); }
  if (act === 'reset') { Object.values(S.stages[k]).forEach(c => { delete c.in; delete c.out; }); commit(); }
});

initControls();
render();
