import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { BookOpen, Plus, X, ChevronLeft, ChevronRight, Trash2, Moon, Sparkles, Check, Calendar as CalIcon, List as ListIcon, Settings as SettingsIcon, Clock, ListChecks, Pencil } from "lucide-react";
import {
  createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut,
  updateProfile, updateEmail, updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from "firebase/auth";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, setDoc } from "firebase/firestore";
import { auth, db, configureAuthPersistence, firebaseReady, getFirebaseConfigStatus } from "./src/firebase.js";
import {
  TIERS as RARITY, TIER_RANK as RARITY_RANK, tierOf as rarityOf, migrateLegacyRarity,
  generateBook, generateSubtaskPage as generateBookSubtaskPage,
} from "./src/bookGenerator.js";

/* ------------------------------------------------------------------ *
 *  Bindary — finish a task, and its poem is bound into your library.
 *  Two screens: the growing bookcase, and the tasks + deadline calendar.
 * ------------------------------------------------------------------ */

const SHELF_CAPACITY = 5; // fallback used before the shelf's real width has been measured
/* a spine (Spine's `width`) plus the shelfBooks row's `gap` — kept in one place so the
   capacity math below and the actual rendered spines can never drift apart */
const SPINE_WIDTH = 52;
const SPINE_GAP = 8;
/* how many spines fit across a shelf of this many pixels? shelfBooks reserves 20px of its
   own horizontal padding (10px each side) beyond whatever the caller already measured */
function shelfCapacityForWidth(width) {
  if (!width) return SHELF_CAPACITY;
  const usable = width - 20;
  return Math.max(1, Math.floor((usable + SPINE_GAP) / (SPINE_WIDTH + SPINE_GAP)));
}
/* tracks an element's rendered content width so the shelf can pack in as many books as
   actually fit, instead of stopping at a fixed count and leaving the rest of the row empty */
function useElementWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    setWidth(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/* ---------- legacy cloth palette — kept only so books bound before the v2 generator still render ---------- */
const LEGACY_CLOTHS = [
  { bg: "#6E2B2B", cap: "#521E1E" }, { bg: "#2C4A3B", cap: "#1F3529" }, { bg: "#26374F", cap: "#1A2839" },
  { bg: "#4A2F52", cap: "#35213B" }, { bg: "#7A3E24", cap: "#5A2C18" }, { bg: "#21514E", cap: "#173B39" },
  { bg: "#3A4351", cap: "#29303B" }, { bg: "#5C5323", cap: "#433C18" }, { bg: "#5A2540", cap: "#3F1A2D" },
  { bg: "#2A2E5A", cap: "#1D2040" }, { bg: "#3E4A2A", cap: "#2B341C" }, { bg: "#6E5230", cap: "#4E3A20" },
  { bg: "#432A4A", cap: "#301D36" }, { bg: "#1F4148", cap: "#142E33" }, { bg: "#8A4A34", cap: "#652F1F" },
  { bg: "#4E2A2E", cap: "#371D20" }, { bg: "#2E4633", cap: "#203223" }, { bg: "#3A3A46", cap: "#282833" },
];
/* a book's cloth colors: the v2 generator resolves them per-genre and stores them directly on the book */
const clothOf = (book) => (book.clothBg ? { bg: book.clothBg, cap: book.clothCap } : LEGACY_CLOTHS[(book.color || 0) % LEGACY_CLOTHS.length]);

/* ---------- importance tiers ---------- */
const TYPES = {
  daily:      { label: "Daily",      color: "#7FB0D9", chipBg: "rgba(127,176,217,0.16)",  rank: 3 },
  task:       { label: "Task",       color: "#8FB0A6", chipBg: "rgba(143,176,166,0.16)", rank: 0 },
  assignment: { label: "Assignment", color: "#D6B45C", chipBg: "rgba(214,180,92,0.16)",  rank: 1 },
  exam:       { label: "Exam",       color: "#D9736A", chipBg: "rgba(217,115,106,0.16)",  rank: 2 },
};
const TYPE_ORDER = ["daily", "task", "assignment", "exam"];
const typeOf = (t) => TYPES[t] || TYPES.task;
const isDaily = (t) => t.type === "daily";

/* ---------- settings ---------- */
const DEFAULT_SETTINGS = { examLeadDays: 7, assignmentLeadDays: 21 };
/* has this assignment/exam entered its "show in today's agenda" window? stays true once overdue, too */
function inLeadWindow(task, settings, today) {
  if (!task.due) return false;
  if (task.type === "exam") return daysBetween(task.due, today) <= (settings.examLeadDays ?? DEFAULT_SETTINGS.examLeadDays);
  if (task.type === "assignment") return daysBetween(task.due, today) <= (settings.assignmentLeadDays ?? DEFAULT_SETTINGS.assignmentLeadDays);
  return false;
}
/* daily tasks don't get permanently "done" — they're done for today, then reset at midnight */
const isDoneToday = (task, today) => (isDaily(task) ? task.lastCompletedDate === today : !!task.done);

/* ---------- tiny utils ---------- */
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysBetween = (dueKey, todayKey) => Math.round((parseKey(dueKey) - parseKey(todayKey)) / 86400000);
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/* ---------- subtask tree helpers (subtasks can themselves have subtasks, any depth) ---------- */
function newSubtask(text) {
  return { id: uid(), text: text.trim(), done: false, subtasks: [] };
}
/* find `id` anywhere in the tree and replace it with fn(node) */
function mapSubtaskTree(list, id, fn) {
  return (list || []).map((n) => (n.id === id ? fn(n) : { ...n, subtasks: mapSubtaskTree(n.subtasks, id, fn) }));
}
/* remove `id` from wherever it is in the tree */
function removeFromSubtaskTree(list, id) {
  return (list || []).filter((n) => n.id !== id).map((n) => ({ ...n, subtasks: removeFromSubtaskTree(n.subtasks, id) }));
}
/* append newNode under the node matching parentId, anywhere in the tree */
function addToSubtaskTree(list, parentId, node) {
  return (list || []).map((n) => (
    n.id === parentId
      ? { ...n, subtasks: [...(n.subtasks || []), node] }
      : { ...n, subtasks: addToSubtaskTree(n.subtasks, parentId, node) }
  ));
}
/* clear every `done` flag in the tree, keeping its shape */
function zeroSubtaskTree(list) {
  return (list || []).map((n) => ({ ...n, done: false, subtasks: zeroSubtaskTree(n.subtasks) }));
}
/* a Daily task's subtask checklist resets each night, same as the task itself — computed, never mutated in storage */
function effectiveSubtasks(task, today) {
  const list = task.subtasks || [];
  return isDaily(task) && task.subtasksDate !== today ? zeroSubtaskTree(list) : list;
}
/* total / done counts across every descendant, any depth */
function countSubtasks(list) {
  let total = 0, done = 0;
  for (const n of (list || [])) {
    total += 1;
    if (n.done) done += 1;
    const child = countSubtasks(n.subtasks);
    total += child.total; done += child.done;
  }
  return { total, done };
}

/* still used locally for the decorative starfield in the library sky */
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
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

/* screens at or above this width get the desktop dashboard instead of the phone shell */
const DESKTOP_BREAKPOINT = "(min-width: 960px)";
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on(); mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return matches;
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
  if (code.includes("requires-recent-login")) return "Please sign out and back in, then try again.";
  return "Something went wrong. Check the details and try again.";
}
const SETTINGS_OK_MSGS = new Set(["Saved.", "Email updated.", "Password updated."]);
const settingsMsgColor = (msg) => (SETTINGS_OK_MSGS.has(msg) ? "#5E7A5C" : "#8A2E25");

/* poem/title/cover generation now lives in ./src/bookGenerator.js (the v2 procedural book system) */

/* every completed node anywhere in the subtask tree, in reading order — independent of its parent's state */
function flattenDoneSubtasks(list) {
  const out = [];
  for (const n of (list || [])) {
    if (n.done) out.push(n.text);
    out.push(...flattenDoneSubtasks(n.subtasks));
  }
  return out;
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
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT);
  const firebaseStatus = useMemo(() => getFirebaseConfigStatus(), []);
  const appReady = !authChecking && (!authUser || (booksReady && tasksReady && settingsReady));

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
        setSettings(DEFAULT_SETTINGS);
        setSettingsReady(false);
      }
    });

    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!authUser || !db) return;

    setBooksReady(false);
    setTasksReady(false);
    setSettingsReady(false);
    setSyncError("");

    const booksQuery = query(userCollectionPath(authUser.uid, "books"), orderBy("completedAt", "asc"));
    const tasksQuery = query(userCollectionPath(authUser.uid, "tasks"), orderBy("createdAt", "desc"));

    const unsubscribeBooks = onSnapshot(booksQuery, (snapshot) => {
      const loaded = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      setBooks(loaded);
      setBooksReady(true);

      /* one-time per book: remap any pre-v2 rarity key (e.g. "fine"/"first") into the current 7-tier system */
      loaded.forEach((book) => {
        const migrated = migrateLegacyRarity(book.rarity);
        if (migrated !== book.rarity) {
          setDoc(doc(userCollectionPath(authUser.uid, "books"), book.id), { rarity: migrated }, { merge: true }).catch(() => {});
        }
      });
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

    const unsubscribeSettings = onSnapshot(doc(db, "users", authUser.uid), (snapshot) => {
      const data = snapshot.data();
      setSettings({
        examLeadDays: typeof data?.examLeadDays === "number" ? data.examLeadDays : DEFAULT_SETTINGS.examLeadDays,
        assignmentLeadDays: typeof data?.assignmentLeadDays === "number" ? data.assignmentLeadDays : DEFAULT_SETTINGS.assignmentLeadDays,
      });
      setSettingsReady(true);
    }, (error) => {
      setSyncError(error?.message || "Could not load settings.");
      setSettingsReady(true);
    });

    return () => {
      unsubscribeBooks();
      unsubscribeTasks();
      unsubscribeSettings();
    };
  }, [authUser?.uid]);

  const booksRef = useMemo(() => (authUser && db ? userCollectionPath(authUser.uid, "books") : null), [authUser?.uid]);
  const tasksRef = useMemo(() => (authUser && db ? userCollectionPath(authUser.uid, "tasks") : null), [authUser?.uid]);

  const updateSettings = useCallback(async (patch) => {
    if (!authUser || !db) return;
    setSettings((prev) => ({ ...prev, ...patch })); // optimistic
    await setDoc(doc(db, "users", authUser.uid), patch, { merge: true });
  }, [authUser]);

  const addTask = useCallback(async (text, due, type) => {
    if (!authUser || !tasksRef) return;
    const daily = type === "daily";
    const t = {
      id: uid(), text: text.trim(), due: daily ? null : (due || null), type: type || "task",
      done: false, lastCompletedDate: null, subtasks: [], subtasksDate: null, createdAt: Date.now(),
    };
    if (!t.text) return;
    await setDoc(doc(tasksRef, t.id), t);
    setTasks((prev) => (prev.some((item) => item.id === t.id) ? prev : [t, ...prev]));
  }, [authUser, tasksRef]);

  const deleteTask = useCallback(async (id) => {
    if (!authUser || !tasksRef) return;
    await deleteDoc(doc(tasksRef, id));
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, [authUser, tasksRef]);

  const editTask = useCallback(async (id, patch) => {
    if (!authUser || !tasksRef) return;
    const current = tasks.find((t) => t.id === id);
    if (!current) return;
    const updated = { ...current, ...patch };
    await setDoc(doc(tasksRef, id), updated);
    setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
  }, [authUser, tasks, tasksRef]);

  /* subtasks are a pure checklist on the task doc — no poem, no auto-completing the parent */
  const updateSubtasks = useCallback(async (taskId, transform) => {
    if (!authUser || !tasksRef) return;
    const current = tasks.find((t) => t.id === taskId);
    if (!current) return;
    const today = toKey(new Date());
    /* a Daily task's checklist resets nightly — any edit on a stale tree starts from a cleared copy */
    const updated = {
      ...current,
      subtasks: transform(effectiveSubtasks(current, today)),
      ...(isDaily(current) ? { subtasksDate: today } : {}),
    };
    await setDoc(doc(tasksRef, taskId), updated);
    setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
  }, [authUser, tasks, tasksRef]);

  const addSubtask = useCallback((taskId, parentId, text) => {
    if (!text.trim()) return;
    const node = newSubtask(text);
    updateSubtasks(taskId, (list) => (parentId === taskId ? [...list, node] : addToSubtaskTree(list, parentId, node)));
  }, [updateSubtasks]);

  const toggleSubtask = useCallback((taskId, subtaskId) => {
    updateSubtasks(taskId, (list) => mapSubtaskTree(list, subtaskId, (n) => ({ ...n, done: !n.done })));
  }, [updateSubtasks]);

  const deleteSubtask = useCallback((taskId, subtaskId) => {
    updateSubtasks(taskId, (list) => removeFromSubtaskTree(list, subtaskId));
  }, [updateSubtasks]);

  const completeTask = useCallback(async (task) => {
    const today = toKey(new Date());
    if (isDoneToday(task, today) || bindingId || !authUser || !booksRef || !tasksRef) return;
    setBindingId(task.id);
    try {
      const bookId = uid();
      const identity = generateBook(bookId, task.text, task.type);
      const subtaskPages = flattenDoneSubtasks(effectiveSubtasks(task, today))
        .map((text) => generateBookSubtaskPage(bookId, text, task.type, identity.genre));
      const pages = [{ heading: null, poem: identity.poem }, ...subtaskPages];
      const book = {
        id: bookId,
        pages,
        taskName: task.text,
        type: task.type || "task",
        completedAt: Date.now(),
        material: identity.bindingForm,
        ...identity,
      };
      const updatedTask = isDaily(task) ? { ...task, lastCompletedDate: today } : { ...task, done: true };
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
    const reopened = isDaily(currentTask) ? { ...currentTask, lastCompletedDate: null } : { ...currentTask, done: false };
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

  const signedIn = !authChecking && authUser && appReady;

  return (
    <div className="app-root" style={styles.root}>
      <style>{CSS}</style>

      {!signedIn ? (
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
          ) : (
            <Splash />
          )}
        </div>
      ) : isDesktop ? (
        <div className="app-desktop">
          <aside className="app-sidebar">
            <div className="sidebar-brand">
              <Logo size={36} />
              <div>
                <div className="sidebar-wordmark">Bindary</div>
                <div className="sidebar-tagline">Finish something. Bind its poem.</div>
              </div>
            </div>

            <div className="sidebar-stats">
              <div className="sidebar-stat"><BookOpen size={15} /> {books.length} {books.length === 1 ? "book" : "books"}</div>
              <div className="sidebar-stat"><ListIcon size={15} /> {tasks.filter((t) => !isDoneToday(t, toKey(new Date()))).length} open {tasks.filter((t) => !isDoneToday(t, toKey(new Date()))).length === 1 ? "task" : "tasks"}</div>
            </div>

            <div className="sidebar-spacer" />

            <div className="sidebar-foot">
              <div style={styles.userPill} title={authUser.email || "Signed in"}>
                <span style={styles.userDot} />
                {authUser.displayName || authUser.email || "Signed in"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="iconbtn" style={styles.gearBtn} onClick={() => setSettingsOpen(true)} aria-label="Settings"><SettingsIcon size={16} /></button>
                <button className="iconbtn" style={{ ...styles.signOutBtn, flex: 1, width: "auto" }} onClick={handleSignOut}>Sign out</button>
              </div>
            </div>
          </aside>

          <main className="app-main">
            {syncError && <div className="desktop-sync-banner" style={styles.syncBanner}>{syncError}</div>}
            <div className="app-panes">
              <div className="pane pane-tasks">
                <TasksScreen
                  tasks={tasks} onAdd={addTask} onComplete={completeTask}
                  onDelete={deleteTask} onReopen={reopenTask} bindingId={bindingId}
                  onAddSubtask={addSubtask} onToggleSubtask={toggleSubtask} onDeleteSubtask={deleteSubtask}
                  onEditTask={editTask}
                  settings={settings}
                />
              </div>
              <div className="pane pane-library">
                <LibraryScreen books={books} scrollRef={libScrollRef} onOpen={(i) => setOpenIndex(i)} reduce={reduce} />
              </div>
            </div>
          </main>
        </div>
      ) : (
        <div className="app-phone">
          <div style={styles.userBar}>
            <div style={styles.userPill} title={authUser.email || "Signed in"}>
              <span style={styles.userDot} />
              {authUser.displayName || authUser.email || "Signed in"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="iconbtn" style={styles.gearBtn} onClick={() => setSettingsOpen(true)} aria-label="Settings"><SettingsIcon size={16} /></button>
              <button className="iconbtn" style={styles.signOutBtn} onClick={handleSignOut}>Sign out</button>
            </div>
          </div>

          {syncError && <div style={styles.syncBanner}>{syncError}</div>}

          <div key={tab} className="screen-fade" style={styles.screen}>
            {tab === "library" ? (
              <LibraryScreen books={books} scrollRef={libScrollRef} onOpen={(i) => setOpenIndex(i)} reduce={reduce} />
            ) : (
              <TasksScreen
                tasks={tasks} onAdd={addTask} onComplete={completeTask}
                onDelete={deleteTask} onReopen={reopenTask} bindingId={bindingId}
                onAddSubtask={addSubtask} onToggleSubtask={toggleSubtask} onDeleteSubtask={deleteSubtask}
                onEditTask={editTask}
                settings={settings}
              />
            )}
          </div>

          <nav style={styles.nav} aria-label="Screens">
            <TabButton active={tab === "library"} onClick={() => setTab("library")} icon={<BookOpen size={20} />} label="Library" badge={books.length} />
            <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")} icon={<ListIcon size={20} />} label="Tasks" />
          </nav>
        </div>
      )}

      {openIndex != null && books[openIndex] && (
        <BookModal
          books={books} index={openIndex}
          onClose={() => setOpenIndex(null)} onNav={(i) => setOpenIndex(i)}
          onDeleteBook={deleteBook}
        />
      )}

      {celebration && <Celebration book={celebration} onClose={dismissCelebration} reduce={reduce} />}

      {settingsOpen && (
        <SettingsModal settings={settings} onSave={updateSettings} onClose={() => setSettingsOpen(false)} authUser={authUser} />
      )}
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
  const towerRef = useRef(null);
  const towerWidth = useElementWidth(towerRef);
  const shelfCapacity = shelfCapacityForWidth(towerWidth);
  const shelfCount = Math.max(1, Math.ceil(books.length / shelfCapacity));
  const onShelf = books.length % shelfCapacity;
  const remaining = onShelf === 0 ? 0 : shelfCapacity - onShelf;
  const progress = books.length === 0 ? 0 : (onShelf === 0 ? 1 : onShelf / shelfCapacity);
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
        <div className="sky" style={styles.sky}>
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

        <div ref={towerRef} className="tower" style={styles.tower}>
          {books.length === 0 ? (
            <EmptyShelf capacity={shelfCapacity} />
          ) : (
            reversedIndexedShelves(books, shelfCapacity).map((shelf, i) => (
              <Shelf key={i} items={shelf} onOpen={onOpen} isTop={i === 0} reduce={reduce} capacity={shelfCapacity} />
            ))
          )}
          <div style={styles.floor} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/* build [{book, globalIndex}] per shelf, newest shelf first */
function reversedIndexedShelves(books, capacity = SHELF_CAPACITY) {
  const chunks = [];
  for (let i = 0; i < books.length; i += capacity) {
    chunks.push(books.slice(i, i + capacity).map((b, j) => ({ book: b, index: i + j })));
  }
  if (chunks.length === 0 || chunks[chunks.length - 1].length === capacity) chunks.push([]);
  return chunks.reverse();
}

function Shelf({ items, onOpen, isTop, reduce, capacity = SHELF_CAPACITY }) {
  const slots = capacity;
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
  const cloth = clothOf(book);
  const isExam = book.type === "exam";
  const rarity = book.rarity || "common";
  const rr = RARITY_RANK[rarity] || 0;
  /* an "Altered" book wears its tier's flourish a notch stronger — the modifier from the v2 generator */
  const effectiveRr = Math.min(6, rr + (book.modifier === "altered" ? 1 : 0));
  const gilded = effectiveRr >= 5;            // mythic / relic shimmer
  const gem = effectiveRr >= 5 || isExam;
  const bright = effectiveRr >= 3 || isExam;
  const bandColor = bright ? "rgba(239,214,143,0.98)"
    : (effectiveRr >= 1 || book.type === "assignment") ? "rgba(214,180,92,0.85)"
    : "rgba(214,180,92,0.6)";
  const frame =
    effectiveRr >= 6 ? ", inset 0 0 0 2px rgba(247,233,190,0.92), 0 0 16px rgba(239,214,143,0.4)"
    : effectiveRr === 5 ? ", inset 0 0 0 1.6px rgba(239,214,143,0.75)"
    : (effectiveRr >= 3 || isExam) ? ", inset 0 0 0 1.4px rgba(214,180,92,0.5)"
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
      {(effectiveRr === 1 || effectiveRr === 2) && <span style={styles.spineSheen} aria-hidden="true" />}
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

function EmptyShelf({ capacity = SHELF_CAPACITY }) {
  return (
    <div style={styles.shelfWrap}>
      <div style={{ ...styles.shelfBooks, alignItems: "flex-end" }}>
        {Array.from({ length: capacity }).map((_, i) => <div key={i} style={styles.emptySlot} />)}
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
  const pages = book.pages && book.pages.length ? book.pages : [{ heading: null, poem: book.poem }];
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => { setPageIndex(0); }, [book.id]);
  const page = pages[Math.min(pageIndex, pages.length - 1)];

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
            {book.modifier === "altered" && <span style={styles.alteredChip}>Altered</span>}
            {book.genre && <span style={styles.pageMaterial}>{book.genre}{book.subgenre ? " · " + book.subgenre : ""}</span>}
            {book.material && <span style={styles.pageMaterial}>bound in {book.material}</span>}
            {book.collection && <span style={styles.pageMaterial}>{book.collection}{book.volume ? " · Vol. " + book.volume : ""}</span>}
            {book.seriesMark && <span style={styles.pageMaterial}>edition {book.seriesMark}</span>}
            {book.classification && <span style={styles.pageMaterial}>{book.classification}</span>}
            {book.edgeTint && <span style={styles.pageMaterial}>edges {book.edgeTint}</span>}
          </div>
          <h2 style={styles.pageTitle}>{book.title}</h2>
          <div style={styles.pageRule} />
          {page.heading && <div style={styles.pageHeading}>{page.heading}</div>}
          <div style={styles.poem}>{page.poem}</div>

          {pages.length > 1 && (
            <div style={styles.pageTurnRow}>
              <button className="iconbtn" style={{ ...styles.pageTurnBtn, opacity: pageIndex > 0 ? 1 : 0.3 }}
                disabled={pageIndex === 0} onClick={() => setPageIndex((p) => p - 1)} aria-label="Previous page"><ChevronLeft size={15} /></button>
              <span style={styles.pageTurnLabel}>Page {pageIndex + 1} of {pages.length}</span>
              <button className="iconbtn" style={{ ...styles.pageTurnBtn, opacity: pageIndex < pages.length - 1 ? 1 : 0.3 }}
                disabled={pageIndex === pages.length - 1} onClick={() => setPageIndex((p) => p + 1)} aria-label="Next page"><ChevronRight size={15} /></button>
            </div>
          )}

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
 *  SETTINGS
 * ================================================================== */
function SettingsModal({ settings, onSave, onClose, authUser }) {
  const [tab, setTab] = useState("agenda");

  /* agenda */
  const [examLeadDays, setExamLeadDays] = useState(String(settings.examLeadDays));
  const [assignmentLeadDays, setAssignmentLeadDays] = useState(String(settings.assignmentLeadDays));
  const [agendaMsg, setAgendaMsg] = useState("");
  const saveAgenda = () => {
    onSave({
      examLeadDays: Math.max(0, Math.min(120, Math.round(Number(examLeadDays)) || 0)),
      assignmentLeadDays: Math.max(0, Math.min(120, Math.round(Number(assignmentLeadDays)) || 0)),
    });
    setAgendaMsg("Saved.");
  };

  /* account: username */
  const [username, setUsername] = useState(authUser?.displayName || "");
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [usernameMsg, setUsernameMsg] = useState("");
  const saveUsername = async () => {
    if (!auth?.currentUser || !username.trim()) return;
    setUsernameBusy(true); setUsernameMsg("");
    try {
      await updateProfile(auth.currentUser, { displayName: username.trim() });
      setUsernameMsg("Saved.");
    } catch (error) {
      setUsernameMsg(friendlyAuthError(error));
    } finally {
      setUsernameBusy(false);
    }
  };

  /* account: email (requires re-entering the current password) */
  const [newEmail, setNewEmail] = useState(authUser?.email || "");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState("");
  const saveEmail = async () => {
    if (!auth?.currentUser || !newEmail.trim() || !emailPassword) return;
    setEmailBusy(true); setEmailMsg("");
    try {
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(authUser.email, emailPassword));
      await updateEmail(auth.currentUser, newEmail.trim());
      setEmailMsg("Email updated.");
      setEmailPassword("");
    } catch (error) {
      setEmailMsg(friendlyAuthError(error));
    } finally {
      setEmailBusy(false);
    }
  };

  /* account: password (requires the current password too) */
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState("");
  const savePassword = async () => {
    if (!auth?.currentUser || !currentPassword) return;
    if (newPassword.length < 6) { setPasswordMsg("Use at least 6 characters."); return; }
    setPasswordBusy(true); setPasswordMsg("");
    try {
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(authUser.email, currentPassword));
      await updatePassword(auth.currentUser, newPassword);
      setPasswordMsg("Password updated.");
      setCurrentPassword(""); setNewPassword("");
    } catch (error) {
      setPasswordMsg(friendlyAuthError(error));
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div className="book-open" style={styles.settingsCard} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <button className="iconbtn" style={styles.pageClose} onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        <div style={styles.settingsInner}>
          <div style={styles.pageEyebrow}>Settings</div>
          <h2 style={styles.settingsTitle}>{tab === "agenda" ? "Daily agenda" : "Account"}</h2>

          <div style={styles.authTabs} role="tablist" aria-label="Settings section">
            <button type="button" onClick={() => setTab("agenda")} style={{ ...styles.authTab, ...(tab === "agenda" ? styles.authTabActive : {}) }}>Agenda</button>
            <button type="button" onClick={() => setTab("account")} style={{ ...styles.authTab, ...(tab === "account" ? styles.authTabActive : {}) }}>Account</button>
          </div>

          {tab === "agenda" ? (
            <div style={styles.authForm}>
              <p style={styles.settingsHint}>Assignments and exams join your Today list this many days before they're due — and stay there if they go overdue.</p>
              <label style={styles.settingsField}>
                Exams — days before due
                <input className="field" type="number" min="0" max="120" value={examLeadDays}
                  onChange={(e) => { setExamLeadDays(e.target.value); setAgendaMsg(""); }} style={styles.settingsInput} aria-label="Exam lead time in days" />
              </label>
              <label style={styles.settingsField}>
                Assignments — days before due
                <input className="field" type="number" min="0" max="120" value={assignmentLeadDays}
                  onChange={(e) => { setAssignmentLeadDays(e.target.value); setAgendaMsg(""); }} style={styles.settingsInput} aria-label="Assignment lead time in days" />
              </label>
              {agendaMsg && <div style={{ ...styles.settingsMsg, color: settingsMsgColor(agendaMsg) }}>{agendaMsg}</div>}
              <button className="addbtn" style={{ ...styles.addBtn, ...styles.settingsSave }} onClick={saveAgenda}>Save</button>
            </div>
          ) : (
            <div style={styles.authForm}>
              <label style={styles.authLabel}>
                Username
                <div style={styles.settingsRow}>
                  <input className="field" style={styles.authInput} value={username}
                    onChange={(e) => { setUsername(e.target.value); setUsernameMsg(""); }}
                    placeholder="How you'd like to be known" aria-label="Username" />
                  <button className="iconbtn" style={styles.settingsRowBtn} disabled={usernameBusy} onClick={saveUsername}>{usernameBusy ? "…" : "Save"}</button>
                </div>
              </label>
              {usernameMsg && <div style={{ ...styles.settingsMsg, color: settingsMsgColor(usernameMsg) }}>{usernameMsg}</div>}

              <div style={styles.settingsDivider} />

              <label style={styles.authLabel}>
                Email
                <input className="field" type="email" style={styles.authInput} value={newEmail}
                  onChange={(e) => { setNewEmail(e.target.value); setEmailMsg(""); }} aria-label="New email" />
              </label>
              <label style={styles.authLabel}>
                Current password, to confirm
                <input className="field" type="password" style={styles.authInput} value={emailPassword}
                  onChange={(e) => { setEmailPassword(e.target.value); setEmailMsg(""); }}
                  autoComplete="current-password" aria-label="Current password to confirm email change" />
              </label>
              {emailMsg && <div style={{ ...styles.settingsMsg, color: settingsMsgColor(emailMsg) }}>{emailMsg}</div>}
              <button className="addbtn" style={{ ...styles.addBtn, ...styles.settingsSave }} disabled={emailBusy} onClick={saveEmail}>
                {emailBusy ? "Please wait…" : "Update email"}
              </button>

              <div style={styles.settingsDivider} />

              <label style={styles.authLabel}>
                Current password
                <input className="field" type="password" style={styles.authInput} value={currentPassword}
                  onChange={(e) => { setCurrentPassword(e.target.value); setPasswordMsg(""); }}
                  autoComplete="current-password" aria-label="Current password" />
              </label>
              <label style={styles.authLabel}>
                New password
                <input className="field" type="password" style={styles.authInput} value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setPasswordMsg(""); }}
                  autoComplete="new-password" aria-label="New password" />
              </label>
              {passwordMsg && <div style={{ ...styles.settingsMsg, color: settingsMsgColor(passwordMsg) }}>{passwordMsg}</div>}
              <button className="addbtn" style={{ ...styles.addBtn, ...styles.settingsSave }} disabled={passwordBusy} onClick={savePassword}>
                {passwordBusy ? "Please wait…" : "Update password"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== *
 *  CELEBRATION
 * ================================================================== */
function Celebration({ book, onClose, reduce }) {
  const cloth = clothOf(book);
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
        <div style={styles.celebCaption}>
          Bound to your library{book.pages && book.pages.length > 1 ? ` · ${book.pages.length} pages` : ""}
        </div>
        <div style={styles.celebHint}>tap to view your shelves</div>
      </div>
    </div>
  );
}

/* ================================================================== *
 *  TASKS + CALENDAR
 * ================================================================== */
function TasksScreen({ tasks, onAdd, onComplete, onDelete, onReopen, bindingId, onAddSubtask, onToggleSubtask, onDeleteSubtask, onEditTask, settings = DEFAULT_SETTINGS }) {
  const [view, setView] = useState("list");
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [type, setType] = useState("task");
  const [filter, setFilter] = useState("all");
  const today = toKey(new Date());
  const tomorrow = toKey(new Date(Date.now() + 86400000));

  const submit = () => { if (text.trim()) { onAdd(text, due || null, type); setText(""); setDue(""); } };

  const active = tasks.filter((t) => !isDoneToday(t, today));
  const done = tasks.filter((t) => isDoneToday(t, today));
  const rank = (t) => typeOf(t.type).rank;
  active.sort((a, b) => {
    const aDaily = isDaily(a), bDaily = isDaily(b);
    if (aDaily !== bDaily) return aDaily ? -1 : 1;
    if (aDaily && bDaily) return b.createdAt - a.createdAt;
    if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return b.createdAt - a.createdAt;
  });

  const nextUp = active.find((t) => t.due);

  /* Today's agenda: recurring dailies, plus assignments/exams once they enter their configured lead window */
  const todayItems = active.filter((t) => isDaily(t) || inLeadWindow(t, settings, today));
  const todayIds = new Set(todayItems.map((t) => t.id));
  const restActive = active.filter((t) => !todayIds.has(t.id));

  const shownActive = restActive.filter((t) => filter === "all" || t.type === filter);
  const shownDone = done.filter((t) => filter === "all" || t.type === filter);
  const isEmpty = active.length === 0 && done.length === 0;

  return (
    <div style={styles.tasks}>
      <header className="masthead" style={styles.masthead}>
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
        {type === "daily" ? (
          <div style={styles.dueRow}>
            <span style={styles.dueLabel}>Repeats</span>
            <span style={{ ...styles.dueQuick, ...styles.dueQuickOn, cursor: "default" }}>Every day</span>
          </div>
        ) : (
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
        )}
      </div>

      <div style={styles.tasksBody}>
        {view === "calendar" ? (
          <CalendarView tasks={tasks} onPickDate={(d) => { setDue(d); }} />
        ) : isEmpty ? (
          <div style={styles.emptyTasks}>
            <Logo size={56} />
            <p style={{ margin: "16px 0 4px", fontFamily: "Fraunces, serif", fontSize: 19 }}>Your desk is clear.</p>
            <p style={styles.muted}>Add a task, daily habit, assignment, or exam above. Finish it, and a poem is bound into your library.</p>
          </div>
        ) : (
          <>
            {nextUp && filter === "all" && (
              <NextUp task={nextUp} today={today} binding={bindingId === nextUp.id} onComplete={() => onComplete(nextUp)} />
            )}

            {todayItems.length > 0 && filter === "all" && (
              <>
                <div style={styles.sectionLabel}><Clock size={11} style={{ marginRight: 5, verticalAlign: -1 }} />Today · {todayItems.length}</div>
                {todayItems.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} binding={bindingId === t.id}
                    onComplete={() => onComplete(t)} onDelete={() => onDelete(t.id)} onReopen={() => onReopen(t.id)}
                    onAddSubtask={onAddSubtask} onToggleSubtask={onToggleSubtask} onDeleteSubtask={onDeleteSubtask} onEditTask={onEditTask} />
                ))}
              </>
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
                    onComplete={() => onComplete(t)} onDelete={() => onDelete(t.id)}
                    onAddSubtask={onAddSubtask} onToggleSubtask={onToggleSubtask} onDeleteSubtask={onDeleteSubtask} onEditTask={onEditTask} />
                ))}
                {shownDone.length > 0 && (
                  <>
                    <div style={styles.sectionLabel}>Bound · {shownDone.length}</div>
                    {shownDone.map((t) => (
                      <TaskRow key={t.id} task={t} today={today} onReopen={() => onReopen(t.id)} onDelete={() => onDelete(t.id)}
                        onAddSubtask={onAddSubtask} onToggleSubtask={onToggleSubtask} onDeleteSubtask={onDeleteSubtask} onEditTask={onEditTask} />
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

function dueMeta(task, doneNow, today) {
  if (isDaily(task)) return doneNow ? { label: "Done for today", tone: "muted" } : { label: "Every day", tone: "soon" };
  const due = task.due;
  if (!due) return { label: "No date", tone: "muted" };
  if (doneNow) return { label: prettyDate(due), tone: "muted" };
  if (due < today) return { label: "Overdue", tone: "over" };
  if (due === today) return { label: "Due today", tone: "soon" };
  const diff = (parseKey(due) - parseKey(today)) / 86400000;
  if (diff <= 3) return { label: `Due ${prettyDate(due)}`, tone: "soon" };
  return { label: prettyDate(due), tone: "later" };
}

function TaskRow({ task, today, binding, onComplete, onDelete, onReopen, onAddSubtask, onToggleSubtask, onDeleteSubtask, onEditTask }) {
  const doneNow = isDoneToday(task, today);
  const meta = dueMeta(task, doneNow, today);
  const ty = typeOf(task.type);
  const toneColor = { over: "#E0736B", soon: "var(--gold-bright)", later: "rgba(236,227,208,0.55)", muted: "rgba(236,227,208,0.4)" }[meta.tone];
  const subtasks = effectiveSubtasks(task, today);
  const progress = countSubtasks(subtasks);
  const [subOpen, setSubOpen] = useState(false);
  const [addingRoot, setAddingRoot] = useState(false);
  const [rootText, setRootText] = useState("");
  const submitRoot = () => { if (rootText.trim()) { onAddSubtask(task.id, task.id, rootText); setRootText(""); setAddingRoot(false); } };

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(task.text);
  const [editDue, setEditDue] = useState(task.due || "");
  const tomorrow = toKey(new Date(Date.now() + 86400000));
  const startEdit = () => { setEditText(task.text); setEditDue(task.due || ""); setEditing(true); };
  const cancelEdit = () => setEditing(false);
  const saveEdit = () => {
    if (!editText.trim()) return;
    onEditTask(task.id, { text: editText.trim(), ...(isDaily(task) ? {} : { due: editDue || null }) });
    setEditing(false);
  };

  return (
    <div style={{ ...styles.taskCard, borderLeft: `3px solid ${doneNow ? "rgba(236,227,208,0.15)" : ty.color}`, opacity: doneNow ? 0.6 : 1 }}>
      <div style={styles.taskRow}>
        <button
          className="check" onClick={doneNow ? onReopen : onComplete} disabled={binding}
          aria-label={doneNow ? "Reopen task" : "Complete task"}
          style={{ ...styles.check, ...(doneNow ? styles.checkDone : {}), ...(binding ? styles.checkBinding : {}) }}
        >
          {binding ? <span className="spin" style={styles.spinner} /> : doneNow ? <Check size={16} /> : null}
        </button>

        {editing ? (
          <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
            <input className="field-inline" style={styles.taskEditInput} value={editText} autoFocus
              onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveEdit()}
              aria-label="Edit task text" />
            {!isDaily(task) && (
              <div style={styles.dueRow}>
                <span style={styles.dueLabel}>Due</span>
                <button onClick={() => setEditDue(editDue === today ? "" : today)}
                  style={{ ...styles.dueQuick, ...(editDue === today ? styles.dueQuickOn : {}) }}>Today</button>
                <button onClick={() => setEditDue(editDue === tomorrow ? "" : tomorrow)}
                  style={{ ...styles.dueQuick, ...(editDue === tomorrow ? styles.dueQuickOn : {}) }}>Tomorrow</button>
                <label style={styles.datePick}>
                  <CalIcon size={13} color="#8A6A3A" />
                  <input className="field-inline" type="date" value={editDue}
                    onChange={(e) => setEditDue(e.target.value)} aria-label="Pick due date" style={styles.datePickInput} />
                </label>
                {editDue && <button onClick={() => setEditDue("")} style={styles.dueClear} aria-label="Clear due date"><X size={12} /> {prettyDate(editDue)}</button>}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="addbtn" style={styles.taskEditSave} onClick={saveEdit}>Save</button>
              <button className="iconbtn" style={styles.taskEditCancel} onClick={cancelEdit}>Cancel</button>
            </div>
          </div>
        ) : (
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ ...styles.taskText, textDecoration: doneNow ? "line-through" : "none" }}>{task.text}</div>
            <div style={styles.taskMetaRow}>
              <span style={{ ...styles.typeChip, color: ty.color, background: ty.chipBg }}>{ty.label}</span>
              <span style={{ ...styles.taskDue, color: toneColor }}>
                {binding ? "Binding its poem…" : meta.label}
              </span>
              <button onClick={() => setSubOpen((o) => !o)} style={styles.subtaskToggle} aria-label={subOpen ? "Hide subtasks" : "Show subtasks"}>
                <ListChecks size={11} />
                {progress.total > 0 && `${progress.done}/${progress.total}`}
                <ChevronRight size={11} style={{ transform: subOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
              </button>
            </div>
          </div>
        )}

        {!editing && (
          <>
            <button className="iconbtn" style={styles.taskEditBtn} onClick={startEdit} aria-label="Edit task"><Pencil size={14} /></button>
            <button className="iconbtn" style={styles.taskDelete} onClick={onDelete} aria-label="Delete task"><Trash2 size={15} /></button>
          </>
        )}
      </div>

      {subOpen && !editing && (
        <div style={styles.subtaskPanel}>
          <SubtaskTree nodes={subtasks} depth={0} onToggle={(id) => onToggleSubtask(task.id, id)}
            onDelete={(id) => onDeleteSubtask(task.id, id)} onAddChild={(parentId, text) => onAddSubtask(task.id, parentId, text)} />

          {addingRoot ? (
            <div style={styles.subtaskAddRow}>
              <input className="field-inline" style={styles.subtaskInput} value={rootText} autoFocus
                onChange={(e) => setRootText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitRoot()}
                placeholder="Add subtask…" aria-label="New subtask" />
              <button className="iconbtn" style={styles.subtaskAddConfirm} onClick={submitRoot} aria-label="Confirm add subtask"><Plus size={13} /></button>
            </div>
          ) : (
            <button onClick={() => setAddingRoot(true)} style={{ ...styles.subtaskToggle, ...styles.subtaskRootAdd }}>
              <Plus size={11} /> Subtask
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SubtaskTree({ nodes, depth, onToggle, onDelete, onAddChild }) {
  if (!nodes || nodes.length === 0) return null;
  return (
    <div style={{ ...styles.subtaskList, paddingLeft: depth * 18 }}>
      {nodes.map((n) => (
        <SubtaskNode key={n.id} node={n} depth={depth} onToggle={onToggle} onDelete={onDelete} onAddChild={onAddChild} />
      ))}
    </div>
  );
}

function SubtaskNode({ node, depth, onToggle, onDelete, onAddChild }) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const hasChildren = node.subtasks && node.subtasks.length > 0;
  const submit = () => { if (text.trim()) { onAddChild(node.id, text); setText(""); setAdding(false); } };

  return (
    <div style={styles.subtaskNode}>
      <div style={styles.subtaskRow}>
        {hasChildren ? (
          <button className="iconbtn" onClick={() => setOpen((o) => !o)} style={styles.subtaskCaret} aria-label={open ? "Collapse" : "Expand"}>
            <ChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
          </button>
        ) : <span style={styles.subtaskCaretSpacer} />}
        <button className="check" onClick={() => onToggle(node.id)} aria-label={node.done ? "Mark not done" : "Mark done"}
          style={{ ...styles.subCheck, ...(node.done ? styles.checkDone : {}) }}>
          {node.done ? <Check size={11} /> : null}
        </button>
        <span style={{ ...styles.subtaskText, textDecoration: node.done ? "line-through" : "none", opacity: node.done ? 0.55 : 1 }}>{node.text}</span>
        <button className="iconbtn" onClick={() => setAdding((a) => !a)} style={styles.subtaskAddBtn} aria-label="Add nested subtask"><Plus size={12} /></button>
        <button className="iconbtn" onClick={() => onDelete(node.id)} style={styles.subtaskDeleteBtn} aria-label="Delete subtask"><Trash2 size={12} /></button>
      </div>

      {adding && (
        <div style={{ ...styles.subtaskAddRow, paddingLeft: 22 }}>
          <input className="field-inline" style={styles.subtaskInput} value={text} autoFocus
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Add subtask…" aria-label="New nested subtask" />
          <button className="iconbtn" style={styles.subtaskAddConfirm} onClick={submit} aria-label="Confirm add subtask"><Plus size={13} /></button>
        </div>
      )}

      {open && hasChildren && (
        <SubtaskTree nodes={node.subtasks} depth={depth + 1} onToggle={onToggle} onDelete={onDelete} onAddChild={onAddChild} />
      )}
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

  /* settings modal */
  settingsCard: {
    position: "relative", width: "100%", maxWidth: 360, maxHeight: "86vh",
    background: "linear-gradient(135deg,#F1E8D5,#E3D6BA)", borderRadius: 16,
    boxShadow: "0 30px 70px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(120,90,50,0.25)",
    display: "flex", flexDirection: "column", overflow: "hidden",
  },
  settingsInner: { padding: "34px 28px 28px", overflowY: "auto", flex: 1 },
  settingsTitle: { fontFamily: "Fraunces, serif", fontSize: 24, margin: "6px 0 0", color: "#2A1C10", fontWeight: 600 },
  settingsHint: { fontSize: 13, lineHeight: 1.5, color: "#6E5A3E", margin: 0 },
  settingsField: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, fontWeight: 600, color: "#4A3A24", fontFamily: "Inter, sans-serif" },
  settingsInput: { width: 100 },
  settingsSave: { width: "100%", justifyContent: "center" },
  settingsRow: { display: "flex", gap: 8 },
  settingsRowBtn: {
    flexShrink: 0, border: "1px solid rgba(120,90,50,0.25)", background: "rgba(214,180,92,0.18)", color: "#7E5A11",
    borderRadius: 10, padding: "0 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
  },
  settingsMsg: { fontSize: 12, fontWeight: 600, marginTop: -4 },
  settingsDivider: { height: 1, background: "rgba(120,90,50,0.16)", margin: "6px 0" },
  gearBtn: { border: "1px solid rgba(236,227,208,0.12)", background: "rgba(236,227,208,0.04)", color: "rgba(236,227,208,0.72)", borderRadius: 999, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 },
  pageRarity: { display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 4, gap: 9, marginTop: 9 },
  alteredChip: { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 6, border: "1px solid rgba(120,90,50,0.4)", color: "#7E5A11", background: "rgba(214,180,92,0.14)", fontFamily: "Inter, sans-serif" },
  rarityChip: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 6, border: "1px solid", fontFamily: "Inter, sans-serif" },
  pageMaterial: { fontSize: 12.5, fontStyle: "italic", color: "#8A7350", fontFamily: "Fraunces, serif" },
  pageTitle: { fontFamily: "Fraunces, serif", fontSize: 28, lineHeight: 1.15, margin: "8px 0 0", color: "#2A1C10", fontWeight: 600 },
  pageRule: { width: 44, height: 2, background: "#B98F47", margin: "16px 0 18px" },
  poem: { fontFamily: "Fraunces, serif", fontSize: 17.5, lineHeight: 1.72, whiteSpace: "pre-wrap", color: "#33261A" },
  pageHeading: { fontFamily: "Fraunces, serif", fontStyle: "italic", fontSize: 13.5, letterSpacing: "0.04em", color: "#9A7B4C", marginBottom: 10 },
  pageTurnRow: { marginTop: 20, display: "flex", alignItems: "center", gap: 10, paddingTop: 14, borderTop: "1px solid rgba(120,90,50,0.16)" },
  pageTurnBtn: { width: 28, height: 28, borderRadius: "50%", border: "none", background: "rgba(60,40,20,0.08)", color: "#3A2817", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  pageTurnLabel: { fontSize: 12, fontWeight: 600, color: "#8A7350", fontFamily: "Inter, sans-serif" },
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

  taskCard: { borderRadius: 12, background: "rgba(236,227,208,0.035)", marginBottom: 7, border: "1px solid rgba(236,227,208,0.06)", overflow: "hidden" },
  taskRow: { display: "flex", alignItems: "center", gap: 12, padding: "13px 12px" },
  check: { width: 26, height: 26, flexShrink: 0, borderRadius: 8, border: "1.5px solid rgba(214,180,92,0.5)", background: "transparent", color: "#1a130a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .18s" },
  checkDone: { background: "var(--gold)", borderColor: "var(--gold)" },
  checkBinding: { borderColor: "var(--gold)", cursor: "wait" },
  spinner: { width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(214,180,92,0.35)", borderTopColor: "var(--gold)", display: "block" },
  taskText: { fontSize: 15.5, color: "var(--paper)", lineHeight: 1.35, wordBreak: "break-word" },
  taskDue: { fontSize: 12, marginTop: 3, fontWeight: 600, letterSpacing: "0.02em" },
  taskDelete: { width: 32, height: 32, flexShrink: 0, borderRadius: 8, border: "none", background: "transparent", color: "rgba(236,227,208,0.35)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  taskEditBtn: { width: 32, height: 32, flexShrink: 0, borderRadius: 8, border: "none", background: "transparent", color: "rgba(236,227,208,0.3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  taskEditInput: { width: "100%", background: "rgba(236,227,208,0.08)", border: "1px solid rgba(236,227,208,0.2)", borderRadius: 8, padding: "8px 10px", fontSize: 15, color: "var(--paper)", fontFamily: "Inter, sans-serif", outline: "none" },
  taskEditSave: { border: "none", background: "var(--gold)", color: "#1a130a", borderRadius: 8, padding: "7px 16px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "Inter, sans-serif" },
  taskEditCancel: { border: "1px solid rgba(236,227,208,0.14)", background: "rgba(236,227,208,0.05)", color: "rgba(236,227,208,0.65)", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "Inter, sans-serif" },

  /* subtasks */
  subtaskToggle: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11.5, fontWeight: 700, color: "rgba(236,227,208,0.55)", background: "rgba(236,227,208,0.07)", border: "none", borderRadius: 999, padding: "2px 7px", cursor: "pointer", fontFamily: "Inter, sans-serif" },
  subtaskPanel: { padding: "0 12px 12px 50px", display: "flex", flexDirection: "column", gap: 2 },
  subtaskList: { display: "flex", flexDirection: "column", gap: 2 },
  subtaskNode: { display: "flex", flexDirection: "column" },
  subtaskRow: { display: "flex", alignItems: "center", gap: 6, padding: "4px 0" },
  subtaskCaret: { width: 16, height: 16, flexShrink: 0, border: "none", background: "transparent", color: "rgba(236,227,208,0.4)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  subtaskCaretSpacer: { width: 16, flexShrink: 0 },
  subCheck: { width: 18, height: 18, flexShrink: 0, borderRadius: 5, border: "1.5px solid rgba(214,180,92,0.45)", background: "transparent", color: "#1a130a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  subtaskText: { flex: 1, minWidth: 0, fontSize: 13, color: "rgba(236,227,208,0.85)", wordBreak: "break-word" },
  subtaskAddBtn: { width: 20, height: 20, flexShrink: 0, border: "none", background: "transparent", color: "rgba(236,227,208,0.3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  subtaskDeleteBtn: { width: 20, height: 20, flexShrink: 0, border: "none", background: "transparent", color: "rgba(236,227,208,0.25)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  subtaskAddRow: { display: "flex", alignItems: "center", gap: 6, padding: "2px 0 6px 22px" },
  subtaskInput: { flex: 1, minWidth: 0, background: "rgba(236,227,208,0.07)", border: "1px solid rgba(236,227,208,0.16)", borderRadius: 7, padding: "5px 8px", fontSize: 12.5, color: "var(--paper)", fontFamily: "Inter, sans-serif", outline: "none" },
  subtaskAddConfirm: { width: 22, height: 22, flexShrink: 0, border: "none", borderRadius: 6, background: "var(--gold)", color: "#1a130a", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  subtaskRootAdd: { display: "flex", alignItems: "center", gap: 6, marginTop: 2 },

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

/* ---- desktop dashboard: sidebar + two panes shown side by side ---- */
@media (min-width: 960px) {
  .app-root { align-items: stretch; padding: 0; }
  .app-desktop { width: 100%; max-width: 1560px; margin: 0 auto; display: flex; height: 100vh; }
  @supports (height: 100dvh) { .app-desktop { height: 100dvh; } }

  .app-sidebar {
    width: 248px; flex-shrink: 0; display: flex; flex-direction: column; gap: 22px;
    padding: 28px 22px; background: linear-gradient(180deg,#151A21 0%,#12161C 100%);
    border-right: 1px solid rgba(214,180,92,0.14);
  }
  .sidebar-brand { display: flex; align-items: center; gap: 12px; }
  .sidebar-wordmark { font-family: "Fraunces", serif; font-size: 20px; color: var(--paper); }
  .sidebar-tagline { font-family: "Fraunces", serif; font-style: italic; font-size: 12px; color: rgba(236,227,208,0.55); margin-top: 2px; }
  .sidebar-stats { display: flex; flex-direction: column; gap: 8px; }
  .sidebar-stat {
    display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600;
    color: rgba(236,227,208,0.68); font-family: Inter, sans-serif;
  }
  .sidebar-spacer { flex: 1; }
  .sidebar-foot { display: flex; flex-direction: column; gap: 10px; }
  .sidebar-foot .iconbtn { width: 100%; }

  .app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
  .desktop-sync-banner { margin: 16px 20px 0; }
  .app-panes { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
  .pane { min-width: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
  .pane-tasks { border-right: 1px solid rgba(214,180,92,0.12); }

  /* branding already lives in the sidebar on desktop */
  .pane-tasks .masthead { display: none; }

  /* the bookcase now fills the pane's full width — shelves grow as many books wide as fit */
  .pane-library .sky, .pane-library .tower { width: 100%; }
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
