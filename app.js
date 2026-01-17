// @ts-nocheck
// ==== File Storage Engine (IndexedDB) ====
const DB_NAME = "LifeDexFiles";
const DB_STORE = "files";
function openFileDB(){
  return new Promise((res, rej)=>{
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(DB_STORE)){
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = ()=>res(req.result);
    req.onerror = ()=>rej(req.error);
  });
}
async function storeFile(id, blob){
  const db = await openFileDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(DB_STORE,"readwrite");
    tx.objectStore(DB_STORE).put(blob,id);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
async function loadFile(id){
  const db = await openFileDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(DB_STORE,"readonly");
    const req=tx.objectStore(DB_STORE).get(id);
    req.onsuccess=()=>res(req.result);
    req.onerror=()=>rej(req.error);
  });
}
async function deleteFile(id){
  const db = await openFileDB();
  return new Promise((res,rej)=>{
    const tx=db.transaction(DB_STORE,"readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
// ==== End File Storage Engine ====
// ==== Verification Engine (Milestones only) ====
function verifyMilestone(entryId){
  commit(draft=>{
    const t = draft.timeline.find(x=>x.id===entryId);
    if(!t) return;
    t.verified = true;
    t.verifiedAt = Date.now();
  });
  pushToast("Milestone verified");
}


function uid(){ return Math.random().toString(36).slice(2)+Date.now().toString(36); }

let SAVE_LOCK = false;
let DESTRUCTIVE_MODE = false;
const LEVELS = ["Beginner", "Practitioner", "Advanced", "Expert", "Master"];
const XP_STEP = 100;
const MAX_HISTORY = 30;
const MAX_TIMELINE = 300;
// --- HARDENING PASS (versioned storage) ---
const STORAGE_KEY = "lifedex_v2";
const SCHEMA_VERSION = 3;
const DEV = false;
// --- Sound scaffold (disabled for now; ready later) ---
const Sound = {
    enabled: false,
    play(name) {
        if (!this.enabled)
            return;
    }
};
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function safeUUID() {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
        return crypto.randomUUID();
    return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function assertSoft(cond, msg) { if (!cond && DEV)
    console.warn("[LifeDex]", msg); }
function safeNumber(n, fallback = 0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}
function safeString(s, fallback = "") {
    if (s === null || s === undefined)
        return fallback;
    return String(s);
}
function validDexType(t) { return ["Skill", "Career", "Trait", "Hobby"].includes(t); }
function validEntryType(t) { return safeString(t || "note", "note"); }
function dexTypeColor(type) {
    switch (type) {
        case "Skill": return "#22c55e";
        case "Career": return "#38bdf8";
        case "Trait": return "#a78bfa";
        case "Hobby": return "#fb923c";
        default: return "#fbbf24";
    }
}

// --- Semantic XP (keyword rules; deterministic) ---
const KEYWORD_XP = [
  { words: ["study","learn","practice","read","research","course","training"], xp: 3 },
  { words: ["build","create","code","design","write","draw","ship","deploy"], xp: 5 },
  { words: ["exercise","gym","run","lift","train","workout","cardio"], xp: 4 },
  { words: ["job","work","project","client","deadline","career","resume","portfolio"], xp: 5 },
  { words: ["help","volunteer","teach","mentor","coach","support"], xp: 4 },
  { words: ["meditate","focus","discipline","routine","plan","organize"], xp: 3 },
];
function analyzeTextXP(text){
  const t = safeString(text,"").toLowerCase();
  if (!t.trim()) return 0;
  let bonus = 0;
  for (const rule of KEYWORD_XP){
    for (const w of rule.words){
      if (t.includes(w)) { bonus += safeNumber(rule.xp,0); break; }
    }
  }
  // Safety clamp to avoid runaway bonus on very long text
  return clamp(bonus, 0, 25);
}

// --- Attachments (lightweight; localStorage-safe) ---
// Note: We embed small files as data URLs. Large files store metadata only.
const MAX_EMBED_BYTES = 90 * 1024; // ~90KB (safe for localStorage)
function isImageMime(m){ return /^image\//.test(safeString(m,"")); }
function sanitizeAttachments(list){
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list){
    if (!a) continue;
    const name = safeString(a.name,"").slice(0,120) || "Attachment";
    const type = safeString(a.type,"").slice(0,80);
    const size = clamp(safeNumber(a.size, 0), 0, 50_000_000);
    const dataUrl = safeString(a.dataUrl,"");
    // Keep dataUrl only if it looks like a data URL and isn't enormous
    const keepData = dataUrl.startsWith("data:") && dataUrl.length <= 1_200_000; // rough guard
    out.push({ name, type, size, dataUrl: keepData ? dataUrl : "" });
    if (out.length >= 3) break; // cap per entry
  }
  return out;
}

// --- Achievements (derived; no persistence needed) ---
const ACHIEVEMENTS = [
  // Milestones
  { id:"first_dex", group:"Milestone", title:"First Dex", desc:"Create your first Dex.", target:1,
    progress:s => (s?.dexes||[]).length },

  { id:"xp_1000", group:"Milestone", title:"1,000 Total XP", desc:"Reach 1,000 total XP across all Dexes.", target:1000,
    progress:s => totalXPFromDexes(s?.dexes||[]) },

  { id:"level_master", group:"Milestone", title:"Mastery", desc:"Reach Master in any Dex.", target:1,
    progress:s => (s?.dexes||[]).some(d => levelIndexFromXP(d?.xp) >= (LEVELS.length-1)) ? 1 : 0 },

  // Habits
  { id:"journal_10", group:"Habits", title:"Journal Habit", desc:"Write 10 journal entries.", target:10,
    progress:s => (s?.timeline||[]).filter(t => t?.entryType==="journal").length },

  { id:"capture_25", group:"Habits", title:"Moment Collector", desc:"Capture 25 moments.", target:25,
    progress:s => (s?.timeline||[]).filter(t => t?.entryType==="capture").length },

  { id:"streak_7", group:"Habits", title:"7-Day Streak", desc:"Be active 7 days in a row.", target:7,
    progress:s => computeStreakDaysFromDaySet(daySetFromTimeline(s?.timeline||[])) },

  // Consistency
  { id:"active_14", group:"Consistency", title:"Two Weeks Active", desc:"Record activity on 14 different days.", target:14,
    progress:s => daySetFromTimeline(s?.timeline||[]).size },

  { id:"timeline_100", group:"Consistency", title:"100 Moments", desc:"Reach 100 timeline items (any type).", target:100,
    progress:s => (s?.timeline||[]).length },
  // Career
  { id:"milestone_1", group:"Career", title:"First Milestone", desc:"Complete your first career milestone.", target:1,
    progress:s => (s?.timeline||[]).filter(t => t?.entryType==="milestone").length },

  { id:"milestone_10", group:"Career", title:"10 Milestones", desc:"Complete 10 career milestones.", target:10,
    progress:s => (s?.timeline||[]).filter(t => t?.entryType==="milestone").length },
];
// --- Career Progression Trees (Presets + Helpers) ---
const CAREER_PRESETS = [
  {
    id: "software_dev",
    title: "Software Developer",
    desc: "From fundamentals to shipping projects and getting hired.",
    nodes: [
      { id:"sd_found_html", group:"Foundation", title:"HTML Basics", desc:"Build 2 pages from scratch (no templates).", xp:120, requires:[] },
      { id:"sd_found_css", group:"Foundation", title:"CSS Fundamentals", desc:"Layout (flex/grid), responsive, and theming.", xp:140, requires:["sd_found_html"] },
      { id:"sd_found_js", group:"Foundation", title:"JavaScript Core", desc:"DOM, fetch, async/await, modules.", xp:180, requires:["sd_found_css"] },
      { id:"sd_git", group:"Foundation", title:"Git & GitHub", desc:"Commits, branches, PRs, and a repo you maintain.", xp:140, requires:["sd_found_js"] },

      { id:"sd_proj_portfolio", group:"Projects", title:"Portfolio Site", desc:"Deploy a portfolio with 3 projects.", xp:220, requires:["sd_git"] },
      { id:"sd_proj_app", group:"Projects", title:"Shipped App", desc:"Ship a small app with auth or persistence.", xp:260, requires:["sd_proj_portfolio"] },
      { id:"sd_proj_tests", group:"Projects", title:"Testing Basics", desc:"Add unit tests + a smoke test.", xp:180, requires:["sd_proj_app"] },
      { id:"sd_proj_oss", group:"Projects", title:"Open Source Contribution", desc:"One meaningful PR merged.", xp:240, requires:["sd_proj_tests"] },

      { id:"sd_pro_resume", group:"Professional", title:"Resume + LinkedIn", desc:"Polished resume + updated LinkedIn.", xp:160, requires:["sd_proj_app"] },
      { id:"sd_pro_apply", group:"Professional", title:"Job Applications", desc:"Apply to 30 roles with tracking.", xp:200, requires:["sd_pro_resume"] },
      { id:"sd_pro_interviews", group:"Professional", title:"Interview Prep", desc:"5 mock interviews or practice sessions.", xp:220, requires:["sd_pro_apply"] },
      { id:"sd_pro_offer", group:"Professional", title:"Offer / First Role", desc:"Land an offer or paid dev contract.", xp:400, requires:["sd_pro_interviews","sd_proj_oss"] },
    ]
  },
  {
    id: "ux_design",
    title: "UX / Product Designer",
    desc: "Portfolio-first path to professional design work.",
    nodes: [
      { id:"ux_found_principles", group:"Foundation", title:"Design Principles", desc:"Hierarchy, typography, spacing, color.", xp:160, requires:[] },
      { id:"ux_found_tools", group:"Foundation", title:"Figma Proficiency", desc:"Components, variants, auto-layout.", xp:180, requires:["ux_found_principles"] },
      { id:"ux_found_research", group:"Foundation", title:"User Research Basics", desc:"Plan + run 3 interviews.", xp:200, requires:["ux_found_tools"] },

      { id:"ux_proj_case1", group:"Projects", title:"Case Study #1", desc:"Problem → research → design → iteration.", xp:260, requires:["ux_found_research"] },
      { id:"ux_proj_case2", group:"Projects", title:"Case Study #2", desc:"A different domain or user group.", xp:280, requires:["ux_proj_case1"] },
      { id:"ux_proj_proto", group:"Projects", title:"Interactive Prototype", desc:"High-fidelity clickable prototype.", xp:220, requires:["ux_proj_case2"] },

      { id:"ux_pro_portfolio", group:"Professional", title:"Portfolio Ready", desc:"Publish portfolio with 2–3 case studies.", xp:240, requires:["ux_proj_proto"] },
      { id:"ux_pro_network", group:"Professional", title:"Networking", desc:"10 outreach messages + 3 calls.", xp:200, requires:["ux_pro_portfolio"] },
      { id:"ux_pro_role", group:"Professional", title:"First Design Role", desc:"Land a role, internship, or paid freelance.", xp:420, requires:["ux_pro_network"] },
    ]
  },
  {
    id: "business_sales",
    title: "Business / Sales",
    desc: "Pipeline, outreach, and closing fundamentals.",
    nodes: [
      { id:"bs_found_offer", group:"Foundation", title:"Offer & ICP", desc:"Define product/service, ICP, and pricing.", xp:200, requires:[] },
      { id:"bs_found_assets", group:"Foundation", title:"Sales Assets", desc:"Pitch deck + 1-page + case proof.", xp:220, requires:["bs_found_offer"] },
      { id:"bs_pipe_leads", group:"Pipeline", title:"Lead List", desc:"Build a list of 200 qualified leads.", xp:220, requires:["bs_found_assets"] },
      { id:"bs_pipe_outreach", group:"Pipeline", title:"Outreach System", desc:"Email/DM templates + follow-up cadence.", xp:240, requires:["bs_pipe_leads"] },
      { id:"bs_pipe_calls", group:"Pipeline", title:"Discovery Calls", desc:"Book and run 10 discovery calls.", xp:260, requires:["bs_pipe_outreach"] },
      { id:"bs_close_first", group:"Closing", title:"First Closed Deal", desc:"Close your first paid client/deal.", xp:420, requires:["bs_pipe_calls"] },
      { id:"bs_close_repeat", group:"Closing", title:"Repeatable Sales", desc:"Close 5 total deals with a process.", xp:520, requires:["bs_close_first"] },
    ]
  },
  {
    id: "fitness_coach",
    title: "Fitness / Coaching",
    desc: "Build credibility, clients, and repeatable delivery.",
    nodes: [
      { id:"ft_found_cert", group:"Foundation", title:"Education / Cert Path", desc:"Pick and start a credible cert program.", xp:220, requires:[] },
      { id:"ft_found_program", group:"Foundation", title:"Program Design", desc:"Write 3 programs (beginner/intermediate/advanced).", xp:260, requires:["ft_found_cert"] },
      { id:"ft_proj_clients", group:"Clients", title:"First 3 Clients", desc:"Coach 3 clients (free or paid) with tracking.", xp:420, requires:["ft_found_program"] },
      { id:"ft_proj_results", group:"Clients", title:"Document Results", desc:"Before/after + testimonials + metrics.", xp:280, requires:["ft_proj_clients"] },
      { id:"ft_pro_offer", group:"Professional", title:"Paid Offer", desc:"Launch a clear paid offer with onboarding.", xp:320, requires:["ft_proj_results"] },
      { id:"ft_pro_10", group:"Professional", title:"10 Paying Clients", desc:"Reach 10 active paying clients.", xp:620, requires:["ft_pro_offer"] },
    ]
  },
];

function normalizeCareerTree(tree){
  if (!tree || !Array.isArray(tree.nodes)) return { careerPresetId:"", title:"", nodes:[] };
  const nodes = tree.nodes.map(n => ({
    id: safeString(n.id, uid()),
    group: safeString(n.group, "Custom"),
    title: safeString(n.title, "Milestone"),
    desc: safeString(n.desc, ""),
    xp: safeNumber(n.xp, 0),
    requires: Array.isArray(n.requires) ? n.requires.map(x=>safeString(x,"")).filter(Boolean) : [],
    done: !!n.done
  }));
  return { careerPresetId: safeString(tree.careerPresetId,""), title: safeString(tree.title,""), nodes };
}

function getCareerTreeForDex(dex){
  if (!dex) return { careerPresetId:"", title:"", nodes:[] };
  if (!dex.careerTree) {
    dex.careerTree = { careerPresetId:"", title:"", nodes:[] };
  }
  return dex.careerTree;
}
function applyCareerPresetToDex(dex, careerPresetId){
  const p = CAREER_PRESETS.find(x => x.id === careerPresetId);
  if (!p) return;
  dex.careerTree = normalizeCareerTree({
    careerPresetId: p.id,
    title: p.title,
    nodes: p.nodes.map(n => ({ ...n, done:false }))
  });
}
function isNodeUnlocked(tree, nodeId){
  const n = tree.nodes.find(x => x.id === nodeId);
  if (!n) return false;
  if (!n.requires || n.requires.length === 0) return true;
  const doneSet = new Set(tree.nodes.filter(x=>x.done).map(x=>x.id));
  return n.requires.every(r => doneSet.has(r));
}
function careerProgress(tree){
  const total = tree.nodes.length;
  const done = tree.nodes.filter(n=>n.done).length;
  return { total, done, pct: total ? (done/total) : 0 };
}
function addMilestoneTimeline(dexId, title, xp){
  return { id: uid(), ts: Date.now(), dexId, entryType:"milestone", text:title, xp: safeNumber(xp,0), keywords:[], attachments:[] };
}


function achievementState(state){
  const out = [];
  for (const a of ACHIEVEMENTS){
    const cur = clamp(safeNumber(a.progress(state), 0), 0, 1e9);
    const tgt = Math.max(1, safeNumber(a.target, 1));
    const done = cur >= tgt;
    const pct = clamp(cur / tgt, 0, 1);
    out.push({ ...a, cur, tgt, done, pct });
  }
  return out;
}
function unlockedAchievementIds(s){
  const ids = new Set();
  for (const a of achievementState(s)) if (a.done) ids.add(a.id);
  return ids;
}
function computeStatsFromState(s){
  const dexes = s.dexes || [];
  const timeline = s.timeline || [];

  const totalXP = totalXPFromDexes(dexes);
  const dexCount = dexes.length;

  const journalCount = timeline.filter(t => t?.entryType === "journal").length;
  const captureCount = timeline.filter(t => t?.entryType === "capture").length;
  const milestoneCount = timeline.filter(t => t?.entryType === "milestone").length;
  const timelineCount = timeline.length;

  const daySet = daySetFromTimeline(timeline);
  const activeDays = daySet.size;

  // Per-dex aggregates from timeline
  const perDex = new Map();
  for (const d of dexes) {
    perDex.set(d.id, {
      id: d.id,
      name: d.name,
      type: d.type,
      xp: safeNumber(d.xp, 0),
      entries: 0,
      journal: 0,
      capture: 0,
      netXP: 0,
      lastTs: 0
    });
  }
  for (const t of timeline) {
    if (!t || !t.dexId || !perDex.has(t.dexId)) continue;
    const row = perDex.get(t.dexId);
    row.entries += 1;
    if (t.entryType === "journal") row.journal += 1;
    if (t.entryType === "capture") row.capture += 1;
    row.netXP += safeNumber(t.xp, 0);
    row.lastTs = Math.max(row.lastTs, safeNumber(t.ts, 0));
  }
  const perDexList = Array.from(perDex.values()).sort((a,b)=> (b.xp - a.xp) || (b.entries - a.entries));

  // Activity for last N days
  const N = 14;
  const todayKey = localDayKey(Date.now());
  const counts = [];
  for (let i = N-1; i >= 0; i--){
    const ts = Date.now() - i*24*60*60*1000;
    const key = localDayKey(ts);
    const c = timeline.filter(t => localDayKey(t.ts) === key).length;
    counts.push({ key, c });
  }

  return {
    totalXP, dexCount, timelineCount, journalCount, captureCount, milestoneCount, activeDays,
    perDex: perDexList,
    last14: counts,
    maxDayCount: Math.max(1, ...counts.map(x=>x.c))
  };
}

function defaultSeed() {
    return {
        version: SCHEMA_VERSION,
        dexes: [
            { id: safeUUID(), name: "LifeDoc", type: "Skill", xp: 95, log: [] },
            { id: safeUUID(), name: "BlueCollar Trades", type: "Career", xp: 20, log: [] },
            { id: safeUUID(), name: "Reliability", type: "Trait", xp: 40, log: [] },
            { id: safeUUID(), name: "Artistry", type: "Hobby", xp: 5, log: [] }
        ],
        timeline: []
    };
}
function repairState(raw) {
    const out = {
        version: safeNumber(raw === null || raw === void 0 ? void 0 : raw.version, SCHEMA_VERSION),
        dexes: Array.isArray(raw === null || raw === void 0 ? void 0 : raw.dexes) ? raw.dexes : [],
        timeline: Array.isArray(raw === null || raw === void 0 ? void 0 : raw.timeline) ? raw.timeline : []
    };
    const seen = new Set();
    out.dexes = out.dexes.map(d => {
        let id = safeString(d === null || d === void 0 ? void 0 : d.id, "");
        if (!id || seen.has(id))
            id = safeUUID();
        seen.add(id);
        const name = safeString(d === null || d === void 0 ? void 0 : d.name, "Untitled").trim() || "Untitled";
        const type = validDexType(d === null || d === void 0 ? void 0 : d.type) ? d.type : "Skill";
        const xp = Math.max(0, safeNumber(d === null || d === void 0 ? void 0 : d.xp, 0));
        const log = Array.isArray(d === null || d === void 0 ? void 0 : d.log) ? d.log : [];
        const fixedLog = log.map(e => ({
            text: safeString(e?.text, "").trim(),
            xp: safeNumber(e?.xp, 0),
            semanticXP: clamp(safeNumber(e?.semanticXP, 0), 0, 25),
            entryType: validEntryType((e?.entryType) || (e?.type) || "note"),
            attachments: sanitizeAttachments(e?.attachments),
            verification: { status: safeString(e?.verification?.status, "unverified") },
            ts: safeNumber(e?.ts, Date.now())
        })).filter(e => e.text.length || e.xp !== 0);
        const careerTree = (d && d.careerTree) ? normalizeCareerTree(d.careerTree) : undefined;
        return { id, name, type, xp, log: fixedLog, careerTree };
    });
    out.timeline = out.timeline.map(t => {
        var _a;
        return ({
            dexId: (_a = t?.dexId) ?? null,
            dex: safeString(t?.dex, ""),
            dexType: validDexType(t?.dexType) ? t.dexType : "Skill",
            entryType: validEntryType((t?.entryType) || (t?.kind) || "note"),
            xp: safeNumber(t?.xp, 0),
            semanticXP: clamp(safeNumber(t?.semanticXP, 0), 0, 25),
            attachments: sanitizeAttachments(t?.attachments),
            verification: { status: safeString(t?.verification?.status, "unverified") },
            text: safeString(t?.text, "").trim(),
            ts: safeNumber(t?.ts, Date.now())
        });
    }).filter(t => t.text.length || t.xp !== 0);
    out.timeline = out.timeline.slice(0, MAX_TIMELINE);
    assertSoft(out.dexes.every(d => d.id && d.name && validDexType(d.type)), "Dex repair triggered.");
    assertSoft(out.timeline.length <= MAX_TIMELINE, "Timeline capped.");
    return out;
}
function migrateState(loaded) {
    if (!loaded || typeof loaded !== "object")
        return null;
    if (loaded.version === undefined) {
        const repaired = repairState({ version: SCHEMA_VERSION, dexes: loaded.dexes, timeline: loaded.timeline });
        repaired.version = SCHEMA_VERSION;
        return repaired;
    }
    const v = safeNumber(loaded.version, SCHEMA_VERSION);
    const repaired = repairState(loaded);
    repaired.version = v;
    return repaired;
}
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        return migrateState(parsed);
    }
    catch (e) {
        if (DEV)
            console.warn("[LifeDex] Failed to load state:", e);
        return null;
    }
}
function saveState(payload) {
    if (SAVE_LOCK) return true;
    try {
        SAVE_LOCK = true;

        // stringify once (avoid multiple deep copies)
        let raw = JSON.stringify(payload);

        // If large, strip embedded dataUrls and retry
        if (raw.length > 3_500_000) {
            const safe = deepClone(payload);
            for (const d of (safe.dexes || [])) {
                for (const l of (d.log || [])) {
                    if (l.attachments) for (const a of l.attachments) a.dataUrl = "";
                }
            }
            for (const t of (safe.timeline || [])) {
                if (t.attachments) for (const a of t.attachments) a.dataUrl = "";
            }
            raw = JSON.stringify(safe);
            payload = safe;
        }

        localStorage.setItem(STORAGE_KEY, raw);
        return true;
    } catch (e) {
        // On quota issues, try stripping embedded dataUrls once
        try {
            const safe = deepClone(payload);
            for (const d of (safe.dexes || [])) {
                for (const l of (d.log || [])) {
                    if (l.attachments) for (const a of l.attachments) a.dataUrl = "";
                }
            }
            for (const t of (safe.timeline || [])) {
                if (t.attachments) for (const a of t.attachments) a.dataUrl = "";
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
            return true;
        } catch (e2) {
            if (DEV) console.warn("[LifeDex] Save failed:", e2);
            return false;
        }
    } finally {
        setTimeout(() => { SAVE_LOCK = false; }, 0);
    }
}

let _saveTimer = null;
let _pendingSave = null;
function scheduleSave(payload) {
    _pendingSave = payload;
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        const p = _pendingSave;
        _pendingSave = null;
        // save outside render/update; avoids UI freezes during rapid actions
        try { saveState(p); } catch (e) { }
    }, 350); // debounce writes
}
// --- Export / Import ---
function downloadJSON(filename, obj) {
    try {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }
    catch (e) {
        alert("Export failed.");
    }
}
function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ""));
        r.onerror = () => reject(new Error("File read failed"));
        r.readAsText(file);
    });
}
// --- Level math ---
function levelIndexFromXP(xp) {
    return clamp(Math.floor((xp || 0) / XP_STEP), 0, LEVELS.length - 1);
}
function levelFromXP(xp) { return LEVELS[levelIndexFromXP(xp)]; }
function progressPercent(xp) {
    const v = ((xp || 0) % XP_STEP + XP_STEP) % XP_STEP;
    return (v / XP_STEP) * 100;
}
function levelProgress(xp){
    const lvl = levelFromXP(xp);
    const i = LEVELS.findIndex(l=>l.name===lvl);
    if(i<0 || i>=LEVELS.length-1) return {pct:1};
    const cur = safeNumber(xp,0);
    const lo = LEVELS[i].min;
    const hi = LEVELS[i+1].min;
    return {pct: clamp((cur-lo)/(hi-lo),0,1)};
}

function xpToNextLevelInfo(xp) {
    const idx = levelIndexFromXP(xp);
    if (idx >= LEVELS.length - 1) {
        return { done: true, label: "Max level" };
    }
    const remRaw = XP_STEP - (((xp || 0) % XP_STEP + XP_STEP) % XP_STEP);
    const rem = remRaw === 0 ? XP_STEP : remRaw;
    const next = LEVELS[idx + 1];
    return { done: false, remaining: rem, next };
}
// --- Today XP ---
function startOfLocalDayTs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
function computeTodayXP(timeline) {
    const start = startOfLocalDayTs();
    const end = start + 86400000;
    let sum = 0;
    for (const t of timeline) {
        const ts = safeNumber(t === null || t === void 0 ? void 0 : t.ts, 0);
        if (ts >= start && ts < end) {
            sum += safeNumber(t === null || t === void 0 ? void 0 : t.xp, 0);
        }
    }
    return sum;
}

// --- Streak (recalculated; timeline-based, plus in-session activity today) ---
function localDayKey(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function computeStreakDaysFromDaySet(daySet){
  const todayKey = localDayKey(Date.now());
  if (!daySet.has(todayKey)) return 0;
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0,0,0,0);
  while(true){
    const key = localDayKey(cursor.getTime());
    if (!daySet.has(key)) break;
    streak += 1;
    cursor.setDate(cursor.getDate()-1);
  }
  return streak;
}
function daySetFromTimeline(timeline){
  const days = new Set();
  for (const t of timeline){
    const ts = safeNumber(t?.ts, 0);
    if (!ts) continue;
    const xp = safeNumber(t?.xp, 0);
    const text = safeString(t?.text, "").trim();
    if (xp === 0 && !text) continue;
    days.add(localDayKey(ts));
  }
  return days;
}
function totalXPFromDexes(dexes){
  let sum = 0;
  for (const d of dexes) sum += Math.max(0, safeNumber(d?.xp, 0));
  return sum;
}

// ---- FX component ----
function ToastLayer({ toasts }) {
  return React.createElement("div", { className: "toastWrap" }, (toasts||[]).map(t => React.createElement("div", { key: t.id, className: "toast" }, t.text)));
}

function XPFloat({ delta, color, nonce }) {
    return (React.createElement("div", { key: nonce, className: "xpFloat", style: { color } },
        delta > 0 ? `+${delta}` : `${delta}`,
        " XP"));
}
function App() {
    
  const [careerPresetId, setCareerPresetId] = React.useState("");
  const [careerCustomTitle, setCareerCustomTitle] = React.useState("");
  const [careerCustomDesc, setCareerCustomDesc] = React.useState("");
  const [careerCustomXP, setCareerCustomXP] = React.useState(150);

const [screen, setScreen] = React.useState("home"); // home|details|journal|timeline|dexForm|stats
    const [active, setActive] = React.useState(null);
    const [filter, setFilter] = React.useState("All");
    const [journal, setJournal] = React.useState("");
    // Dex form state
    const [formMode, setFormMode] = React.useState("create"); // create|edit
    const [formId, setFormId] = React.useState(null);
    const [formName, setFormName] = React.useState("");
    const [formType, setFormType] = React.useState("Skill");
    // Import control
    const importRef = React.useRef(null);
    // ---- Phase 1 FX state (NOT persisted) ----
    const [xpFx, setXpFx] = React.useState({ dexId: null, delta: 0, color: "#fff", nonce: 0 });
    const [lvlFx, setLvlFx] = React.useState({ dexId: null, nonce: 0 });
    const [bumpFx, setBumpFx] = React.useState({ dexId: null, nonce: 0 });
    const [pulseFx, setPulseFx] = React.useState({ capture: 0, journal: 0 });
    // ---- Phase 2: recent highlight (NOT persisted) ----
    const [recentMap, setRecentMap] = React.useState({}); // dexId -> true
    const recentTimers = React.useRef({}); // dexId -> timeoutId

    // ---- Phase 3: toasts + in-session activity (NOT persisted) ----
    const [toasts, setToasts] = React.useState([]);
    const [sessionTodayXP, setSessionTodayXP] = React.useState(0);
    const sessionDayRef = React.useRef(localDayKey(Date.now()));
    const prevTotalRef = React.useRef(null);
    const prevLevelsRef = React.useRef({}); // dexId -> levelIndex
    const lastToastRef = React.useRef({}); // simple de-dupe


    React.useEffect(() => {
        return () => {
            const timers = recentTimers.current;
            for (const k in timers) {
                try { clearTimeout(timers[k]); } catch (e) {}
            }
        };
    }, []);

    function isRecent(dexId) {
        return !!recentMap[dexId];
    }

    function markRecent(dexId) {
        const timers = recentTimers.current;
        if (timers[dexId]) {
            try { clearTimeout(timers[dexId]); } catch (e) {}
        }
        // Mark immediately (UI highlight)
        setRecentMap(prev => ({ ...prev, [dexId]: true }));
        // Auto-clear after 10s without any polling/re-render loops
        timers[dexId] = setTimeout(() => {
            setRecentMap(prev => {
                if (!prev[dexId]) return prev;
                const next = { ...prev };
                delete next[dexId];
                return next;
            });
            delete timers[dexId];
        }, 10000);
    }

    function clearRecent(dexId) {
        const timers = recentTimers.current;
        if (timers[dexId]) {
            try { clearTimeout(timers[dexId]); } catch (e) {}
            delete timers[dexId];
        }
        setRecentMap(prev => {
            if (!prev[dexId]) return prev;
            const next = { ...prev };
            delete next[dexId];
            return next;
        });
    }
function triggerXpFx(dexId, delta, dexType) {
        if (!delta)
            return;
        setXpFx({ dexId, delta, color: dexTypeColor(dexType), nonce: Date.now() + Math.random() });
        setBumpFx({ dexId, nonce: Date.now() + Math.random() });
        markRecent(dexId);
        if (delta > 0)
            Sound.play("xpUp");
        else
            Sound.play("xpDown");
    }
    function triggerLevelUpFx(dexId) {
        setLvlFx({ dexId, nonce: Date.now() + Math.random() });
        Sound.play("levelUp");
    }
    function pushToast(msg){
        const now = Date.now();
        // De-dupe identical messages within 2s
        const key = msg;
        const last = lastToastRef.current[key] || 0;
        if (now - last < 2000) return;
        lastToastRef.current[key] = now;
        const id = now + Math.random();
        setToasts(prev => [...prev, { id, text: msg }].slice(-3));
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 1800);
    }
    function triggerPulse(which) {
        const n = Date.now();
        if (which === "capture")
            setPulseFx(p => ({ ...p, capture: n }));
        if (which === "journal")
            setPulseFx(p => ({ ...p, journal: n }));
        Sound.play("save");
    }
    // ---- Attachment prep (in-memory until saved) ----
    const [captureAttach, setCaptureAttach] = React.useState(null);
    const [journalAttach, setJournalAttach] = React.useState(null);
    const [attachNonce, setAttachNonce] = React.useState(0);

    function fileToDataUrl(file){
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ""));
            r.onerror = () => reject(new Error("File read failed"));
            r.readAsDataURL(file);
        });
    }

    async function prepareAttachment(file, setFn){
        if (!file) { setFn(null); return; }
        const name = safeString(file.name,"").slice(0,120) || "Attachment";
        const type = safeString(file.type,"");
        const size = safeNumber(file.size,0);
        if (size && size > MAX_EMBED_BYTES){
            // Too large: store metadata only (still useful for recall / later verification)
            setFn({ name, type, size, dataUrl:"" });
            pushToast("Attachment saved as metadata (file too large to embed).");
            return;
        }
        try{
            const dataUrl = await fileToDataUrl(file);
            setFn({ name, type, size, dataUrl });
            pushToast("Attachment ready.");
        }catch(e){
            setFn(null);
            pushToast("Attachment failed to load.");
        }
    }

    const [state, setState] = React.useState(() => {
        const loaded = loadState();
        if (loaded) {
            return { dexes: loaded.dexes, timeline: loaded.timeline, history: [], version: loaded.version };
        }
        const seeded = defaultSeed();
        return { dexes: seeded.dexes, timeline: seeded.timeline, history: [], version: seeded.version };
    });
    React.useEffect(() => {
        if (!SAVE_LOCK) {
            scheduleSave({ version: state.version || SCHEMA_VERSION, dexes: state.dexes, timeline: state.timeline });
        }
    }, [state.dexes, state.timeline, state.version]);

    const achievementToastRef = React.useRef({ ready:false, ids:new Set() });

    React.useEffect(() => {
        const now = unlockedAchievementIds(state);
        const ref = achievementToastRef.current;

        if (!ref.ready) {
            ref.ids = new Set(now);
            ref.ready = true;
            return;
        }

        // Toast newly unlocked achievements (quiet, 1 per tick)
        for (const a of ACHIEVEMENTS) {
            if (now.has(a.id) && !ref.ids.has(a.id)) {
                pushToast("🏆 Achievement unlocked: " + a.title);
                break;
            }
        }
        ref.ids = new Set(now);
    }, [state.dexes, state.timeline]);

    // ---- Phase 3 observers (do NOT modify core XP/timeline logic) ----
    React.useEffect(() => {
        // Reset session today bucket on day change
        const dayKey = localDayKey(Date.now());
        if (sessionDayRef.current !== dayKey) {
            sessionDayRef.current = dayKey;
            setSessionTodayXP(0);
        }

        // Detect total XP deltas (captures quick +10/-5 that don't write timeline)
        const total = totalXPFromDexes(state.dexes);
        if (prevTotalRef.current === null) {
            prevTotalRef.current = total;
        } else {
            const delta = total - prevTotalRef.current;
            if (delta !== 0) {
                setSessionTodayXP(v => v + delta);
                // Milestone toasts
                const milestones = [100, 250, 500, 1000, 2000, 5000, 10000];
                for (const ms of milestones) {
                    if (prevTotalRef.current < ms && total >= ms) pushToast(`Milestone: ${ms} total XP`);
                }
                prevTotalRef.current = total;
            }
        }

        // Level-up toasts (compare level indexes per dex)
        const prevLv = prevLevelsRef.current || {};
        const nextLv = {};
        for (const d of state.dexes) {
            const idx = levelIndexFromXP(d.xp);
            nextLv[d.id] = idx;
            const before = prevLv[d.id];
            if (before !== undefined && idx > before) {
                pushToast(`Level up: ${d.name} → ${LEVELS[idx]}`);
            }
        }
        prevLevelsRef.current = nextLv;

        // Streak milestone toasts (timeline days + session activity today)
        const days = daySetFromTimeline(state.timeline);
        if (sessionTodayXP !== 0) days.add(localDayKey(Date.now()));
        const streak = computeStreakDaysFromDaySet(days);
        const prevStreak = safeNumber(lastToastRef.current.__streakSeen, 0);
        if (streak !== prevStreak) lastToastRef.current.__streakSeen = streak;
        const streakMilestones = [3, 7, 14, 30, 60, 100];
        for (const sm of streakMilestones) {
            if (prevStreak < sm && streak >= sm) pushToast(`Streak: ${sm} days`);
        }
    }, [state.dexes, state.timeline]);

    React.useEffect(() => {
        if (screen === "details" || screen === "journal") {
            const exists = state.dexes.some(d => d.id === active);
            if (!exists) {
                setScreen("home");
                setActive(null);
            }
        }
    }, [screen, active, state.dexes]);
    function stripHeavy(snap){
  const clean = deepClone(snap);

  for (const d of clean.dexes) {
    for (const l of (d.log || [])) {
      if (l.attachments) {
        for (const a of l.attachments) a.dataUrl = "";
      }
    }
  }

  for (const t of (clean.timeline || [])) {
    if (t.attachments) {
      for (const a of t.attachments) a.dataUrl = "";
    }
  }

  return clean;
}

function pushHistory(prev) {
    if (DESTRUCTIVE_MODE) return prev.history;

    const snap = {
        version: prev.version || SCHEMA_VERSION,
        // Only store dex identity + xp for crash-proof undo
        dexes: (prev.dexes || []).map(d => ({
            id: d.id,
            xp: safeNumber(d.xp, 0)
        }))
    };

    const next = [...(prev.history || []), snap];
    const MAX = 25;
    return next.length > MAX ? next.slice(next.length - MAX) : next;
}
function commit(mutator) {
        setState(prev => {
            const draft = deepClone({
                version: prev.version || SCHEMA_VERSION,
                dexes: prev.dexes,
                timeline: prev.timeline
            });
            mutator(draft);
            const repaired = repairState(draft);
            return {
                version: repaired.version || prev.version || SCHEMA_VERSION,
                dexes: repaired.dexes,
                timeline: repaired.timeline,
                history: pushHistory(prev)
            };
        });
    }
    function undo() {
        setState(s => {
            if (!s.history || !s.history.length) return s;
            const last = s.history[s.history.length - 1];
            const dexMap = new Map((last.dexes || []).map(d => [d.id, d.xp]));

            const dexes = (s.dexes || []).map(d => {
                if (!d) return d;
                if (!dexMap.has(d.id)) return d;
                return { ...d, xp: safeNumber(dexMap.get(d.id), 0) };
            });

            Sound.play("undo");
            return {
                ...s,
                dexes,
                history: s.history.slice(0, -1)
            };
        });
    }
// ---- Core actions ----
    function addXP(dexId, amt, text = "", entryType = "xp", meta = {}) {
        const dNow = state.dexes.find(x => x.id === dexId);
        if (dNow) {
            const before = safeNumber(dNow.xp, 0);
            const semanticBonus = analyzeTextXP(text);
            const finalAmt = safeNumber(amt, 0) + (text && safeString(text).trim().length ? semanticBonus : 0);
            const after = Math.max(0, before + safeNumber(finalAmt, 0));
            const delta = after - before;
            triggerXpFx(dexId, delta, dNow.type);
            const beforeLvl = levelIndexFromXP(before);
            const afterLvl = levelIndexFromXP(after);
            if (afterLvl > beforeLvl)
                triggerLevelUpFx(dexId);
        }
        commit(draft => {
            const d = draft.dexes.find(x => x.id === dexId);
            if (!d)
                return;
            const before = safeNumber(d.xp, 0);
            const semanticBonus = analyzeTextXP(text);
            const finalAmt = safeNumber(amt, 0) + (text && safeString(text).trim().length ? semanticBonus : 0);
            const after = Math.max(0, before + safeNumber(finalAmt, 0));
            const delta = after - before;
            d.xp = after;
            if (text && safeString(text).trim().length) {
                const entry = {
                    text: safeString(text).trim(),
                    xp: delta,
                    semanticXP: (text && safeString(text).trim().length) ? clamp(analyzeTextXP(text), 0, 25) : 0,
                    entryType: validEntryType(entryType),
                    attachments: sanitizeAttachments(meta?.attachments),
                    verification: { status: safeString(meta?.verification?.status, "unverified") },
                    ts: Date.now()
                };
                d.log = Array.isArray(d.log) ? d.log : [];
                d.log.push(entry);
                draft.timeline.unshift({
                    dexId: d.id,
                    dex: d.name,
                    dexType: d.type,
                    entryType: entry.entryType,
                    xp: entry.xp,
                    semanticXP: entry.semanticXP,
                    attachments: entry.attachments,
                    verification: entry.verification,
                    text: entry.text,
                    ts: entry.ts
                });
            }
        });
    }
function resetDex(dexId) {
  DESTRUCTIVE_MODE = true;
  SAVE_LOCK = true;

  setState(prev => {
    // Clone ONLY core payload; history can be huge and must not be cloned.
    const draft = deepClone({
      version: prev.version || SCHEMA_VERSION,
      dexes: prev.dexes,
      timeline: prev.timeline
    });

    const d = draft.dexes.find(x => x.id === dexId);
    if (!d) return prev;

    d.xp = 0;
    d.log = [];

    const repaired = repairState(draft);

    // Persist once
    saveState({
      version: repaired.version,
      dexes: repaired.dexes,
      timeline: repaired.timeline
    });

    return {
      version: repaired.version,
      dexes: repaired.dexes,
      timeline: repaired.timeline,
      history: pushHistory(prev)
    };
  });

  markRecent(dexId);
  Sound.play("reset");
  setTimeout(() => { DESTRUCTIVE_MODE = false; SAVE_LOCK = false; }, 0);
}
function deleteDex(dexId) {
  DESTRUCTIVE_MODE = true;
  SAVE_LOCK = true;

  setState(prev => {
    const draft = deepClone({
      version: prev.version || SCHEMA_VERSION,
      dexes: prev.dexes,
      timeline: prev.timeline
    });

    draft.dexes = draft.dexes.filter(d => d.id !== dexId);

    const repaired = repairState(draft);

    saveState({
      version: repaired.version,
      dexes: repaired.dexes,
      timeline: repaired.timeline
    });

    return {
      version: repaired.version,
      dexes: repaired.dexes,
      timeline: repaired.timeline,
      history: pushHistory(prev)
    };
  });

  clearRecent(dexId);
  setActive(null);
  setScreen("home");
  Sound.play("delete");
  setTimeout(() => { DESTRUCTIVE_MODE = false; SAVE_LOCK = false; }, 0);
}
    function resetAll() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        }
        catch (e) { }
        const seeded = defaultSeed();
        setState({ dexes: seeded.dexes, timeline: seeded.timeline, history: [], version: seeded.version });
        setActive(null);
        setScreen("home");
        Sound.play("resetAll");
    }
    // ----- Create/Edit Dex -----
    function openCreateDex() {
        setFormMode("create");
        setFormId(null);
        setFormName("");
        setFormType("Skill");
        setScreen("dexForm");
        Sound.play("open");
    }
    function openEditDex(d) {
        setFormMode("edit");
        setFormId(d.id);
        setFormName(d.name);
        setFormType(d.type);
        setScreen("dexForm");
        Sound.play("open");
    }
    function saveDex() {
        const name = safeString(formName).trim();
        const type = validDexType(formType) ? formType : "Skill";
        if (!name)
            return;
        commit(draft => {
            if (formMode === "create") {
                draft.dexes.push({ id: safeUUID(), name, type, xp: 0, log: [] });
            }
            else {
                const d = draft.dexes.find(x => x.id === formId);
                if (d) {
                    d.name = name;
                    d.type = type;
                }
            }
        });
        setScreen("home");
        Sound.play("saveDex");
    }
    // ----- Export/Import actions -----
    function exportSave() {
        const payload = repairState({ version: state.version || SCHEMA_VERSION, dexes: state.dexes, timeline: state.timeline });
        payload.version = SCHEMA_VERSION;
        downloadJSON("lifedex-save.json", payload);
        Sound.play("export");
    }
    async function importSaveFromFile(file) {
        try {
            const txt = await readFileAsText(file);
            const parsed = JSON.parse(txt);
            const migrated = migrateState(parsed);
            if (!migrated)
                throw new Error("Invalid save file");
            const repaired = repairState({ version: SCHEMA_VERSION, dexes: migrated.dexes, timeline: migrated.timeline });
            repaired.version = SCHEMA_VERSION;
            setState({ dexes: repaired.dexes, timeline: repaired.timeline, history: [], version: repaired.version });
            setActive(null);
            setScreen("home");
            saveState(repaired);
            alert("Import successful.");
            Sound.play("import");
        }
        catch (e) {
            alert("Import failed. Make sure it's a valid lifedex-save.json file.");
        }
    }
    // ------------------- SCREENS -------------------
    if (screen === "dexForm") {
        return (React.createElement(React.Fragment, null,
            React.createElement(ToastLayer, { toasts: toasts }),
            React.createElement("button", { className: "back", onClick: () => setScreen("home") }, "Back"),
            React.createElement("div", { className: "card" },
                React.createElement("h2", null, formMode === "create" ? "Create Dex" : "Edit Dex"),
                React.createElement("div", { className: "muted" }, "XP is preserved when editing."),
                React.createElement("input", { value: formName, onChange: e => setFormName(e.target.value), placeholder: "Dex name (e.g., Gym, Coding, Cooking)" }),
                React.createElement("select", { value: formType, onChange: e => setFormType(e.target.value) },
                    React.createElement("option", null, "Skill"),
                    React.createElement("option", null, "Career"),
                    React.createElement("option", null, "Trait"),
                    React.createElement("option", null, "Hobby")),
                React.createElement("div", { className: "row", style: { marginTop: 10 } },
                    React.createElement("button", { className: "btn", onClick: saveDex }, "Save"),
                    React.createElement("button", { className: "btn2", onClick: () => setScreen("home") }, "Cancel")),
                React.createElement("div", { className: "smallNote" }, "Tip: Choose the type so Timeline filters work properly."))));
    }
    if (screen === "details") {
        const d = state.dexes.find(x => x.id === active);
        if (!d)
            return null;
        const lvl = levelFromXP(d.xp);
        const pct = progressPercent(d.xp);
        const showXp = xpFx.dexId === d.id;
        const showLvl = lvlFx.dexId === d.id;
        const fillClass = (bumpFx.dexId === d.id) ? "fill bump" : "fill";
        const nextInfo = xpToNextLevelInfo(d.xp);
        return (React.createElement(React.Fragment, null,
            React.createElement("button", { className: "back", onClick: () => setScreen("home") }, "Back"),
            React.createElement("div", { className: "card" },
                React.createElement("div", { className: `banner ${d.type.toLowerCase()} ${showLvl ? "levelUpGlow" : ""}` },
                    React.createElement("h1", null, d.name),
                    React.createElement("div", { className: "muted" },
                        d.type,
                        " \u2022 ",
                        lvl,
                        " \u2022 ",
                        d.xp,
                        " XP"),
                    React.createElement("div", { className: "smallNote" }, nextInfo.done ? "Max level reached" : `${nextInfo.remaining} XP to ${nextInfo.next}`),
                    React.createElement("div", { className: "bar" },
                        React.createElement("div", { className: fillClass, style: { width: pct + "%" } })),
                    showXp && React.createElement(XPFloat, { delta: xpFx.delta, color: xpFx.color, nonce: xpFx.nonce })),
                React.createElement("div", { className: "row" },
                    React.createElement("button", { className: "btn", onClick: () => addXP(d.id, 10) }, "+10 XP"),
                    React.createElement("button", { className: "btn2", onClick: () => addXP(d.id, -5) }, "-5 XP"),
                    React.createElement("button", { className: "btn2", onClick: undo }, "Undo"),
                    React.createElement("button", { className: "btn2", onClick: () => { setFilter("All"); setScreen("timeline"); } }, "Timeline")),
                ((d.type === "Career") ? React.createElement("button", { className: "btn2", onClick: () => setScreen("careerTree") }, "Career Tree") : null),
                ((d.type === "Career") ? React.createElement("button", { className: "btn2", onClick: () => setScreen("milestones") }, "Milestones") : null),
                React.createElement("div", { className: "smallNote" }, "Capture and Journal entries add XP and appear in Timeline.")),
            React.createElement("div", { className: `card ${pulseFx.capture ? "savePulse" : ""}`, key: pulseFx.capture ? ("cap_" + pulseFx.capture) : "cap" },
                React.createElement("b", null, "Capture moment"),
                React.createElement("textarea", { placeholder: "Type and press Enter to save...", onKeyDown: (e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const val = e.currentTarget.value;
                            if (val.trim()) {
                                addXP(d.id, 5, val, "capture", { attachments: captureAttach ? [captureAttach] : [] });
                                e.currentTarget.value = "";
                                setCaptureAttach(null);
                                triggerPulse("capture");
                            }
                        }
                    } }),
                
                React.createElement("div", { className: "attachRow" },
                    React.createElement("input", { key: "cap_in_" + attachNonce, type: "file", accept: "image/*,application/pdf,.pdf,.doc,.docx,.txt", onChange: async (e) => {
                            const file = e.target.files && e.target.files[0];
                            e.target.value = "";
                            await prepareAttachment(file, setCaptureAttach);
                            setAttachNonce(n => n + 1);
                        } }),
                    captureAttach && React.createElement("div", { className: "attachBadge" },
                        isImageMime(captureAttach.type) && captureAttach.dataUrl ? React.createElement("img", { className: "attachThumb", src: captureAttach.dataUrl, alt: "attachment" }) : null,
                        React.createElement("span", null, captureAttach.name),
                        React.createElement("span", { className: "muted" }, captureAttach.dataUrl ? "" : "(metadata)")
                    )
                ),
                React.createElement("div", { className: "smallNote" }, "Enter saves. Shift+Enter makes a new line.")),
            React.createElement("div", { className: "card row" },
                React.createElement("button", { className: "btn2", onClick: () => openEditDex(d) }, "Edit Dex"),
                React.createElement("button", { className: "btnDanger", onClick: () => resetDex(d.id) }, "Reset"),
                React.createElement("button", { className: "btnDanger", onClick: () => deleteDex(d.id) }, "Delete")),
            React.createElement("div", { className: "card" },
                React.createElement("b", null, "Entries"),
                (d.log || []).length === 0 && React.createElement("div", { className: "smallNote" }, "No entries yet."),
                (d.log || []).slice().reverse().map((l, i) => (React.createElement("div", { key: i, className: "logItem" },
                    React.createElement("b", null, l.entryType),
                    " ",
                    l.xp >= 0 ? `+${l.xp}` : l.xp,
                    " XP",
                    l.semanticXP > 0 && React.createElement("div", { className: "smallNote" }, `+${l.semanticXP} semantic XP`),
                    (l.attachments && l.attachments.length > 0) && React.createElement("div", { className: "attachRow" },
                        l.attachments.map((a, ai) => React.createElement("a", { key: ai, className: "attachBadge", href: a.dataUrl || undefined, target: a.dataUrl ? "_blank" : undefined, rel: a.dataUrl ? "noreferrer" : undefined, title: a.dataUrl ? "Open attachment" : "Metadata only" },
                            (isImageMime(a.type) && a.dataUrl) ? React.createElement("img", { className: "attachThumb", src: a.dataUrl, alt: a.name }) : null,
                            React.createElement("span", null, a.name),
                            React.createElement("span", { className: "muted" }, a.dataUrl ? "" : "(metadata)")
                        ))
                    ),
                    React.createElement("div", null, l.text)))))));
    }
    if (screen === "journal") {
        const d = state.dexes.find(x => x.id === active);
        if (!d)
            return null;
        return (React.createElement(React.Fragment, null,
            React.createElement("button", { className: "back", onClick: () => setScreen("home") }, "Back"),
            React.createElement("div", { className: "card" },
                React.createElement("div", { className: `banner ${d.type.toLowerCase()}` },
                    React.createElement("h2", null, d.name),
                    React.createElement("div", { className: "muted" },
                        "Journal \u2022 ",
                        d.type)),
                React.createElement("textarea", { value: journal, onChange: e => setJournal(e.target.value), placeholder: "Write your journal entry..." }),

                React.createElement("div", { className: "attachRow" },
                    React.createElement("input", { key: "jr_in_" + attachNonce, type: "file", accept: "image/*,application/pdf,.pdf,.doc,.docx,.txt", onChange: async (e) => {
                            const file = e.target.files && e.target.files[0];
                            e.target.value = "";
                            await prepareAttachment(file, setJournalAttach);
                            setAttachNonce(n => n + 1);
                        } }),
                    journalAttach && React.createElement("div", { className: "attachBadge" },
                        isImageMime(journalAttach.type) && journalAttach.dataUrl ? React.createElement("img", { className: "attachThumb", src: journalAttach.dataUrl, alt: "attachment" }) : null,
                        React.createElement("span", null, journalAttach.name),
                        React.createElement("span", { className: "muted" }, journalAttach.dataUrl ? "" : "(metadata)")
                    )
                ),

                React.createElement("div", { className: "row", style: { marginTop: 10 } },
                    React.createElement("button", { className: "btn", onClick: () => {
                            if (!journal.trim())
                                return;
                            addXP(d.id, 5, journal, "journal", { attachments: journalAttach ? [journalAttach] : [] });
                            setJournal("");
                            setJournalAttach(null);
                            setFilter("All");
                            setScreen("timeline");
                            triggerPulse("journal");
                        } }, "Save Journal (+5 XP)"),
                    React.createElement("button", { className: "btn2", onClick: undo }, "Undo")),
                React.createElement("div", { className: "smallNote" }, "Journal saves to Timeline under the correct Dex type.")),
            React.createElement("div", { className: `card ${pulseFx.journal ? "savePulse" : ""}`, key: pulseFx.journal ? ("jr_" + pulseFx.journal) : "jr" },
                React.createElement("b", null, "Saved feedback"),
                React.createElement("div", { className: "smallNote" }, "When you save a journal entry, this card pulses to confirm it worked."))));
    }
    if (screen === "timeline") {
        const items = state.timeline.filter(t => filter === "All" || t.dexType === filter);
        return (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "pillRow" }, ["All", "Skill", "Career", "Trait", "Hobby"].map(t => (React.createElement("div", { key: t, className: `pill ${filter === t ? "active" : ""}`, onClick: () => setFilter(t) }, t)))),
            React.createElement("button", { className: "back", onClick: () => setScreen("home") }, "Back"),
            React.createElement("div", { className: "card" },
                React.createElement("div", { className: "row", style: { justifyContent: "space-between" } },
                    React.createElement("b", null, "Timeline"),
                    React.createElement("button", { className: "btn2", onClick: undo }, "Undo")),
                React.createElement("div", { className: "smallNote" }, "Filter is by Dex type (Skill/Career/Trait/Hobby).")),
            items.length === 0 && (React.createElement("div", { className: "card" },
                React.createElement("b", null, "No entries yet."),
                React.createElement("div", { className: "smallNote" }, "Add a Capture or Journal entry to populate Timeline."))),
            items.map((t, i) => (React.createElement("div", { key: i, className: `card ${String(t.dexType || "Skill").toLowerCase()}` },
                React.createElement("b", null, t.dex),
                " \u2022 ",
                t.dexType,
                " \u2022 ",
                t.entryType,
                " \u2022 ",
                t.xp >= 0 ? `+${t.xp}` : t.xp,
                " XP",
                t.semanticXP > 0 && React.createElement("div", { className: "smallNote" }, `+${t.semanticXP} semantic XP`),
                (t.attachments && t.attachments.length > 0) && React.createElement("div", { className: "attachRow" },
                    t.attachments.map((a, ai) => React.createElement("a", { key: ai, className: "attachBadge", href: a.dataUrl || undefined, target: a.dataUrl ? "_blank" : undefined, rel: a.dataUrl ? "noreferrer" : undefined, title: a.dataUrl ? "Open attachment" : "Metadata only" },
                        (isImageMime(a.type) && a.dataUrl) ? React.createElement("img", { className: "attachThumb", src: a.dataUrl, alt: a.name }) : null,
                        React.createElement("span", null, a.name),
                        React.createElement("span", { className: "muted" }, a.dataUrl ? "" : "(metadata)")
                    ))
                ),
                React.createElement("div", { style: { marginTop: 6 } }, t.text))))));
    }

    if (screen === "stats") {
        const stats = computeStatsFromState(state);
        const aState = achievementState(state);
        const unlocked = new Set(aState.filter(x => x.done).map(x => x.id));
        const totalA = aState.length;
        const unlockedCount = unlocked.size;

        const days = daySetFromTimeline(state.timeline);
        if (sessionTodayXP !== 0) days.add(localDayKey(Date.now()));
        const streak = computeStreakDaysFromDaySet(days);

        const topDexes = stats.perDex.slice(0, 6);

        const fmtDay = (key) => {
            // key is YYYY-MM-DD
            const parts = safeString(key, "").split("-");
            if (parts.length !== 3) return key;
            return parts[1] + "/" + parts[2];
        };

        return (React.createElement(React.Fragment, null,
            React.createElement("button", { className: "back", onClick: () => setScreen("home") }, "Back"),

            React.createElement("div", { className: "card" },
                React.createElement("h2", null, "Stats"),
                React.createElement("div", { className: "muted" }, "Overview across all Dexes."),
                React.createElement("div", { className: "statsGrid" },
                    React.createElement("div", { className: "logItem" }, "Total XP: ", React.createElement("b", null, stats.totalXP)),
                    React.createElement("div", { className: "logItem" }, "Dexes: ", React.createElement("b", null, stats.dexCount)),
                    React.createElement("div", { className: "logItem" }, "Timeline items: ", React.createElement("b", null, stats.timelineCount)),
                    React.createElement("div", { className: "logItem" }, "Journal entries: ", React.createElement("b", null, stats.journalCount)),
                    React.createElement("div", { className: "logItem" }, "Captures: ", React.createElement("b", null, stats.captureCount)),
                    React.createElement("div", { className: "logItem" }, "Milestones: ", React.createElement("b", null, stats.milestoneCount)),
                    React.createElement("div", { className: "logItem" }, "Active days: ", React.createElement("b", null, stats.activeDays)),
                    React.createElement("div", { className: "logItem" }, "Streak: ", React.createElement("b", null, streak), " day", streak === 1 ? "" : "s"),
                    React.createElement("div", { className: "logItem" }, "Achievements: ", React.createElement("b", null, unlockedCount), "/", totalA)
                )
            ),

            React.createElement("div", { className: "card" },
                React.createElement("b", null, "Top Dexes"),
                topDexes.length === 0 ? React.createElement("div", { className: "smallNote" }, "Create a Dex to see breakdowns.") :
                topDexes.map(d => {
                    const lvl = levelFromXP(d.xp);
                    const { pct } = levelProgress(d.xp);
                    return React.createElement("div", { key: d.id, className: "logItem" },
                        React.createElement("div", { className: "smallRow" },
                            React.createElement("div", null,
                                React.createElement("b", null, d.name),
                                React.createElement("div", { className: "smallNote" }, d.type, " • ", lvl, " • ", d.entries, " entries")
                            ),
                            React.createElement("div", { className: "pill" }, d.xp, " XP")
                        ),
                        React.createElement("div", { className: "progressWrap" },
                            React.createElement("div", { className: "progressBar", style: { width: `${Math.round(pct * 100)}%` } })
                        )
                    );
                })
            ),

            React.createElement("div", { className: "card" },
                React.createElement("b", null, "Activity (last 14 days)"),
                React.createElement("div", { className: "smallNote" }, "Counts of timeline items per day."),
                React.createElement("div", { className: "barList" },
                    stats.last14.map((x, i) => React.createElement("div", { key: i, className: "barRow" },
                        React.createElement("div", { className: "barLabel" }, fmtDay(x.key)),
                        React.createElement("div", { className: "barTrack" },
                            React.createElement("div", { className: "barFill", style: { width: `${Math.round((x.c / stats.maxDayCount) * 100)}%` } })
                        ),
                        React.createElement("div", { className: "muted", style: { minWidth: 18, textAlign: "right" } }, x.c)
                    ))
                )
            ),

            React.createElement("div", { className: "card" },
                React.createElement("b", null, "Achievements"),
                React.createElement("div", { className: "smallNote" }, "Progress is automatic. Unlocks are permanent."),
                aState.map(a => {
                    const pct = Math.round(a.pct * 100);
                    return React.createElement("div", { key: a.id, className: "logItem", style: { opacity: a.done ? 1 : 0.7 } },
                        React.createElement("div", { className: "smallRow" },
                            React.createElement("b", null, a.done ? "🏆 " : "🔒 ", a.title),
                            React.createElement("div", { className: "pill" }, a.cur, "/", a.tgt)
                        ),
                        React.createElement("div", { className: "smallNote" }, a.group, " • ", a.desc),
                        React.createElement("div", { className: "progressWrap" },
                            React.createElement("div", { className: "progressBar", style: { width: `${pct}%` } })
                        )
                    );
                })
            ),

            React.createElement("div", { className: "card" },
                React.createElement("b", null, "Semantic XP"),
                React.createElement("div", { className: "smallNote" }, "Journal/Capture text is scanned for keywords and can award bonus XP (capped). Edit KEYWORD_XP to tune it.")
            )
        ));
    }
    // CAREER TREE
    if (screen === "careerTree") {
        const dexId = active;
        const dex = state.dexes.find(d => d.id === dexId);
        if (!dex) {
            return React.createElement(React.Fragment, null,
                React.createElement("button", { className: "back", onClick: () => setScreen("home") }, "Back"),
                React.createElement("div", { className: "card" },
                    React.createElement("b", null, "No active Dex"),
                    React.createElement("div", { className: "smallNote" }, "Select a Career Dex first.")
                )
            );
        }

        const tree = getCareerTreeForDex(dex);
        const prog = careerProgress(tree);

        

        // group nodes
        const groups = {};
        for (const n of (tree.nodes || [])) {
            const g = n.group || "Custom";
            if (!groups[g]) groups[g] = [];
            groups[g].push(n);
        }
        const groupNames = Object.keys(groups);

        const completeNode = (nodeId) => {
            const tNow = getCareerTreeForDex(dex);
            const nodeNow = tNow.nodes.find(x => x.id === nodeId);
            if (!nodeNow) return;
            if (nodeNow.done) return;
            if (!isNodeUnlocked(tNow, nodeId)) { pushToast("This milestone is locked. Complete prerequisites first."); return; }
            const reward = safeNumber(nodeNow.xp, 0);

            commit(draft => {
                const dd = draft.dexes.find(x => x.id === dexId);
                if (!dd) return;
                const t = getCareerTreeForDex(dd);
                const nn = t.nodes.find(x => x.id === nodeId);
                if (!nn) return;
                nn.done = true;
                dd.careerTree = t;
                dd.xp = safeNumber(dd.xp, 0) + reward;
                draft.timeline = [addMilestoneTimeline(dexId, "Milestone: " + nn.title, reward), ...draft.timeline];
            });

            pushToast("✅ Completed: " + nodeNow.title + (reward ? ` (+${reward} XP)` : ""));
        };

        return React.createElement(React.Fragment, null,
            React.createElement("button", { className: "back", onClick: () => setScreen("details") }, "Back"),

            React.createElement("div", { className: "card" },
                React.createElement("h2", null, "Career Tree"),
                React.createElement("div", { className: "muted" }, dex.name, " • ", (tree.title || "No preset")),
                React.createElement("div", { className: "smallRow", style: { marginTop: 10 } },
                    React.createElement("div", { className: "pill" }, prog.done, "/", prog.total, " completed"),
                    React.createElement("div", { className: "pill" }, Math.round(prog.pct * 100), "%")
                ),
                React.createElement("div", { className: "progressWrap" },
                    React.createElement("div", { className: "progressBar", style: { width: `${Math.round(prog.pct * 100)}%` } })
                )
            ),

            (tree.nodes.length === 0) && React.createElement("div", { className: "card" },
                React.createElement("b", null, "Choose a preset"),
                React.createElement("div", { className: "smallNote" }, "Pick a roadmap preset for this Career Dex."),
                React.createElement("select", {
                    className: "input",
                    value: careerPresetId,
                    onChange: e => setCareerPresetId(e.target.value),
                    style: { marginTop: 10 }
                }, CAREER_PRESETS.map(p => React.createElement("option", { key: p.id, value: p.id }, p.title))),
                React.createElement("button", {
                    className: "btn",
                    style: { marginTop: 10 },
                    onClick: () => {
                        commit(draft => {
                            const d = draft.dexes.find(x => x.id === dexId);
                            if (!d) return;
                            applyCareerPresetToDex(d, careerPresetId);
                        });
                        pushToast("Preset applied.");
                    }
                }, "Apply Preset")
            ),

            (tree.nodes.length > 0) && React.createElement("div", { className: "card" },
                React.createElement("b", null, "Milestones"),
                React.createElement("div", { className: "smallNote" }, "Complete unlocked milestones to earn XP. Use Undo if you make a mistake."),
                groupNames.map(g => React.createElement("div", { key: g, style: { marginTop: 10 } },
                    React.createElement("div", { className: "pill" }, g),
                    groups[g].map(n => {
                        const unlocked = isNodeUnlocked(tree, n.id);
                        const done = !!n.done;
                        const label = done ? "🏆 Completed" : (unlocked ? "✅ Unlocked" : "🔒 Locked");
                        return React.createElement("div", { key: n.id, className: "logItem", style: { opacity: done ? 1 : (unlocked ? 0.95 : 0.65) } },
                            React.createElement("div", { className: "smallRow" },
                                React.createElement("b", null, n.title),
                                React.createElement("div", { className: "pill" }, safeNumber(n.xp, 0), " XP")
                            ),
                            n.desc ? React.createElement("div", { className: "smallNote" }, n.desc) : null,
                            React.createElement("div", { className: "smallRow", style: { marginTop: 6 } },
                                React.createElement("div", { className: "muted" }, label),
                                (!done && unlocked) ? React.createElement("button", { className: "btn2", onClick: () => completeNode(n.id) }, "Complete") : null
                            )
                        );
                    })
                ))
            ),

            React.createElement("div", { className: "card" },
                React.createElement("b", null, "Add Custom Milestone"),
                React.createElement("div", { className: "smallNote" }, "Adds an unlocked milestone to this tree."),
                React.createElement("input", { className: "input", value: careerCustomTitle, placeholder: "Title", onChange: e => setCareerCustomTitle(e.target.value), style: { marginTop: 8 } }),
                React.createElement("input", { className: "input", value: careerCustomDesc, placeholder: "Description (optional)", onChange: e => setCareerCustomDesc(e.target.value), style: { marginTop: 8 } }),
                React.createElement("input", { className: "input", type: "number", value: careerCustomXP, onChange: e => setCareerCustomXP(e.target.value), style: { marginTop: 8 } }),
                React.createElement("button", {
                    className: "btn",
                    style: { marginTop: 10 },
                    onClick: () => {
                        const title = safeString(careerCustomTitle,"").trim();
                        if (!title) { pushToast("Title required."); return; }
                        const xp = clamp(safeNumber(careerCustomXP, 0), 0, 5000);

                        commit(draft => {
                            const d = draft.dexes.find(x => x.id === dexId);
                            if (!d) return;
                            const t = getCareerTreeForDex(d);
                            t.nodes.push({
                                id: uid(),
                                group: "Custom",
                                title,
                                desc: safeString(careerCustomDesc,"").trim(),
                                xp,
                                requires: [],
                                done: false
                            });
                            d.careerTree = normalizeCareerTree({ careerPresetId: t.careerPresetId, title: (t.title || ""), nodes: t.nodes });
                        });

                        setCareerCustomTitle(""); setCareerCustomDesc(""); setCareerCustomXP(150);
                        pushToast("Custom milestone added.");
                    }
                }, "Add Milestone")
            )
        );
    }
    // MILESTONES
    if (screen === "milestones") {
        const dexId = active;
        const dex = state.dexes.find(d=>d.id===dexId);
        if (!dex || !dex.careerTree) {
            return React.createElement(React.Fragment,null,
                React.createElement("button",{className:"back",onClick:()=>setScreen("details")},"Back"),
                React.createElement("div",{className:"card"},"No milestones yet.")
            );
        }
        const tree = getCareerTreeForDex(dex);
        const groups = {};
        for (const n of tree.nodes){
            const g=n.group||"Custom";
            (groups[g]=groups[g]||[]).push(n);
        }
        return React.createElement(React.Fragment,null,
            React.createElement("button",{className:"back",onClick:()=>setScreen("details")},"Back"),
            React.createElement("div",{className:"card"},
                React.createElement("h2",null,"Milestones"),
                Object.keys(groups).map(g=>React.createElement("div",{key:g},
                    React.createElement("div",{className:"pill"},g),
                    groups[g].map(n=>{
                        const unlocked=isNodeUnlocked(tree,n.id);
                        const label=n.done?"Completed":(unlocked?"Unlocked":"Locked");
                        return React.createElement("div",{key:n.id,className:"logItem"},
                            React.createElement("b",null,n.title),
                            " — ",
                            label,
                            " (",safeNumber(n.xp,0)," XP)"
                        );
                    })
                ))
            ),
            React.createElement("button",{className:"btn2",onClick:()=>setScreen("careerTree")},"Open Career Tree")
        );
    }





    // HOME
    const todayXP = computeTodayXP(state.timeline) + sessionTodayXP;
    const todayLabel = todayXP >= 0 ? `+${todayXP}` : `${todayXP}`;
    const _days = daySetFromTimeline(state.timeline);
    if (sessionTodayXP !== 0) _days.add(localDayKey(Date.now()));
    const streakDays = computeStreakDaysFromDaySet(_days);

    return (React.createElement(React.Fragment, null,
        React.createElement("h1", null, "LifeDex"),
        React.createElement("div", { className: "todayLine" },
            React.createElement("div", { className: "muted" }, "Your life, indexed."),
            React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                React.createElement("div", { className: "todayPill", title: "Net XP earned today (based on timeline timestamps + in-session XP changes)" },
                    "Today: ",
                    React.createElement("b", { style: { color: todayXP >= 0 ? "#22c55e" : "#fb7185" } },
                        todayLabel,
                        " XP")),
                React.createElement("div", { className: "streakPill", title: "Consecutive days with activity (timeline + in-session XP today)" },
                    "Streak: ",
                    React.createElement("b", null, streakDays),
                    " day",
                    streakDays === 1 ? "" : "s"))),
        React.createElement("div", { className: "card row" },
            React.createElement("button", { className: "btn", onClick: openCreateDex }, "+ New Dex"),
            React.createElement("button", { className: "btn2", onClick: () => { setFilter("All"); setScreen("timeline"); } }, "Timeline"),
            React.createElement("button", { className: "btn2", onClick: () => setScreen("stats") }, "Stats"),
            React.createElement("button", { className: "btn2", onClick: undo }, "Undo"),
            React.createElement("button", { className: "btnDanger", onClick: resetAll }, "Reset All")),
        React.createElement("div", { className: "card" },
            React.createElement("b", null, "Data"),
            React.createElement("div", { className: "muted" }, "Export a backup file or import one to restore/transfer your LifeDex."),
            React.createElement("div", { className: "row", style: { marginTop: 10 } },
                React.createElement("button", { className: "btn2", onClick: exportSave }, "Export Save"),
                React.createElement("button", { className: "btn2", onClick: () => { var _a; return (_a = importRef.current) === null || _a === void 0 ? void 0 : _a.click(); } }, "Import Save"),
                React.createElement("input", { ref: importRef, type: "file", accept: "application/json", style: { display: "none" }, onChange: async (e) => {
                        var _a;
                        const file = (_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0];
                        e.target.value = "";
                        if (!file)
                            return;
                        await importSaveFromFile(file);
                    } })),
            React.createElement("div", { className: "smallNote" }, "Tip: Export before big changes so you can restore instantly.")),
state.dexes.length === 0 && React.createElement("div", { className: "card" },
    React.createElement("b", null, "No Dexes yet."),
    React.createElement("div", { className: "smallNote" }, "Create your first Dex to begin.")
),


state.dexes.map(d => {
            const lvl = levelFromXP(d.xp);
            const pct = progressPercent(d.xp);
            const nextInfo = xpToNextLevelInfo(d.xp);
            const recent = isRecent(d.id); // uses tick implicitly via rerender
            return (React.createElement("div", { key: d.id, className: `card ${recent ? "recentGlow" : ""}`, onClick: () => { } },
                React.createElement("div", { className: `banner ${d.type.toLowerCase()}` },
                    React.createElement("h2", null, d.name),
                    React.createElement("div", { className: "muted" },
                        d.type,
                        " \u2022 ",
                        lvl,
                        " \u2022 ",
                        d.xp,
                        " XP"),
                    React.createElement("div", { className: "smallNote" }, nextInfo.done ? "Max level reached" : `${nextInfo.remaining} XP to ${nextInfo.next}`),
                    React.createElement("div", { className: "bar" },
                        React.createElement("div", { className: "fill", style: { width: pct + "%" } }))),
                React.createElement("div", { className: "row" },
                    React.createElement("button", { className: "btn", onClick: () => {
                            clearRecent(d.id);
                            setActive(d.id);
                            setScreen("details");
                        } }, "Details"),
                    React.createElement("button", { className: "btn2", onClick: () => {
                            clearRecent(d.id);
                            setActive(d.id);
                            setScreen("journal");
                        } }, "Journal"),
                    React.createElement("button", { className: "btn2", onClick: () => openEditDex(d) }, "Edit"),
                    React.createElement("button", { className: "btn2", onClick: () => { setFilter("All"); setScreen("timeline"); } }, "Timeline"))));
        })));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App, null));
