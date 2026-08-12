import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { BookOpen, Plus, X, ChevronLeft, ChevronRight, Trash2, Moon, Sparkles, Check, Calendar as CalIcon, List as ListIcon } from "lucide-react";
import { createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, setDoc } from "firebase/firestore";
import { auth, db, configureAuthPersistence, firebaseReady, getFirebaseConfigStatus } from "./src/firebase.js";

/* ------------------------------------------------------------------ *
 *  Bindary — finish a task, and its poem is bound into your library.
 *  Two screens: the growing bookcase, and the tasks + deadline calendar.
 * ------------------------------------------------------------------ */

const SHELF_CAPACITY = 5;

/* ---------- cloth binding palette (spine colors) ---------- */
const CLOTHS = [
  { bg: "#6E2B2B", cap: "#521E1E" }, // oxblood
  { bg: "#2C4A3B", cap: "#1F3529" }, // forest
  { bg: "#26374F", cap: "#1A2839" }, // navy
  { bg: "#4A2F52", cap: "#35213B" }, // plum
  { bg: "#7A3E24", cap: "#5A2C18" }, // rust
  { bg: "#21514E", cap: "#173B39" }, // teal
  { bg: "#3A4351", cap: "#29303B" }, // slate
  { bg: "#5C5323", cap: "#433C18" }, // olive-gold
  { bg: "#5A2540", cap: "#3F1A2D" }, // burgundy
  { bg: "#2A2E5A", cap: "#1D2040" }, // indigo
  { bg: "#3E4A2A", cap: "#2B341C" }, // moss
  { bg: "#6E5230", cap: "#4E3A20" }, // bronze
  { bg: "#432A4A", cap: "#301D36" }, // aubergine
  { bg: "#1F4148", cap: "#142E33" }, // petrol
  { bg: "#8A4A34", cap: "#652F1F" }, // terracotta
  { bg: "#4E2A2E", cap: "#371D20" }, // wine
  { bg: "#2E4633", cap: "#203223" }, // ivy
  { bg: "#3A3A46", cap: "#282833" }, // graphite
];

/* ---------- importance tiers ---------- */
const TYPES = {
  task:       { label: "Task",       color: "#8FB0A6", chipBg: "rgba(143,176,166,0.16)", rank: 0 },
  assignment: { label: "Assignment", color: "#D6B45C", chipBg: "rgba(214,180,92,0.16)",  rank: 1 },
  exam:       { label: "Exam",       color: "#D9736A", chipBg: "rgba(217,115,106,0.16)",  rank: 2 },
};
const TYPE_ORDER = ["task", "assignment", "exam"];
const typeOf = (t) => TYPES[t] || TYPES.task;

/* ---------- rarity (an endless collection: no two alike) ---------- */
const RARITY = [
  { key: "common",   name: "Common",        weight: 720, color: "#C7BB99", ink: "#6E6344" },
  { key: "uncommon", name: "Uncommon",      weight: 200, color: "#8FB0A6", ink: "#3E6B5E" },
  { key: "rare",     name: "Rare",          weight: 62,  color: "#8FB6E6", ink: "#33608F" },
  { key: "fine",     name: "Fine",          weight: 16,  color: "#E6C976", ink: "#8A6A1E" },
  { key: "first",    name: "First edition", weight: 2,   color: "#F2DE9A", ink: "#96690F" },
];
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, fine: 3, first: 4 };
const rarityOf = (k) => RARITY.find((r) => r.key === k) || RARITY[0];
function rollRarity() {
  const total = RARITY.reduce((s, r) => s + r.weight, 0);
  let x = Math.random() * total;
  for (const r of RARITY) { if ((x -= r.weight) < 0) return r.key; }
  return "common";
}
const BINDINGS = ["cloth boards", "buckram", "linen", "quarter calf", "morocco", "vellum", "marbled boards", "half leather", "paper wraps", "pressed silk"];
const randOf = (a) => a[Math.floor(Math.random() * a.length)];

const MOTIFS = [
  "moth", "key", "thread", "candle", "ink", "glass", "feather", "laurel",
  "river stone", "brass leaf", "salt", "ember", "paper crane", "storm glass",
  "violet", "needle", "moonbeam", "sparrow", "archive tag", "wax seal",
];
const ACCENTS = [
  "amber", "ash", "copper", "mist", "violet", "cedar", "opal", "sable",
  "moss", "linden", "pearl", "smoke", "indigo", "bronze", "chalk", "teal",
];

function pickFrom(list, rand) {
  return list[Math.floor(rand() * list.length)];
}

function buildBookIdentity(task, type, bookId) {
  const seed = hashInt(`${bookId}|${task}|${type}`);
  const rand = mulberry(seed);
  const motif = pickFrom(MOTIFS, rand);
  const accent = pickFrom(ACCENTS, rand);
  const bindingForm = pickFrom(BINDINGS, rand);
  const paperTone = pickFrom(["ivory", "bone", "fog", "old gold", "cream", "ash white", "eggshell", "pale sand"], rand);
  const edgeTint = pickFrom(["copper", "indigo", "emerald", "wine", "amber", "graphite", "teal", "rose ash"], rand);
  const classification = pickFrom(["archive", "folio", "ledger", "atlas", "codex", "register", "manual", "compendium"], rand);
  const seriesMark = `${String(Math.floor(rand() * 900) + 100)}-${String.fromCharCode(65 + Math.floor(rand() * 26))}${String.fromCharCode(65 + Math.floor(rand() * 26))}`;
  return {
    motif,
    accent,
    bindingForm,
    paperTone,
    edgeTint,
    classification,
    seriesMark,
    editionNote: `Filed under ${motif} in ${accent} light.`,
    spineMark: motif.slice(0, 1).toUpperCase(),
    spineShift: Math.floor(rand() * 16) - 8,
    spineTilt: Math.floor(rand() * 5) - 2,
    spineBands: 1 + Math.floor(rand() * 4),
    spineDivision: 1 + Math.floor(rand() * 3),
    spineGlyph: pickFrom(["✦", "✧", "◈", "▣", "◆", "◇", "✺", "✹"], rand),
  };
}

/* ---------- tiny utils ---------- */
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function hashInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const titleCase = (s) => s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
const prettyDate = (k) => parseKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    on(); mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

/* ---------- firebase helpers ---------- */
function userCollectionPath(userId, name) {
  return collection(db, "users", userId, name);
}

function friendlyAuthError(error) {
  const code = error?.code || "";
  if (code.includes("email-already-in-use")) return "That email is already registered.";
  if (code.includes("invalid-email")) return "That email address is not valid.";
  if (code.includes("weak-password")) return "Use a stronger password (at least 6 characters).";
  if (code.includes("user-not-found") || code.includes("wrong-password") || code.includes("invalid-credential")) return "Email or password is incorrect.";
  if (code.includes("too-many-requests")) return "Too many attempts. Try again in a little while.";
  return "Could not sign in right now. Check your Firebase config and try again.";
}

/* ---------- poem generation ---------- */
function cleanTask(task) {
  let t = (task || "").trim().replace(/[.!?;:,]+$/, "").toLowerCase();
  t = t.replace(/^(please\s+)?(go\s+)?(do|finish|complete|submit|hand in|study for|study|write|read|revise|prepare( for)?|work on|practice|practise|review|start|draft|edit|fix|make|build|plan)\s+/i, "");
  t = t.replace(/^(the|a|an|my|our|your|this|that|some)\s+/i, "");
  return t.trim();
}

const POEM_OPENERS = [
  "After the final click, the room keeps breathing",
  "When the work is done, the light changes its mind",
  "Tonight the desk opens like a held door",
  "The hour after finishing is a different country",
  "I set the task down and the air remembers me",
  "The last checkmark leaves a bright scar in the evening",
  "In the hush after effort, everything is newly arranged",
];
const POEM_VERBS = [
  "folds", "leans", "settles", "drifts", "shimmers", "loosens", "returns", "stays", "turns", "wakes", "forgives", "echoes",
];
const POEM_NOUNS = [
  "the page", "the lamp", "the window", "my hands", "the shelf", "the chair", "the clock", "the notebook", "the hallway", "the moon",
  "the margin", "the desk", "the evening", "the floor", "the silence",
];
const POEM_IMAGES = [
  "with dust in its edges", "in a thin seam of gold", "like water under ice", "against a collar of night", "through a small gate of breath",
  "beside the grain of wood", "under a ribbon of shadow", "inside a pocket of stillness", "under a rim of weather", "with its own private weather",
];
const POEM_TASK_ENDINGS = [
  "I finished the {TASK} and kept the shape of it.",
  "The {TASK} no longer asks for my hands.",
  "What remained of the {TASK} was only calm.",
  "The {TASK} gave back its weight and became memory.",
  "I carried the {TASK} to the end and came back lighter.",
  "The {TASK} is now a closed door with warm hinges.",
];
const POEM_TURNS = [
  "What was friction becomes a kind of weather.",
  "The body loosens before the mind admits it.",
  "Even relief has a texture, and tonight I can feel it.",
  "The room grows wider by exactly the amount I needed.",
  "Something in me files itself under done.",
  "A quieter version of me steps forward and nods.",
];
const POEM_CLOSERS = [
  "This copy belongs to the version of me that finished it.",
  "Filed with the others, but never quite the same.",
  "Bound for this hour only, and no other.",
  "No duplicate will carry this exact weather again.",
  "It lives here once, and only once.",
  "The shelf keeps it, but the moment cannot be repeated.",
];
const TITLE_HEADS = ["Ledger", "Codex", "Atlas", "Archive", "Tally", "Index", "Register", "Volume", "Field", "Table"];
const TITLE_MIDDLES = ["of", "for", "under", "against", "beside", "within", "after", "through"];
const TITLE_SUBJECTS = ["Quiet Work", "Small Victories", "the Finished Hour", "One Exact Ending", "Late Light", "the Long Minute", "the Last Checkmark", "the Tired Hand", "ordinary weather", "a closed task"];
const TITLE_SUFFIXES = ["I", "II", "III", "IV", "V", "A", "B", "C", "North", "South", "Field Edition", "Private Copy"];

function uniqueLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const key = line.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function generateBookTitle(rand, clean, identity) {
  const patterns = [
    () => `${pickFrom(TITLE_HEADS, rand)} ${pickFrom(TITLE_MIDDLES, rand)} ${pickFrom(TITLE_SUBJECTS, rand)}`,
    () => `${pickFrom(TITLE_SUBJECTS, rand)} ${pickFrom(TITLE_SUFFIXES, rand)}`,
    () => `${pickFrom(TITLE_HEADS, rand)} ${pickFrom(TITLE_SUBJECTS, rand)}`,
    () => `${pickFrom(TITLE_HEADS, rand)} ${pickFrom(TITLE_MIDDLES, rand)} ${clean ? titleCase(clean.slice(0, 18)) : pickFrom(TITLE_SUBJECTS, rand)}`,
  ];
  const raw = patterns[Math.floor(rand() * patterns.length)]();
  const embellish = rand() > 0.65 ? ` ${pickFrom(TITLE_SUFFIXES, rand)}` : "";
  const title = `${raw}${embellish}`.replace(/\s+/g, " ").trim();
  return titleCase(title).slice(0, 60);
}

function generateBookPoem(task, type, identity) {
  const clean = cleanTask(task);
  const seed = hashInt(`${identity.seriesMark}|${identity.motif}|${identity.accent}|${task}|${type}`);
  const rand = mulberry(seed);
  const lineCount = 7 + Math.floor(rand() * 4);
  const lines = [];

  lines.push(pickFrom(POEM_OPENERS, rand) + ".");
  lines.push(`The ${pickFrom(POEM_NOUNS, rand)} ${pickFrom(POEM_VERBS, rand)} ${pickFrom(POEM_IMAGES, rand)}.`);
  lines.push(pickFrom(POEM_TASK_ENDINGS, rand).replace("{TASK}", clean || "work"));
  lines.push(`A ${identity.motif} keeps its ${identity.accent} color in the corner of the page.`);
  lines.push(pickFrom(POEM_TURNS, rand));

  while (lines.length < lineCount - 2) {
    const next = rand() > 0.5
      ? `${pickFrom(POEM_NOUNS, rand)} ${pickFrom(POEM_VERBS, rand)} ${pickFrom(POEM_IMAGES, rand)}.`
      : `${pickFrom(POEM_OPENERS, rand)}.`;
    lines.push(next);
  }

  lines.push(`Bound in ${identity.bindingForm}, with ${identity.paperTone} pages and ${identity.edgeTint} edges.`);
  lines.push(identity.editionNote);

  return uniqueLines(lines).join("\n");
}

function generatePoem(task, type, identity) {
  const clean = cleanTask(task);
  const rand = mulberry(hashInt(`${task}|${type}|${identity.seriesMark}|${identity.classification}`));
  const title = generateBookTitle(rand, clean, identity);
  const poem = generateBookPoem(task, type, identity);
  return { title, poem };
}

/* ---------- brand mark ---------- */
function Logo({ size = 40, tile = true }) {
  const idRef = useRef("m" + Math.random().toString(36).slice(2, 8));
  const mid = idRef.current;
  const gold = "#D6B45C", goldB = "#EFD68F";
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Bindary">
      <defs>
        <linearGradient id={mid + "bg"} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#141A34" />
          <stop offset="1" stopColor="#251C22" />
        </linearGradient>
        <mask id={mid + "moon"}>
          <rect x="0" y="0" width="48" height="48" fill="black" />
          <circle cx="33.5" cy="14.5" r="6.4" fill="white" />
          <circle cx="36.6" cy="12" r="5.6" fill="black" />
        </mask>
      </defs>
      {tile && <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill={`url(#${mid}bg)`} stroke="rgba(214,180,92,0.4)" />}
      {tile && <>
        <circle cx="12" cy="12" r="0.8" fill="#F4ECD6" opacity="0.6" />
        <circle cx="19" cy="9" r="0.55" fill="#F4ECD6" opacity="0.5" />
        <circle cx="9" cy="20" r="0.5" fill="#F4ECD6" opacity="0.4" />
      </>}
      <rect x="0" y="0" width="48" height="48" fill={goldB} mask={`url(#${mid}moon)`} />
      <g stroke={gold} strokeWidth={tile ? 1.4 : 2} strokeLinejoin="round">
        <rect x="9" y="32" width="30" height="7" rx="2" fill={tile ? "#6E2B2B" : "none"} />
        <rect x="11" y="24.5" width="26" height="7" rx="2" fill={tile ? "#B0863A" : "none"} />
        <rect x="13" y="17" width="22" height="7" rx="2" fill={tile ? "#2C4A3B" : "none"} />
      </g>
      <g stroke={goldB} strokeWidth="1.3" opacity="0.95">
        <line x1="15" y1="32.6" x2="15" y2="38.4" />
        <line x1="17" y1="25.1" x2="17" y2="30.9" />
        <line x1="19" y1="17.6" x2="19" y2="23.4" />
      </g>
    </svg>
  );
}

function Splash() {
  return (
    <div style={styles.splash}>
      <div className="rise" style={{ textAlign: "center" }}>
        <Logo size={76} />
        <div style={styles.splashWord}>Bindary</div>
        <div style={styles.splashTag}>Finish something. Bind its poem.</div>
        <div className="spin" style={{ ...styles.spinner, margin: "22px auto 0", width: 18, height: 18 }} />
      </div>
    </div>
  );
}

/* ================================================================== */

export default function App() {
  const [tab, setTab] = useState("tasks");
  const [books, setBooks] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [authUser, setAuthUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [booksReady, setBooksReady] = useState(false);
  const [tasksReady, setTasksReady] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [openIndex, setOpenIndex] = useState(null); // index into books for modal
  const [celebration, setCelebration] = useState(null);
  const [bindingId, setBindingId] = useState(null);
  const libScrollRef = useRef(null);
  const reduce = usePrefersReducedMotion();
  const firebaseStatus = useMemo(() => getFirebaseConfigStatus(), []);
  const appReady = !authChecking && (!authUser || (booksReady && tasksReady));

  useEffect(() => {
    let active = true;
    if (!firebaseReady || !auth) {
      setAuthChecking(false);
      return () => { active = false; };
    }

    configureAuthPersistence().catch((error) => {
      if (!active) return;
      setAuthError(error?.message || "Unable to enable sign-in persistence.");
    });

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!active) return;
      setAuthUser(user || null);
      setAuthChecking(false);
      setBindingId(null);
      setAuthBusy(false);
      setAuthError("");
      setSyncError("");
      setOpenIndex(null);
      setCelebration(null);
      setTab("tasks");
      if (!user) {
        setBooks([]);
        setTasks([]);
        setBooksReady(false);
        setTasksReady(false);
      }
    });

    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!authUser || !db) return;

    setBooksReady(false);
    setTasksReady(false);
    setSyncError("");

    const booksQuery = query(userCollectionPath(authUser.uid, "books"), orderBy("completedAt", "asc"));
    const tasksQuery = query(userCollectionPath(authUser.uid, "tasks"), orderBy("createdAt", "desc"));

    const unsubscribeBooks = onSnapshot(booksQuery, (snapshot) => {
      setBooks(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      setBooksReady(true);
    }, (error) => {
      setSyncError(error?.message || "Could not load saved books.");
      setBooksReady(true);
    });

    const unsubscribeTasks = onSnapshot(tasksQuery, (snapshot) => {
      setTasks(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      setTasksReady(true);
    }, (error) => {
      setSyncError(error?.message || "Could not load saved tasks.");
      setTasksReady(true);
    });

    return () => {
      unsubscribeBooks();
      unsubscribeTasks();
    };
  }, [authUser?.uid]);

  const booksRef = useMemo(() => (authUser && db ? userCollectionPath(authUser.uid, "books") : null), [authUser?.uid]);
  const tasksRef = useMemo(() => (authUser && db ? userCollectionPath(authUser.uid, "tasks") : null), [authUser?.uid]);

  const addTask = useCallback(async (text, due, type) => {
    if (!authUser || !tasksRef) return;
    const t = { id: uid(), text: text.trim(), due: due || null, type: type || "task", done: false, createdAt: Date.now() };
    if (!t.text) return;
    await setDoc(doc(tasksRef, t.id), t);
    setTasks((prev) => (prev.some((item) => item.id === t.id) ? prev : [t, ...prev]));
  }, [authUser, tasksRef]);

  const deleteTask = useCallback(async (id) => {
    if (!authUser || !tasksRef) return;
    await deleteDoc(doc(tasksRef, id));
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, [authUser, tasksRef]);

  const completeTask = useCallback(async (task) => {
    if (task.done || bindingId || !authUser || !booksRef || !tasksRef) return;
    setBindingId(task.id);
    try {
      const bookId = uid();
      const identity = buildBookIdentity(task.text, task.type, bookId);
      const { title, poem } = await generatePoem(task.text, task.type, identity);
      const book = {
        id: bookId,
        title,
        poem,
        taskName: task.text,
        type: task.type || "task",
        completedAt: Date.now(),
        color: Math.floor(Math.random() * CLOTHS.length),
        rarity: rollRarity(),
        material: randOf(BINDINGS),
        ...identity,
      };
      const updatedTask = { ...task, done: true };
      await setDoc(doc(booksRef, book.id), book);
      await setDoc(doc(tasksRef, task.id), updatedTask);
      setBooks((prev) => (prev.some((item) => item.id === book.id) ? prev : [...prev, book]));
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updatedTask : t)));
      setCelebration(book);
    } catch (error) {
      setSyncError(error?.message || "Could not bind the poem right now.");
    } finally {
      setBindingId(null);
    }
  }, [authUser, bindingId, booksRef, tasksRef]);

  const reopenTask = useCallback(async (id) => {
    if (!authUser || !tasksRef) return;
    const currentTask = tasks.find((item) => item.id === id);
    if (!currentTask) return;
    const reopened = { ...currentTask, done: false };
    await setDoc(doc(tasksRef, id), reopened);
    setTasks((prev) => prev.map((t) => (t.id === id ? reopened : t)));
  }, [authUser, tasks, tasksRef]);

  const deleteBook = useCallback(async (id) => {
    if (!authUser || !booksRef) return;
    await deleteDoc(doc(booksRef, id));
    setBooks((prev) => prev.filter((book) => book.id !== id));
    setOpenIndex((current) => {
      if (current == null) return current;
      const currentBook = books[current];
      return currentBook && currentBook.id === id ? null : current;
    });
  }, [authUser, books, booksRef]);

  const handleSignIn = useCallback(async (event) => {
    event.preventDefault();
    if (!auth || !email || !password) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      if (authMode === "signup") {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (error) {
      setAuthError(friendlyAuthError(error));
    } finally {
      setAuthBusy(false);
    }
  }, [authMode, email, password]);

  const handlePasswordReset = useCallback(async () => {
    if (!auth || !email.trim()) return;
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setAuthError("Password reset email sent.");
    } catch (error) {
      setAuthError(friendlyAuthError(error));
    }
  }, [email]);

  const handleSignOut = useCallback(async () => {
    if (!auth) return;
    await signOut(auth);
  }, []);

  const dismissCelebration = useCallback(() => {
    setCelebration(null);
    setTab("library");
    setTimeout(() => { if (libScrollRef.current) libScrollRef.current.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" }); }, 60);
  }, [reduce]);

  return (
    <div className="app-root" style={styles.root}>
      <style>{CSS}</style>

      <div className="app-phone">
        {!firebaseReady ? (
          <FirebaseSetupScreen missing={firebaseStatus.missing} />
        ) : authChecking ? (
          <Splash />
        ) : !authUser ? (
          <AuthScreen
            mode={authMode}
            email={email}
            password={password}
            busy={authBusy}
            error={authError}
            onModeChange={setAuthMode}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onSubmit={handleSignIn}
            onResetPassword={handlePasswordReset}
          />
        ) : !appReady ? (
          <Splash />
        ) : (
          <>
            <div style={styles.userBar}>
              <div style={styles.userPill} title={authUser.email || "Signed in"}>
                <span style={styles.userDot} />
                {authUser.email || "Signed in"}
              </div>
              <button className="iconbtn" style={styles.signOutBtn} onClick={handleSignOut}>Sign out</button>
            </div>

            {syncError && <div style={styles.syncBanner}>{syncError}</div>}

            <div key={tab} className="screen-fade" style={styles.screen}>
              {tab === "library" ? (
                <LibraryScreen books={books} scrollRef={libScrollRef} onOpen={(i) => setOpenIndex(i)} reduce={reduce} />
              ) : (
                <TasksScreen
                  tasks={tasks} onAdd={addTask} onComplete={completeTask}
                  onDelete={deleteTask} onReopen={reopenTask} bindingId={bindingId}
                />
              )}
            </div>

            <nav style={styles.nav} aria-label="Screens">
              <TabButton active={tab === "library"} onClick={() => setTab("library")} icon={<BookOpen size={20} />} label="Library" badge={books.length} />
              <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} icon={<ListIcon size={20} />} label="Tasks" />
            </nav>
          </>
        )}
      </div>

      {openIndex != null && books[openIndex] && (
        <BookModal
          books={books} index={openIndex}
          onClose={() => setOpenIndex(null)} onNav={(i) => setOpenIndex(i)}
          onDeleteBook={deleteBook}
        />
      )}

      {celebration && <Celebration book={celebration} onClose={dismissCelebration} reduce={reduce} />}
    </div>
  );
}

function AuthScreen({ mode, email, password, busy, error, onModeChange, onEmailChange, onPasswordChange, onSubmit, onResetPassword }) {
  return (
    <div style={styles.authShell}>
      <div style={styles.authGlow} aria-hidden="true" />
      <div style={styles.authCard}>
        <div style={styles.authMark}>
          <Logo size={64} />
        </div>
        <div style={styles.authKicker}><Moon size={12} /> Bindary</div>
        <h1 style={styles.authTitle}>A private shelf for finished work.</h1>
        <p style={styles.authCopy}>Sign in once, and Firebase keeps your books and task list synced every time you reload.</p>

        <div style={styles.authTabs} role="tablist" aria-label="Authentication mode">
          <button type="button" onClick={() => onModeChange("signin")} style={{ ...styles.authTab, ...(mode === "signin" ? styles.authTabActive : {}) }}>Sign in</button>
          <button type="button" onClick={() => onModeChange("signup")} style={{ ...styles.authTab, ...(mode === "signup" ? styles.authTabActive : {}) }}>Create account</button>
        </div>

        <form onSubmit={onSubmit} style={styles.authForm}>
          <label style={styles.authLabel}>
            Email
            <input className="field" type="email" value={email} onChange={(e) => onEmailChange(e.target.value)} placeholder="you@example.com" autoComplete="email" style={styles.authInput} />
          </label>
          <label style={styles.authLabel}>
            Password
            <input className="field" type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)} placeholder="••••••••" autoComplete={mode === "signup" ? "new-password" : "current-password"} style={styles.authInput} />
          </label>

          {error && <div style={styles.authError}>{error}</div>}

          <button className="addbtn" type="submit" disabled={busy} style={styles.authSubmit}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>

          <button type="button" onClick={onResetPassword} style={styles.authLink}>Forgot password?</button>
        </form>

        <div style={styles.authFooter}>Your library syncs through Firebase Auth + Firestore.</div>
      </div>
    </div>
  );
}

function FirebaseSetupScreen({ missing }) {
  return (
    <div style={styles.authShell}>
      <div style={styles.authCard}>
        <Logo size={64} />
        <div style={styles.authKicker}>Firebase required</div>
        <h1 style={styles.authTitle}>Connect your Firebase project to continue.</h1>
        <p style={styles.authCopy}>Create a <code>.env</code> file from <code>.env.example</code> and fill in these values:</p>
        <div style={styles.envList}>
          {missing.map((key) => <div key={key} style={styles.envItem}>{key}</div>)}
        </div>
      </div>
    </div>
  );
}

/* ---------- bottom nav button ---------- */
function TabButton({ active, onClick, icon, label, badge }) {
  return (
    <button className="tabbtn" onClick={onClick} aria-pressed={active}
      style={{ ...styles.tabBtn, color: active ? "var(--gold-bright)" : "rgba(236,227,208,0.5)" }}>
      <span style={{ position: "relative" }}>
        {icon}
        {badge > 0 && <span style={styles.tabBadge}>{badge}</span>}
      </span>
      <span style={{ fontFamily: "Fraunces, serif", fontSize: 12, letterSpacing: "0.06em" }}>{label}</span>
      {active && <span style={styles.tabDot} />}
    </button>
  );
}

/* ================================================================== *
 *  LIBRARY
 * ================================================================== */
function LibraryScreen({ books, scrollRef, onOpen, reduce }) {
  const shelfCount = Math.max(1, Math.ceil(books.length / SHELF_CAPACITY));
  const onShelf = books.length % SHELF_CAPACITY;
  const remaining = onShelf === 0 ? 0 : SHELF_CAPACITY - onShelf;
  const progress = books.length === 0 ? 0 : (onShelf === 0 ? 1 : onShelf / SHELF_CAPACITY);
  const caption =
    books.length === 0 ? "Every finished task raises the tower a little higher."
    : remaining === 0 ? "A shelf complete — the tower just grew."
    : `${remaining} more ${remaining === 1 ? "book" : "books"} to raise a new shelf.`;

  return (
    <div style={styles.library}>
      <header style={styles.libHeader}>
        <div>
          <div style={styles.eyebrow}>Your library</div>
          <div style={styles.libCount}>
            {books.length} {books.length === 1 ? "book" : "books"}
            <span style={styles.libDivider}>·</span>
            {shelfCount} {shelfCount === 1 ? "shelf" : "shelves"}
          </div>
          {books.length > 0 && (
            <div style={styles.tally}>
              {RARITY.map((r) => {
                const n = books.filter((b) => (b.rarity || "common") === r.key).length;
                if (!n) return null;
                return (
                  <span key={r.key} style={styles.tallyItem} title={r.name}>
                    <span style={{ ...styles.tallyDot, background: r.color }} />{n}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <Logo size={34} tile={false} />
      </header>

      <div ref={scrollRef} className="lib-scroll" style={styles.libScroll}>
        <div style={styles.sky}>
          <div style={styles.moon} aria-hidden="true" />
          <Stars />
          <div style={styles.skyBottom}>
            <div style={styles.skyCaption}>{caption}</div>
            {books.length > 0 && (
              <div style={styles.progressTrack} aria-hidden="true">
                <div style={{ ...styles.progressFill, width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
            <div style={styles.skySub}>No two books are alike — more editions than you could ever shelve.</div>
          </div>
        </div>

        <div style={styles.tower}>
          {books.length === 0 ? (
            <EmptyShelf />
          ) : (
            reversedIndexedShelves(books).map((shelf, i) => (
              <Shelf key={i} items={shelf} onOpen={onOpen} isTop={i === 0} reduce={reduce} />
            ))
          )}
          <div style={styles.floor} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/* build [{book, globalIndex}] per shelf, newest shelf first */
function reversedIndexedShelves(books) {
  const chunks = [];
  for (let i = 0; i < books.length; i += SHELF_CAPACITY) {
    chunks.push(books.slice(i, i + SHELF_CAPACITY).map((b, j) => ({ book: b, index: i + j })));
  }
  if (chunks.length === 0 || chunks[chunks.length - 1].length === SHELF_CAPACITY) chunks.push([]);
  return chunks.reverse();
}

function Shelf({ items, onOpen, isTop, reduce }) {
  const slots = SHELF_CAPACITY;
  return (
    <div style={styles.shelfWrap}>
      <div style={styles.shelfBooks}>
        {items.map(({ book, index }, k) => (
          <Spine key={book.id}
            book={book} onOpen={() => onOpen(index)}
            fresh={isTop && k === items.length - 1 && !reduce}
          />
        ))}
        {isTop && Array.from({ length: Math.max(0, slots - items.length) }).map((_, i) => (
          <div key={"e" + i} style={styles.emptySlot} aria-hidden="true" />
        ))}
      </div>
      <div style={styles.plank} aria-hidden="true">
        <div style={styles.plankFace} />
        <div style={styles.plankEdge} />
      </div>
    </div>
  );
}

function Spine({ book, onOpen, fresh }) {
  const width = 52;
  const height = 156;
  const cloth = CLOTHS[book.color % CLOTHS.length];
  const isExam = book.type === "exam";
  const rarity = book.rarity || "common";
  const rr = RARITY_RANK[rarity] || 0;
  const gilded = rr >= 3;                    // fine / first edition shimmer
  const gem = rr >= 3 || isExam;
  const bright = rr >= 2 || isExam;
  const bandColor = bright ? "rgba(239,214,143,0.98)"
    : (rr >= 1 || book.type === "assignment") ? "rgba(214,180,92,0.85)"
    : "rgba(214,180,92,0.6)";
  const frame =
    rr >= 4 ? ", inset 0 0 0 2px rgba(247,233,190,0.92), 0 0 16px rgba(239,214,143,0.4)"
    : rr === 3 ? ", inset 0 0 0 1.6px rgba(239,214,143,0.75)"
    : (rr === 2 || isExam) ? ", inset 0 0 0 1.4px rgba(214,180,92,0.5)"
    : "";
  return (
    <button
      className={"spine" + (fresh ? " spine-fresh" : "") + (gilded ? " shimmer" : "")}
      onClick={onOpen}
      title={`${book.title}${rarity !== "common" ? " · " + rarityOf(rarity).name : ""}`}
      style={{
        ...styles.spine,
        width, height,
        background: `linear-gradient(90deg, ${cloth.cap} 0%, ${cloth.bg} 14%, ${cloth.bg} 82%, ${cloth.cap} 100%)`,
        boxShadow: styles.spine.boxShadow + frame,
        transform: "none",
      }}
    >
      {(rr === 1 || rr === 2) && <span style={styles.spineSheen} aria-hidden="true" />}
      {gem && <span style={styles.spineGem} aria-hidden="true" />}
      <span style={styles.spineGlyph} aria-hidden="true">{book.spineGlyph || "✦"}</span>
      {book.spineMark && <span style={{ ...styles.spineMark, color: bandColor }}>{book.spineMark}</span>}
      {Array.from({ length: book.spineBands || 1 }).map((_, i) => (
        <span key={i} style={{ ...styles.spineBandTop, top: 10 + i * 7, background: bandColor, opacity: 0.7 + i * 0.1 }} />
      ))}
      <span style={styles.spineTitle}>{book.title}</span>
      {Array.from({ length: book.spineBands || 1 }).map((_, i) => (
        <span key={"b" + i} style={{ ...styles.spineBandBottom, bottom: 10 + i * 7, background: bandColor, opacity: 0.7 + i * 0.1 }} />
      ))}
    </button>
  );
}

function EmptyShelf() {
  return (
    <div style={styles.shelfWrap}>
      <div style={{ ...styles.shelfBooks, alignItems: "flex-end" }}>
        {Array.from({ length: SHELF_CAPACITY }).map((_, i) => <div key={i} style={styles.emptySlot} />)}
      </div>
      <div style={styles.plank} aria-hidden="true">
        <div style={styles.plankFace} />
        <div style={styles.plankEdge} />
      </div>
      <div style={styles.emptyNote}>
        An empty case, for now.<br />
        <span style={{ opacity: 0.7 }}>Complete a task and its poem is bound here.</span>
      </div>
    </div>
  );
}

function Stars() {
  const dots = useMemo(() => {
    const rand = mulberry(9271);
    return Array.from({ length: 22 }).map(() => ({
      left: rand() * 100, top: rand() * 100, s: 1 + rand() * 1.6, o: 0.2 + rand() * 0.6,
    }));
  }, []);
  return (
    <>
      {dots.map((d, i) => (
        <span key={i} aria-hidden="true" style={{
          position: "absolute", left: d.left + "%", top: d.top + "%",
          width: d.s, height: d.s, borderRadius: "50%", background: "#F4ECD6", opacity: d.o,
        }} />
      ))}
    </>
  );
}

/* ================================================================== *
 *  BOOK MODAL
 * ================================================================== */
function BookModal({ books, index, onClose, onNav, onDeleteBook }) {
  const book = books[index];
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onNav(index - 1);
      if (e.key === "ArrowRight" && index < books.length - 1) onNav(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, books.length, onClose, onNav]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div className="book-open" style={styles.page} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={book.title}>
        <button className="iconbtn" style={styles.pageClose} onClick={onClose} aria-label="Close book"><X size={18} /></button>

        <div style={styles.pageInner}>
          <div style={styles.pageEyebrow}>
            Bound {prettyDate(toKey(new Date(book.completedAt)))} · from {book.type && book.type !== "task" ? "the " + typeOf(book.type).label.toLowerCase() + " " : ""}“{book.taskName}”
          </div>
          <div style={styles.pageRarity}>
            {(() => { const r = rarityOf(book.rarity || "common"); return (
              <span style={{ ...styles.rarityChip, color: r.ink, borderColor: r.ink + "55", background: r.ink + "12" }}>{r.name}</span>
            ); })()}
            {book.material && <span style={styles.pageMaterial}>bound in {book.material}</span>}
            {book.seriesMark && <span style={styles.pageMaterial}>edition {book.seriesMark}</span>}
            {book.classification && <span style={styles.pageMaterial}>{book.classification}</span>}
            {book.edgeTint && <span style={styles.pageMaterial}>edges {book.edgeTint}</span>}
          </div>
          <h2 style={styles.pageTitle}>{book.title}</h2>
          <div style={styles.pageRule} />
          <div style={styles.poem}>{book.poem}</div>
          <div style={styles.colophon}>№ {index + 1} of {books.length}</div>

          <div style={styles.pageActions}>
            <button
              className="iconbtn"
              style={styles.deleteBookBtn}
              onClick={() => {
                if (window.confirm(`Remove "${book.title}" from your library?`)) {
                  onDeleteBook(book.id);
                  onClose();
                }
              }}
            >
              Remove book
            </button>
          </div>
        </div>

        <div style={styles.pageNav}>
          <button className="iconbtn" style={{ ...styles.navArrow, opacity: index > 0 ? 1 : 0.25 }}
            disabled={index === 0} onClick={() => onNav(index - 1)} aria-label="Previous book"><ChevronLeft size={20} /></button>
          <button className="iconbtn" style={{ ...styles.navArrow, opacity: index < books.length - 1 ? 1 : 0.25 }}
            disabled={index === books.length - 1} onClick={() => onNav(index + 1)} aria-label="Next book"><ChevronRight size={20} /></button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== *
 *  CELEBRATION
 * ================================================================== */
function Celebration({ book, onClose, reduce }) {
  const cloth = CLOTHS[book.color % CLOTHS.length];
  const firstLine = (book.poem.split("\n").find((l) => l.trim()) || "").trim();
  useEffect(() => {
    const t = setTimeout(onClose, reduce ? 1600 : 4200);
    return () => clearTimeout(t);
  }, [onClose, reduce]);
  return (
    <div style={styles.celebrate} onClick={onClose}>
      <div className={reduce ? "" : "rise"} style={styles.celebInner}>
        <div style={styles.celebEyebrow}><Sparkles size={14} /> A new book</div>
        <div
          className={reduce ? "" : "shimmer"}
          style={{ ...styles.celebSpine, background: `linear-gradient(90deg, ${cloth.cap}, ${cloth.bg} 20%, ${cloth.bg} 80%, ${cloth.cap})` }}
        >
          <span style={{ ...styles.spineTitle, fontSize: 12 }}>{book.title}</span>
        </div>
        <h3 style={styles.celebTitle}>{book.title}</h3>
        {book.rarity && book.rarity !== "common" && (
          <div style={{ ...styles.celebRarity, color: rarityOf(book.rarity).color }}>
            ✦ A {rarityOf(book.rarity).name.toLowerCase()} find
          </div>
        )}
        {firstLine && <p style={styles.celebLine}>“{firstLine}”</p>}
        <div style={styles.celebCaption}>Bound to your library</div>
        <div style={styles.celebHint}>tap to view your shelves</div>
      </div>
    </div>
  );
}

/* ================================================================== *
 *  TASKS + CALENDAR
 * ================================================================== */
function TasksScreen({ tasks, onAdd, onComplete, onDelete, onReopen, bindingId }) {
  const [view, setView] = useState("list");
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [type, setType] = useState("task");
  const [filter, setFilter] = useState("all");
  const today = toKey(new Date());
  const tomorrow = toKey(new Date(Date.now() + 86400000));

  const submit = () => { if (text.trim()) { onAdd(text, due || null, type); setText(""); setDue(""); } };

  const active = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const rank = (t) => typeOf(t.type).rank;
  active.sort((a, b) => {
    if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return b.createdAt - a.createdAt;
  });

  const nextUp = active.find((t) => t.due);
  const shownActive = active.filter((t) => filter === "all" || t.type === filter);
  const shownDone = done.filter((t) => filter === "all" || t.type === filter);
  const isEmpty = active.length === 0 && done.length === 0;

  return (
    <div style={styles.tasks}>
      <header style={styles.masthead}>
        <div style={styles.brandRow}>
          <Logo size={40} />
          <div>
            <div style={styles.wordmark}>Bindary</div>
            <div style={styles.tagline}>Finish something. Bind its poem.</div>
          </div>
        </div>
      </header>

      <div style={styles.segmentWrap}>
        <div style={styles.segment}>
          <button onClick={() => setView("list")} style={{ ...styles.segBtn, ...(view === "list" ? styles.segActive : {}) }}>
            <ListIcon size={15} /> List
          </button>
          <button onClick={() => setView("calendar")} style={{ ...styles.segBtn, ...(view === "calendar" ? styles.segActive : {}) }}>
            <CalIcon size={15} /> Calendar
          </button>
        </div>
      </div>

      {/* add area */}
      <div style={styles.addWrap}>
        <div style={styles.typePicker} role="group" aria-label="Importance">
          {TYPE_ORDER.map((key) => {
            const ty = TYPES[key];
            const on = type === key;
            return (
              <button key={key} onClick={() => setType(key)} aria-pressed={on}
                style={{ ...styles.typePill, ...(on ? { background: ty.chipBg, borderColor: ty.color, color: ty.color } : {}) }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: ty.color, opacity: on ? 1 : 0.55 }} />
                {ty.label}
              </button>
            );
          })}
        </div>
        <div style={styles.addRow}>
          <input
            className="field" style={styles.addInput} value={text}
            placeholder={`Add ${typeOf(type).label.toLowerCase()}…`} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()} aria-label="Name"
          />
          <button className="addbtn" style={styles.addBtn} onClick={submit} aria-label="Add"><Plus size={20} /></button>
        </div>
        <div style={styles.dueRow}>
          <span style={styles.dueLabel}>Due</span>
          <button onClick={() => setDue(due === today ? "" : today)}
            style={{ ...styles.dueQuick, ...(due === today ? styles.dueQuickOn : {}) }}>Today</button>
          <button onClick={() => setDue(due === tomorrow ? "" : tomorrow)}
            style={{ ...styles.dueQuick, ...(due === tomorrow ? styles.dueQuickOn : {}) }}>Tomorrow</button>
          <label style={styles.datePick}>
            <CalIcon size={14} color="#8A6A3A" />
            <input className="field-inline" type="date" value={due}
              onChange={(e) => setDue(e.target.value)} aria-label="Pick due date" style={styles.datePickInput} />
          </label>
          {due && <button onClick={() => setDue("")} style={styles.dueClear} aria-label="Clear due date"><X size={13} /> {prettyDate(due)}</button>}
        </div>
      </div>

      <div style={styles.tasksBody}>
        {view === "calendar" ? (
          <CalendarView tasks={tasks} onPickDate={(d) => { setDue(d); }} />
        ) : isEmpty ? (
          <div style={styles.emptyTasks}>
            <Logo size={56} />
            <p style={{ margin: "16px 0 4px", fontFamily: "Fraunces, serif", fontSize: 19 }}>Your desk is clear.</p>
            <p style={styles.muted}>Add an assignment, task, or exam above. Finish it, and a poem is bound into your library.</p>
          </div>
        ) : (
          <>
            {nextUp && filter === "all" && (
              <NextUp task={nextUp} today={today} binding={bindingId === nextUp.id} onComplete={() => onComplete(nextUp)} />
            )}

            <div style={styles.filterRow}>
              {["all", ...TYPE_ORDER].map((f) => {
                const on = filter === f;
                const c = f === "all" ? "var(--gold)" : TYPES[f].color;
                const label = f === "all" ? "All" : TYPES[f].label;
                return (
                  <button key={f} onClick={() => setFilter(f)}
                    style={{ ...styles.filterChip, ...(on ? { color: c, borderColor: c, background: f === "all" ? "rgba(214,180,92,0.14)" : TYPES[f].chipBg } : {}) }}>
                    {label}
                  </button>
                );
              })}
            </div>

            {shownActive.length === 0 && shownDone.length === 0 ? (
              <div style={{ ...styles.muted, textAlign: "center", padding: "28px 20px" }}>Nothing in this tier yet.</div>
            ) : (
              <>
                {shownActive.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} binding={bindingId === t.id}
                    onComplete={() => onComplete(t)} onDelete={() => onDelete(t.id)} />
                ))}
                {shownDone.length > 0 && (
                  <>
                    <div style={styles.sectionLabel}>Bound · {shownDone.length}</div>
                    {shownDone.map((t) => (
                      <TaskRow key={t.id} task={t} today={today} onReopen={() => onReopen(t.id)} onDelete={() => onDelete(t.id)} />
                    ))}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function countdown(due, today) {
  const d = Math.round((parseKey(due) - parseKey(today)) / 86400000);
  if (d < 0) return { text: `Overdue by ${Math.abs(d)} day${Math.abs(d) > 1 ? "s" : ""}`, tone: "over" };
  if (d === 0) return { text: "Due today", tone: "soon" };
  if (d === 1) return { text: "Due tomorrow", tone: "soon" };
  return { text: `In ${d} days`, tone: d <= 3 ? "soon" : "later" };
}

function NextUp({ task, today, binding, onComplete }) {
  const ty = typeOf(task.type);
  const cd = countdown(task.due, today);
  const toneColor = { over: "#E0736B", soon: "var(--gold-bright)", later: "rgba(236,227,208,0.6)" }[cd.tone];
  return (
    <div style={{ ...styles.nextUp, borderColor: `${ty.color}66` }}>
      <button className="check" onClick={onComplete} disabled={binding}
        aria-label="Complete" style={{ ...styles.check, ...(binding ? styles.checkBinding : {}) }}>
        {binding ? <span className="spin" style={styles.spinner} /> : null}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={styles.nextUpEyebrow}>Next up</div>
        <div style={styles.nextUpText}>{task.text}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <span style={{ ...styles.typeChip, color: ty.color, background: ty.chipBg }}>{ty.label}</span>
        <div style={{ ...styles.nextUpCount, color: toneColor }}>{binding ? "Binding…" : cd.text}</div>
      </div>
    </div>
  );
}

function dueMeta(due, done, today) {
  if (!due) return { label: "No date", tone: "muted" };
  if (done) return { label: prettyDate(due), tone: "muted" };
  if (due < today) return { label: "Overdue", tone: "over" };
  if (due === today) return { label: "Due today", tone: "soon" };
  const diff = (parseKey(due) - parseKey(today)) / 86400000;
  if (diff <= 3) return { label: `Due ${prettyDate(due)}`, tone: "soon" };
  return { label: prettyDate(due), tone: "later" };
}

function TaskRow({ task, today, binding, onComplete, onDelete, onReopen }) {
  const meta = dueMeta(task.due, task.done, today);
  const ty = typeOf(task.type);
  const toneColor = { over: "#E0736B", soon: "var(--gold-bright)", later: "rgba(236,227,208,0.55)", muted: "rgba(236,227,208,0.4)" }[meta.tone];
  return (
    <div style={{ ...styles.taskRow, borderLeft: `3px solid ${task.done ? "rgba(236,227,208,0.15)" : ty.color}`, opacity: task.done ? 0.6 : 1 }}>
      <button
        className="check" onClick={task.done ? onReopen : onComplete} disabled={binding}
        aria-label={task.done ? "Reopen task" : "Complete task"}
        style={{ ...styles.check, ...(task.done ? styles.checkDone : {}), ...(binding ? styles.checkBinding : {}) }}
      >
        {binding ? <span className="spin" style={styles.spinner} /> : task.done ? <Check size={16} /> : null}
      </button>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ ...styles.taskText, textDecoration: task.done ? "line-through" : "none" }}>{task.text}</div>
        <div style={styles.taskMetaRow}>
          <span style={{ ...styles.typeChip, color: ty.color, background: ty.chipBg }}>{ty.label}</span>
          <span style={{ ...styles.taskDue, color: toneColor }}>
            {binding ? "Binding its poem…" : meta.label}
          </span>
        </div>
      </div>

      <button className="iconbtn" style={styles.taskDelete} onClick={onDelete} aria-label="Delete task"><Trash2 size={15} /></button>
    </div>
  );
}

function CalendarView({ tasks, onPickDate }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState(toKey(new Date()));
  const today = toKey(new Date());

  const byDay = useMemo(() => {
    const map = {};
    tasks.forEach((t) => {
      if (!t.due) return;
      const e = (map[t.due] ||= { open: 0, done: 0, topRank: -1, topType: "task" });
      if (t.done) { e.done++; return; }
      e.open++;
      const r = typeOf(t.type).rank;
      if (r > e.topRank) { e.topRank = r; e.topType = t.type || "task"; }
    });
    return map;
  }, [tasks]);

  const first = new Date(cursor.y, cursor.m, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const cells = Array.from({ length: 42 }).map((_, i) => {
    const d = new Date(cursor.y, cursor.m, 1 - startOffset + i);
    return d;
  });
  const monthLabel = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];

  const step = (n) => setCursor((c) => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const selectedTasks = tasks.filter((t) => t.due === selected).sort((a, b) => Number(a.done) - Number(b.done));

  return (
    <div style={styles.calWrap}>
      <div style={styles.calHead}>
        <button className="iconbtn" style={styles.calArrow} onClick={() => step(-1)} aria-label="Previous month"><ChevronLeft size={18} /></button>
        <div style={styles.calMonth}>{monthLabel}</div>
        <button className="iconbtn" style={styles.calArrow} onClick={() => step(1)} aria-label="Next month"><ChevronRight size={18} /></button>
      </div>

      <div style={styles.calGridHead}>
        {dayNames.map((d, i) => <div key={i} style={styles.calDayName}>{d}</div>)}
      </div>

      <div style={styles.calGrid}>
        {cells.map((d, i) => {
          const k = toKey(d);
          const inMonth = d.getMonth() === cursor.m;
          const info = byDay[k];
          const isToday = k === today;
          const isSel = k === selected;
          const overdue = info && info.open > 0 && k < today;
          return (
            <button key={i} onClick={() => { setSelected(k); onPickDate(k); }}
              style={{
                ...styles.calCell,
                color: inMonth ? "var(--paper)" : "rgba(236,227,208,0.22)",
                background: isSel ? "rgba(214,180,92,0.16)" : "transparent",
                border: isSel ? "1px solid var(--gold)" : "1px solid transparent",
                boxShadow: isToday && !isSel ? "inset 0 0 0 1px rgba(236,227,208,0.28)" : "none",
              }}>
              <span>{d.getDate()}</span>
              {info && (
                <span style={{
                  ...styles.calDot,
                  background: info.open > 0 ? typeOf(info.topType).color : "rgba(236,227,208,0.35)",
                  boxShadow: overdue ? "0 0 0 2px rgba(224,115,107,0.45)" : "none",
                }} />
              )}
            </button>
          );
        })}
      </div>

      <div style={styles.calSelectedHead}>Due {parseKey(selected).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</div>
      {selectedTasks.length === 0 ? (
        <div style={{ ...styles.muted, padding: "6px 2px 4px" }}>Nothing due this day. Add a task above — this date is set for you.</div>
      ) : (
        selectedTasks.map((t) => {
          const ty = typeOf(t.type);
          return (
            <div key={t.id} style={styles.calTaskRow}>
              <span style={{ ...styles.calTaskDotBig, background: t.done ? "rgba(236,227,208,0.35)" : ty.color }} />
              <span style={{ textDecoration: t.done ? "line-through" : "none", opacity: t.done ? 0.6 : 1, flex: 1, minWidth: 0 }}>{t.text}</span>
              <span style={{ ...styles.typeChip, color: ty.color, background: ty.chipBg }}>{ty.label}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

/* ================================================================== *
 *  STYLES
 * ================================================================== */
const styles = {
  root: {
    "--ink": "#12161C", "--paper": "#ECE3D0", "--paper2": "#E1D5BC",
    "--gold": "#D6B45C", "--gold-bright": "#EFD68F",
    fontFamily: "Inter, system-ui, sans-serif", color: "var(--paper)",
  },
  screen: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },

  splash: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 30, background: "radial-gradient(circle at 50% 38%, #1A2038, #10141C 70%)" },
  splashWord: { fontFamily: "Fraunces, serif", fontSize: 34, fontWeight: 600, color: "var(--paper)", marginTop: 18, letterSpacing: "0.01em" },
  splashTag: { fontFamily: "Fraunces, serif", fontStyle: "italic", fontSize: 14, color: "rgba(236,227,208,0.55)", marginTop: 6 },

  nav: {
    display: "flex", borderTop: "1px solid rgba(214,180,92,0.14)",
    background: "rgba(10,13,18,0.86)", backdropFilter: "blur(10px)",
    padding: "8px 0 calc(8px + env(safe-area-inset-bottom))",
  },
  tabBtn: {
    flex: 1, background: "none", border: "none", cursor: "pointer",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
    padding: "6px 0", position: "relative", transition: "color .2s",
  },
  tabBadge: {
    position: "absolute", top: -6, right: -12, minWidth: 16, height: 16, padding: "0 4px",
    borderRadius: 8, background: "var(--gold)", color: "#1a130a", fontSize: 10, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, sans-serif",
  },
  tabDot: { position: "absolute", bottom: -2, width: 4, height: 4, borderRadius: "50%", background: "var(--gold-bright)" },

  eyebrow: { fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "rgba(214,180,92,0.75)", fontWeight: 600 },

  /* library */
  library: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  libHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-end",
    padding: "18px 20px 12px", borderBottom: "1px solid rgba(214,180,92,0.12)",
    background: "linear-gradient(180deg,#0E1330,#141A22)",
  },
  libCount: { fontFamily: "Fraunces, serif", fontSize: 20, marginTop: 3, color: "var(--paper)" },
  libDivider: { margin: "0 8px", color: "rgba(214,180,92,0.6)" },
  libScroll: { flex: 1, overflowY: "auto", background: "linear-gradient(180deg,#0B1026 0%,#141328 42%,#241C2A 74%,#2A211C 100%)" },

  sky: { position: "relative", height: 150, overflow: "hidden" },
  moon: {
    position: "absolute", top: 26, right: 34, width: 52, height: 52, borderRadius: "50%",
    background: "radial-gradient(circle at 36% 34%, #FBF3DA, #E8D49B 60%, #C9AE6A)",
    boxShadow: "0 0 40px rgba(233,207,134,0.35), inset -6px -6px 0 rgba(160,132,74,0.25)",
  },
  skyBottom: { position: "absolute", bottom: 12, left: 20, right: 20 },
  skyCaption: { fontFamily: "Fraunces, serif", fontStyle: "italic", fontSize: 13, color: "rgba(236,227,208,0.62)", maxWidth: 260, lineHeight: 1.4 },
  progressTrack: { marginTop: 8, height: 4, borderRadius: 4, background: "rgba(236,227,208,0.12)", overflow: "hidden", maxWidth: 180 },
  progressFill: { height: "100%", borderRadius: 4, background: "linear-gradient(90deg, var(--gold), var(--gold-bright))", transition: "width .5s ease" },
  skySub: { marginTop: 8, fontSize: 11.5, color: "rgba(236,227,208,0.4)", fontStyle: "italic", fontFamily: "Fraunces, serif", maxWidth: 260, lineHeight: 1.4 },
  tally: { display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" },
  tallyItem: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "rgba(236,227,208,0.7)", fontWeight: 600, fontFamily: "Inter, sans-serif" },
  tallyDot: { width: 8, height: 8, borderRadius: "50%" },

  tower: { padding: "0 16px 8px", display: "flex", flexDirection: "column" },
  shelfWrap: { position: "relative", marginBottom: 2 },
  shelfBooks: {
    display: "flex", alignItems: "flex-end", gap: 8, minHeight: 178,
    padding: "0 10px 0", position: "relative", zIndex: 2,
  },
  emptySlot: {
    width: 48, height: 76, borderRadius: "2px 2px 0 0",
    border: "1px dashed rgba(236,227,208,0.14)", borderBottom: "none",
    background: "repeating-linear-gradient(90deg, rgba(236,227,208,0.02) 0 6px, transparent 6px 12px)",
  },
  plank: { position: "relative", height: 18, marginTop: -2, zIndex: 1 },
  plankFace: {
    height: 12, background: "linear-gradient(180deg,#6B4A2C,#4A3320)",
    boxShadow: "inset 0 2px 0 rgba(255,225,180,0.12), 0 6px 10px rgba(0,0,0,0.4)",
    borderRadius: "1px",
  },
  plankEdge: { height: 6, background: "linear-gradient(180deg,#3A2817,#2A1D10)", borderRadius: "0 0 2px 2px" },
  floor: { height: 24, marginTop: 4, background: "linear-gradient(180deg,#2A1D10,#1c130a)", borderRadius: "2px" },

  emptyNote: { textAlign: "center", padding: "18px 24px 8px", fontFamily: "Fraunces, serif", fontSize: 15, color: "rgba(236,227,208,0.7)", lineHeight: 1.5 },

  spine: {
    position: "relative", border: "none", cursor: "pointer", borderRadius: "2px 2px 0 0",
    padding: 0, overflow: "hidden", flexShrink: 0,
    boxShadow: "inset -3px 0 6px rgba(0,0,0,0.35), inset 3px 0 4px rgba(255,255,255,0.06), 0 4px 8px rgba(0,0,0,0.35)",
    transition: "transform .16s ease",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between",
  },
  spineSheen: { position: "absolute", inset: 0, background: "linear-gradient(120deg, transparent 40%, rgba(239,214,143,0.16) 50%, transparent 60%)", pointerEvents: "none", zIndex: 1 },
  spineGem: { position: "absolute", top: 6, left: "50%", transform: "translateX(-50%) rotate(45deg)", width: 7, height: 7, background: "linear-gradient(135deg,#F7E9BE,#D6B45C)", boxShadow: "0 0 6px rgba(239,214,143,0.7)", zIndex: 2 },
  spineGlyph: { position: "absolute", top: 26, left: 0, right: 0, textAlign: "center", fontSize: 11, color: "rgba(247,233,190,0.88)", zIndex: 2, textShadow: "0 1px 2px rgba(0,0,0,0.45)" },
  spineMark: { position: "absolute", top: 2, right: 4, fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", writingMode: "vertical-rl", textOrientation: "upright", zIndex: 2, opacity: 0.9 },
  spineBandTop: { position: "absolute", left: "14%", width: "72%", height: 2, marginTop: 12, background: "rgba(214,180,92,0.75)", borderRadius: 2, zIndex: 2 },
  spineBandBottom: { position: "absolute", left: "14%", width: "72%", height: 2, marginBottom: 12, background: "rgba(214,180,92,0.75)", borderRadius: 2, zIndex: 2 },
  spineTitle: {
    writingMode: "vertical-rl", textOrientation: "mixed", fontFamily: "Fraunces, serif",
    fontSize: 12.5, letterSpacing: "0.04em", color: "rgba(245,236,214,0.94)",
    maxHeight: "64%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    textShadow: "0 1px 2px rgba(0,0,0,0.5)", fontWeight: 500, padding: "0 2px",
  },

  /* modal */
  overlay: {
    position: "fixed", inset: 0, background: "rgba(6,8,12,0.82)", backdropFilter: "blur(4px)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 18, zIndex: 60,
  },
  page: {
    position: "relative", width: "100%", maxWidth: 380, maxHeight: "86vh",
    background: "linear-gradient(135deg,#F1E8D5,#E3D6BA)", borderRadius: 6,
    boxShadow: "0 30px 70px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(120,90,50,0.25)",
    display: "flex", flexDirection: "column", overflow: "hidden",
    borderLeft: "6px solid #6E2B2B",
  },
  pageInner: { padding: "34px 28px 20px", overflowY: "auto", flex: 1 },
  pageClose: {
    position: "absolute", top: 10, right: 10, width: 34, height: 34, borderRadius: "50%",
    border: "none", background: "rgba(60,40,20,0.08)", color: "#3A2817", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
  },
  pageEyebrow: { fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#8A6A3A", fontWeight: 600, lineHeight: 1.5 },
  pageRarity: { display: "flex", alignItems: "center", gap: 9, marginTop: 9 },
  rarityChip: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 6, border: "1px solid", fontFamily: "Inter, sans-serif" },
  pageMaterial: { fontSize: 12.5, fontStyle: "italic", color: "#8A7350", fontFamily: "Fraunces, serif" },
  pageTitle: { fontFamily: "Fraunces, serif", fontSize: 28, lineHeight: 1.15, margin: "8px 0 0", color: "#2A1C10", fontWeight: 600 },
  pageRule: { width: 44, height: 2, background: "#B98F47", margin: "16px 0 18px" },
  poem: { fontFamily: "Fraunces, serif", fontSize: 17.5, lineHeight: 1.72, whiteSpace: "pre-wrap", color: "#33261A" },
  colophon: { marginTop: 22, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#9A7B4C" },
  pageActions: { marginTop: 18, display: "flex", justifyContent: "flex-start" },
  deleteBookBtn: {
    border: "1px solid rgba(185,68,54,0.3)",
    background: "rgba(185,68,54,0.08)",
    color: "#8A2E25",
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "Inter, sans-serif",
  },
  pageNav: { display: "flex", justifyContent: "space-between", padding: "10px 14px", borderTop: "1px solid rgba(120,90,50,0.2)", background: "rgba(120,90,50,0.05)" },
  navArrow: { width: 40, height: 40, borderRadius: "50%", border: "none", background: "rgba(60,40,20,0.08)", color: "#3A2817", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },

  /* celebration */
  celebrate: { position: "fixed", inset: 0, background: "radial-gradient(circle at 50% 40%, rgba(20,16,32,0.9), rgba(6,8,12,0.96))", zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, cursor: "pointer" },
  celebInner: { textAlign: "center", maxWidth: 320 },
  celebEyebrow: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--gold-bright)", fontWeight: 600, marginBottom: 20 },
  celebSpine: {
    width: 74, height: 168, margin: "0 auto 22px", borderRadius: "3px 3px 0 0",
    display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden",
    boxShadow: "inset -3px 0 6px rgba(0,0,0,0.4), 0 12px 30px rgba(0,0,0,0.5)",
    borderTop: "2px solid rgba(214,180,92,0.7)", borderBottom: "2px solid rgba(214,180,92,0.7)",
  },
  celebTitle: { fontFamily: "Fraunces, serif", fontSize: 26, color: "var(--paper)", margin: "0 0 12px", fontWeight: 600 },
  celebRarity: { fontSize: 12.5, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 14 },
  celebLine: { fontFamily: "Fraunces, serif", fontStyle: "italic", fontSize: 16, color: "rgba(236,227,208,0.75)", lineHeight: 1.5, margin: "0 0 20px" },
  celebCaption: { fontSize: 13, letterSpacing: "0.08em", color: "var(--gold)", textTransform: "uppercase", fontWeight: 600 },
  celebHint: { fontSize: 12, color: "rgba(236,227,208,0.4)", marginTop: 14 },

  /* auth */
  authShell: {
    position: "relative", flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center",
    padding: 18, overflow: "hidden", background: "radial-gradient(circle at top, #182041 0%, #10141C 48%, #0B0E13 100%)",
  },
  authGlow: {
    position: "absolute", inset: "auto auto -120px -120px", width: 280, height: 280, borderRadius: "50%",
    background: "radial-gradient(circle, rgba(214,180,92,0.18), rgba(214,180,92,0))", filter: "blur(4px)", pointerEvents: "none",
  },
  authCard: {
    position: "relative", width: "100%", maxWidth: 390, borderRadius: 28, padding: 26,
    background: "linear-gradient(180deg, rgba(241,232,213,0.98), rgba(225,213,188,0.96))",
    color: "#2A1C10", boxShadow: "0 30px 80px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(120,90,50,0.16)",
  },
  authMark: { display: "flex", justifyContent: "center", marginBottom: 10 },
  authKicker: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: "0.24em", textTransform: "uppercase", color: "#8A6A3A", fontWeight: 700 },
  authTitle: { fontFamily: "Fraunces, serif", fontSize: 28, lineHeight: 1.1, margin: "10px 0 10px", color: "#2A1C10", fontWeight: 600 },
  authCopy: { margin: 0, fontSize: 14.5, lineHeight: 1.6, color: "#5E4A30" },
  authTabs: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginTop: 18 },
  authTab: { border: "1px solid rgba(120,90,50,0.16)", background: "rgba(255,255,255,0.32)", color: "#6E5A3D", borderRadius: 12, padding: "10px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  authTabActive: { background: "rgba(214,180,92,0.18)", borderColor: "rgba(214,180,92,0.5)", color: "#7E5A11" },
  authForm: { display: "grid", gap: 12, marginTop: 16 },
  authLabel: { display: "grid", gap: 6, fontSize: 12.5, fontWeight: 700, color: "#6E5A3D" },
  authInput: { width: "100%" },
  authError: { borderRadius: 12, padding: "10px 12px", background: "rgba(185,68,54,0.10)", color: "#8A2E25", fontSize: 13, lineHeight: 1.4 },
  authSubmit: { width: "100%", justifyContent: "center", marginTop: 2 },
  authLink: { border: "none", background: "none", color: "#8A6A3A", fontSize: 12.5, fontWeight: 700, cursor: "pointer", padding: 0 },
  authFooter: { marginTop: 14, fontSize: 12, color: "#826C4C" },
  envList: { display: "grid", gap: 8, marginTop: 14 },
  envItem: { borderRadius: 10, padding: "10px 12px", background: "rgba(214,180,92,0.12)", color: "#6E5A3D", fontSize: 13, fontFamily: "Inter, sans-serif", fontWeight: 600 },

  /* user chrome */
  userBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px 0" },
  userPill: { display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, padding: "8px 12px", borderRadius: 999, background: "rgba(236,227,208,0.08)", color: "rgba(236,227,208,0.86)", fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  userDot: { width: 8, height: 8, borderRadius: "50%", background: "#8FB0A6", boxShadow: "0 0 0 3px rgba(143,176,166,0.14)" },
  signOutBtn: { border: "1px solid rgba(236,227,208,0.12)", background: "rgba(236,227,208,0.04)", color: "rgba(236,227,208,0.72)", borderRadius: 999, padding: "8px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  syncBanner: { margin: "10px 16px 0", borderRadius: 12, padding: "10px 12px", background: "rgba(214,180,92,0.14)", color: "var(--gold-bright)", fontSize: 12.5, lineHeight: 1.4 },

  /* tasks */
  tasks: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  tasksHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "18px 20px 6px" },
  tasksTitle: { fontFamily: "Fraunces, serif", fontSize: 26, margin: "3px 0 0", fontWeight: 600 },
  segment: { display: "flex", gap: 2, background: "rgba(236,227,208,0.06)", borderRadius: 10, padding: 3 },
  segBtn: { display: "flex", alignItems: "center", gap: 5, border: "none", background: "none", color: "rgba(236,227,208,0.55)", fontFamily: "Inter, sans-serif", fontSize: 12.5, fontWeight: 600, padding: "6px 10px", borderRadius: 8, cursor: "pointer" },
  segActive: { background: "rgba(214,180,92,0.18)", color: "var(--gold-bright)" },

  masthead: { padding: "18px 20px 4px" },
  brandRow: { display: "flex", alignItems: "center", gap: 12 },
  wordmark: { fontFamily: "Fraunces, serif", fontSize: 26, fontWeight: 600, color: "var(--paper)", lineHeight: 1 },
  tagline: { fontFamily: "Fraunces, serif", fontStyle: "italic", fontSize: 12.5, color: "rgba(236,227,208,0.5)", marginTop: 3 },
  segmentWrap: { padding: "12px 18px 4px" },

  dueRow: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" },
  dueLabel: { fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(214,180,92,0.7)", fontWeight: 600, marginRight: 2 },
  dueQuick: { border: "1px solid rgba(236,227,208,0.12)", background: "rgba(236,227,208,0.04)", color: "rgba(236,227,208,0.6)", fontSize: 12.5, fontWeight: 600, padding: "6px 11px", borderRadius: 9, cursor: "pointer", fontFamily: "Inter, sans-serif" },
  dueQuickOn: { background: "rgba(214,180,92,0.16)", borderColor: "var(--gold)", color: "var(--gold-bright)" },
  datePick: { display: "inline-flex", alignItems: "center", gap: 5, background: "#F1E8D5", border: "1px solid rgba(120,90,50,0.25)", borderRadius: 9, padding: "5px 9px", cursor: "pointer" },
  datePickInput: { border: "none", background: "transparent", outline: "none", fontFamily: "Inter, sans-serif", fontSize: 12.5, color: "#2A1C10", colorScheme: "light", width: 26, padding: 0 },
  dueClear: { display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "rgba(214,180,92,0.16)", color: "var(--gold-bright)", fontSize: 12.5, fontWeight: 600, padding: "6px 10px", borderRadius: 9, cursor: "pointer", fontFamily: "Inter, sans-serif" },

  filterRow: { display: "flex", gap: 7, padding: "2px 2px 12px", flexWrap: "wrap" },
  filterChip: { border: "1px solid rgba(236,227,208,0.12)", background: "rgba(236,227,208,0.03)", color: "rgba(236,227,208,0.5)", fontSize: 12.5, fontWeight: 600, padding: "6px 13px", borderRadius: 20, cursor: "pointer", fontFamily: "Inter, sans-serif", transition: "all .15s" },

  nextUp: { display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", borderRadius: 14, background: "linear-gradient(180deg, rgba(236,227,208,0.07), rgba(236,227,208,0.03))", border: "1px solid rgba(214,180,92,0.4)", marginBottom: 14 },
  nextUpEyebrow: { fontSize: 10.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(214,180,92,0.8)", fontWeight: 700, marginBottom: 3 },
  nextUpText: { fontFamily: "Fraunces, serif", fontSize: 17, color: "var(--paper)", lineHeight: 1.25, wordBreak: "break-word" },
  nextUpCount: { fontSize: 12, fontWeight: 600, marginTop: 5 },

  addWrap: { padding: "10px 18px 14px", display: "flex", flexDirection: "column", gap: 9 },
  typePicker: { display: "flex", gap: 6 },
  typePill: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 6px", borderRadius: 10, border: "1px solid rgba(236,227,208,0.1)", background: "rgba(236,227,208,0.04)", color: "rgba(236,227,208,0.55)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "Inter, sans-serif", transition: "all .15s" },
  addRow: { display: "flex", gap: 8, alignItems: "center" },
  typeChip: { fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 6, flexShrink: 0, fontFamily: "Inter, sans-serif" },
  taskMetaRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 5 },
  addInput: { flex: 1, minWidth: 0 },
  dateInput: { width: 44, flexShrink: 0, colorScheme: "light" },
  addBtn: { width: 44, height: 44, flexShrink: 0, borderRadius: 12, border: "none", background: "var(--gold)", color: "#1a130a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },

  tasksBody: { flex: 1, overflowY: "auto", padding: "0 14px 20px" },

  taskRow: { display: "flex", alignItems: "center", gap: 12, padding: "13px 12px", borderRadius: 12, background: "rgba(236,227,208,0.035)", marginBottom: 7, border: "1px solid rgba(236,227,208,0.06)" },
  check: { width: 26, height: 26, flexShrink: 0, borderRadius: 8, border: "1.5px solid rgba(214,180,92,0.5)", background: "transparent", color: "#1a130a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .18s" },
  checkDone: { background: "var(--gold)", borderColor: "var(--gold)" },
  checkBinding: { borderColor: "var(--gold)", cursor: "wait" },
  spinner: { width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(214,180,92,0.35)", borderTopColor: "var(--gold)", display: "block" },
  taskText: { fontSize: 15.5, color: "var(--paper)", lineHeight: 1.35, wordBreak: "break-word" },
  taskDue: { fontSize: 12, marginTop: 3, fontWeight: 600, letterSpacing: "0.02em" },
  taskDelete: { width: 32, height: 32, flexShrink: 0, borderRadius: 8, border: "none", background: "transparent", color: "rgba(236,227,208,0.35)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },

  sectionLabel: { fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(214,180,92,0.65)", fontWeight: 600, padding: "16px 6px 8px" },
  emptyTasks: { textAlign: "center", padding: "48px 30px" },
  muted: { color: "rgba(236,227,208,0.5)", fontSize: 13.5, lineHeight: 1.55 },

  /* calendar */
  calWrap: { padding: "4px 4px 6px" },
  calHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px 12px" },
  calMonth: { fontFamily: "Fraunces, serif", fontSize: 18, fontWeight: 600 },
  calArrow: { width: 34, height: 34, borderRadius: 10, border: "none", background: "rgba(236,227,208,0.06)", color: "var(--paper)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  calGridHead: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", marginBottom: 4 },
  calDayName: { textAlign: "center", fontSize: 11, letterSpacing: "0.05em", color: "rgba(236,227,208,0.4)", fontWeight: 600, padding: "2px 0" },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 },
  calCell: { aspectRatio: "1 / 1", borderRadius: 9, cursor: "pointer", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13.5, fontFamily: "Inter, sans-serif", background: "transparent" },
  calDot: { position: "absolute", bottom: 5, width: 5, height: 5, borderRadius: "50%" },
  calSelectedHead: { fontFamily: "Fraunces, serif", fontSize: 15, fontWeight: 600, padding: "18px 4px 8px", borderTop: "1px solid rgba(236,227,208,0.08)", marginTop: 12, color: "var(--paper)" },
  calTaskRow: { display: "flex", alignItems: "center", gap: 10, padding: "9px 6px", fontSize: 14.5, color: "var(--paper)" },
  calTaskDotBig: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
};

/* ---------- global CSS: fonts, motion, focus, scrollbars ---------- */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Inter:wght@400;500;600;700&display=swap');

* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
#root, #app { height: 100%; }

/* ---- responsive shell: full-screen on phones, app card on larger screens ---- */
.app-root { min-height: 100vh; display: flex; justify-content: center; align-items: stretch; background: #0B0E13; }
.app-phone {
  position: relative; width: 100%; max-width: 460px; height: 100vh;
  display: flex; flex-direction: column; overflow: hidden;
  background: linear-gradient(180deg,#151A21 0%,#12161C 100%);
}
@supports (height: 100dvh) {
  .app-root { min-height: 100dvh; }
  .app-phone { height: 100dvh; }
}
@media (min-width: 600px) {
  .app-root { align-items: center; padding: 24px; }
  .app-phone {
    height: min(calc(100vh - 48px), 940px);
    border-radius: 30px;
    box-shadow: 0 30px 90px rgba(0,0,0,0.55), 0 0 0 1px rgba(214,180,92,0.12);
  }
}
@media (min-width: 600px) {
  @supports (height: 100dvh) { .app-phone { height: min(calc(100dvh - 48px), 940px); } }
}
button:focus-visible, .field:focus-visible, .tabbtn:focus-visible {
  outline: 2px solid var(--gold-bright); outline-offset: 2px;
}
.field {
  background: #F1E8D5; color: #2A1C10; border: 1px solid rgba(120,90,50,0.25);
  border-radius: 12px; padding: 12px 14px; font-size: 15px; font-family: Inter, sans-serif;
  outline: none; transition: border-color .15s, box-shadow .15s;
}
.field::placeholder { color: #9A855F; }
.field:focus { border-color: #C89B3C; box-shadow: 0 0 0 3px rgba(200,155,60,0.18); }

.spine:hover, .spine:focus-visible { transform: translateY(-3px); }
.spine-fresh { animation: drop .55s cubic-bezier(.2,.9,.3,1.2) both; }
@keyframes drop { 0% { transform: translateY(-140px) rotate(-4deg); opacity: 0; } 70% { transform: translateY(4px) rotate(0); } 100% { transform: translateY(0); opacity: 1; } }

.rise { animation: rise .55s cubic-bezier(.2,.8,.3,1) both; }
@keyframes rise { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.shimmer::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(115deg, transparent 30%, rgba(255,245,210,0.55) 50%, transparent 70%);
  transform: translateX(-120%); animation: shim 2.4s ease-in-out .3s infinite;
}
@keyframes shim { to { transform: translateX(120%); } }

.book-open { animation: openbook .34s cubic-bezier(.2,.8,.3,1) both; }
@keyframes openbook { from { transform: scale(.9) translateY(14px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }

.screen-fade { animation: screenIn .3s cubic-bezier(.2,.8,.3,1) both; }
@keyframes screenIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

.field-inline:focus { outline: none; }
.dueQuick:hover, .filterChip:hover { filter: brightness(1.25); }

.spin { animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.addbtn:hover { filter: brightness(1.06); }
.iconbtn:hover { filter: brightness(1.1); }
.check:hover { border-color: var(--gold-bright); }
.tabbtn { -webkit-tap-highlight-color: transparent; }

.lib-scroll::-webkit-scrollbar, .tasksBody::-webkit-scrollbar { width: 8px; }
.lib-scroll::-webkit-scrollbar-thumb { background: rgba(214,180,92,0.25); border-radius: 8px; }

@media (prefers-reduced-motion: reduce) {
  *, *::after { animation: none !important; transition: none !important; }
}
`;
