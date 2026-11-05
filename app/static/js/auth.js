/* ImaraChat landing page: login / sign-up modal, session handling and the
   "start a chat" people picker. The conversation screen lives in chat.js and
   talks to this file through window.ImaraChat and two DOM events:
     imarachat:session      detail = { user | null }   (signed in / out)
     imarachat:chat-opened  detail = ChatResponse      (a chat was started) */
(() => {
  "use strict";

  const API = document.getElementById("app").dataset.api || "/api/v1";
  const STORAGE_KEY = "imarachat.auth";

  const dialog = document.getElementById("auth-dialog");
  const title = document.getElementById("auth-title");
  const subtitle = document.getElementById("auth-subtitle");
  const alertBox = document.getElementById("auth-alert");
  const indicator = document.getElementById("auth-tab-indicator");
  const switchText = document.getElementById("auth-switch-text");
  const switchButton = document.getElementById("auth-switch");
  const forms = {
    login: document.getElementById("login-form"),
    register: document.getElementById("register-form"),
  };
  const tabs = {
    login: document.getElementById("auth-tab-login"),
    register: document.getElementById("auth-tab-register"),
  };

  const COPY = {
    login: {
      title: "Welcome back",
      subtitle: "Log in to continue your conversations.",
      switchText: "New to ImaraChat?",
      switchCta: "Create an account",
      hash: "#login",
    },
    register: {
      title: "Create your account",
      subtitle: "It's free and only takes a minute.",
      switchText: "Already have an account?",
      switchCta: "Log in",
      hash: "#get-started",
    },
  };

  // Mirrors the server-side RegisterRequest / LoginRequest rules.
  const RULES = {
    login: {
      identifier: (v) => (v.trim() ? "" : "Enter your username or email"),
      password: (v) => (v ? "" : "Enter your password"),
    },
    register: {
      name: (v) => (v.trim().length >= 2 ? "" : "Enter your name (at least 2 characters)"),
      username: (v) => {
        const value = v.trim();
        if (value.length < 3) return "Username must be at least 3 characters";
        if (!/^[A-Za-z0-9_.-]+$/.test(value)) return "Use only letters, numbers and . _ -";
        return "";
      },
      email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? "" : "Enter a valid email address"),
      password: (v) => (v.length >= 8 ? "" : "Use at least 8 characters"),
    },
  };

  const SERVER_FIELD_ERRORS = {
    username_taken: ["username", "That username is already taken"],
    email_taken: ["email", "An account with this email already exists"],
  };

  const SERVER_MESSAGES = {
    invalid_credentials: "Incorrect username, email or password.",
    account_disabled: "This account has been disabled.",
  };

  let mode = "login";

  // ── Modal open / close ───────────────────────────────────────────────

  function openAuth(next) {
    setMode(next, { animate: false });
    resetErrors();
    if (!dialog.open) {
      dialog.classList.remove("is-closing");
      dialog.showModal();
      document.documentElement.classList.add("overflow-hidden");
    }
    history.replaceState(null, "", COPY[next].hash);
    focusFirstField();
  }

  function closeAuth() {
    if (!dialog.open || dialog.classList.contains("is-closing")) return;
    dialog.classList.add("is-closing");

    let finished = false;
    const onAnimationEnd = (event) => event.target === dialog && finish();
    const finish = () => {
      if (finished) return;
      finished = true;
      dialog.removeEventListener("animationend", onAnimationEnd);
      dialog.classList.remove("is-closing");
      dialog.close();
      document.documentElement.classList.remove("overflow-hidden");
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    };
    dialog.addEventListener("animationend", onAnimationEnd);
    setTimeout(finish, 320); // fallback when animations are disabled
  }

  function setMode(next, { animate = true } = {}) {
    const previous = mode;
    mode = next;
    const copy = COPY[next];

    title.textContent = copy.title;
    subtitle.textContent = copy.subtitle;
    switchText.textContent = copy.switchText;
    switchButton.textContent = copy.switchCta;
    indicator.classList.toggle("translate-x-full", next === "register");

    for (const [name, tab] of Object.entries(tabs)) {
      const active = name === next;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      forms[name].hidden = !active;
    }

    hideAlert();
    if (animate && previous !== next) {
      const panel = forms[next];
      panel.style.setProperty("--panel-from", next === "register" ? "16px" : "-16px");
      panel.classList.remove("is-entering");
      void panel.offsetWidth; // restart the animation
      panel.classList.add("is-entering");
      if (dialog.open) history.replaceState(null, "", copy.hash);
    }
  }

  function focusFirstField() {
    const input = forms[mode].querySelector("input");
    requestAnimationFrame(() => input && input.focus({ preventScroll: true }));
  }

  // ── Field errors ─────────────────────────────────────────────────────

  function fieldParts(input) {
    const wrapper = input.closest("[data-field]");
    return {
      error: wrapper.querySelector("[data-error]"),
      hint: wrapper.querySelector("[data-hint]"),
    };
  }

  function setFieldError(input, message) {
    const { error, hint } = fieldParts(input);
    if (message) {
      input.setAttribute("aria-invalid", "true");
      error.textContent = message;
      error.classList.replace("hidden", "flex");
      if (hint) hint.classList.add("hidden");
    } else {
      input.removeAttribute("aria-invalid");
      error.textContent = "";
      error.classList.replace("flex", "hidden");
      if (hint) hint.classList.remove("hidden");
    }
  }

  function validateField(formName, input) {
    const rule = RULES[formName][input.name];
    const message = rule ? rule(input.value) : "";
    setFieldError(input, message);
    return !message;
  }

  function validateForm(formName) {
    let firstInvalid = null;
    for (const input of forms[formName].querySelectorAll("input")) {
      if (!validateField(formName, input) && !firstInvalid) firstInvalid = input;
    }
    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
  }

  function resetErrors() {
    hideAlert();
    for (const form of Object.values(forms)) {
      form.querySelectorAll("input").forEach((input) => setFieldError(input, ""));
    }
  }

  function showAlert(message) {
    alertBox.querySelector("[data-message]").textContent = message;
    alertBox.classList.replace("hidden", "flex");
    alertBox.classList.remove("is-shaking");
    void alertBox.offsetWidth;
    alertBox.classList.add("is-shaking");
  }

  function hideAlert() {
    alertBox.classList.replace("flex", "hidden");
  }

  // ── Password helpers ─────────────────────────────────────────────────

  document.querySelectorAll("[data-toggle-password]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.togglePassword);
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
      button.querySelector("[data-icon-show]").classList.toggle("hidden", reveal);
      button.querySelector("[data-icon-hide]").classList.toggle("hidden", !reveal);
      input.focus();
    });
  });

  const strength = document.getElementById("password-strength");
  const STRENGTH_LEVELS = [
    { label: "Too short", color: "bg-rose-400" },
    { label: "Weak", color: "bg-rose-400" },
    { label: "Fair", color: "bg-amber-400" },
    { label: "Good", color: "bg-lime-500" },
    { label: "Strong", color: "bg-brand" },
  ];

  function scorePassword(value) {
    if (value.length < 8) return 0;
    let score = 1;
    if (value.length >= 12) score++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
    if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
    return Math.min(score, 4);
  }

  function renderStrength(value) {
    strength.classList.toggle("hidden", !value);
    const score = scorePassword(value);
    const level = STRENGTH_LEVELS[score];
    strength.querySelectorAll("[data-bar]").forEach((bar, index) => {
      bar.className = "h-1.5 rounded-full transition-colors duration-300 " +
        (index < Math.max(score, 1) && value ? level.color : "bg-slate-200");
    });
    strength.querySelector("[data-strength-label]").textContent = `Password strength: ${level.label}`;
  }

  // Suggest a username from the name until the user edits it themselves.
  const nameInput = document.getElementById("register-name");
  const usernameInput = document.getElementById("register-username");
  let usernameEdited = false;

  function suggestUsername(name) {
    return name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, ".")
      .replace(/[^a-z0-9_.-]/g, "")
      .replace(/\.{2,}/g, ".")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 50);
  }

  nameInput.addEventListener("input", () => {
    if (!usernameEdited) usernameInput.value = suggestUsername(nameInput.value);
  });
  usernameInput.addEventListener("input", () => {
    usernameEdited = usernameInput.value !== "";
  });

  // ── Live validation ──────────────────────────────────────────────────

  for (const [formName, form] of Object.entries(forms)) {
    form.querySelectorAll("input").forEach((input) => {
      input.addEventListener("blur", () => input.value && validateField(formName, input));
      input.addEventListener("input", () => {
        if (input.getAttribute("aria-invalid") === "true") validateField(formName, input);
        if (formName === "register" && input.name === "password") renderStrength(input.value);
      });
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(formName);
    });
  }

  // ── API ──────────────────────────────────────────────────────────────

  function deviceName() {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox"
      : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android"
      : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows"
      : /Linux/.test(ua) ? "Linux" : "web";
    return `${browser} on ${os}`;
  }

  async function api(path, { method = "GET", body, token } = {}) {
    const headers = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (path === "/auth/login" || path === "/auth/register") headers["X-Device-Name"] = deviceName();

    const response = await fetch(API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  function setLoading(form, loading) {
    const button = form.querySelector("button[type=submit]");
    const label = button.querySelector("[data-label]");
    button.disabled = loading;
    button.querySelector("[data-spinner]").classList.toggle("hidden", !loading);
    label.textContent = loading ? label.dataset.loading : label.dataset.idle;
    form.querySelectorAll("input").forEach((input) => (input.readOnly = loading));
  }

  function payloadFor(formName) {
    const data = Object.fromEntries(new FormData(forms[formName]));
    for (const key of Object.keys(data)) {
      if (key !== "password") data[key] = data[key].trim();
    }
    return data;
  }

  function applyServerError(formName, { status, data }) {
    const error = (data && data.error) || {};
    const form = forms[formName];

    const fieldError = SERVER_FIELD_ERRORS[error.code];
    if (fieldError) {
      const input = form.querySelector(`[name="${fieldError[0]}"]`);
      setFieldError(input, fieldError[1]);
      input.focus();
      return;
    }

    if (error.code === "validation_error" && Array.isArray(error.details)) {
      let focused = false;
      for (const detail of error.details) {
        const field = detail.loc && detail.loc[detail.loc.length - 1];
        const input = field && form.querySelector(`[name="${field}"]`);
        if (input) {
          setFieldError(input, detail.msg.replace(/^Value error, /, ""));
          if (!focused) { input.focus(); focused = true; }
        }
      }
      if (focused) return;
    }

    if (status === 429) return showAlert("Too many attempts. Please wait a moment and try again.");
    showAlert(SERVER_MESSAGES[error.code] || error.message || "Something went wrong. Please try again.");
  }

  async function submit(formName) {
    hideAlert();
    if (!validateForm(formName)) return;

    const form = forms[formName];
    setLoading(form, true);
    try {
      const result = await api(formName === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: payloadFor(formName),
      });
      if (!result.ok) {
        applyServerError(formName, result);
        return;
      }

      saveAuth(result.data);
      renderUser(result.data.user);
      closeAuth();
      form.reset();
      usernameEdited = false;
      renderStrength("");
      const firstName = result.data.user.name.split(" ")[0];
      toast(formName === "login" ? `Welcome back, ${firstName}!` : `Welcome to ImaraChat, ${firstName}!`);
    } catch (_) {
      showAlert("Can't reach the server. Check your connection and try again.");
    } finally {
      setLoading(form, false);
    }
  }

  // ── Session ──────────────────────────────────────────────────────────

  function loadAuth() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return null;
    }
  }

  function saveAuth({ user, tokens }) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user, tokens }));
  }

  function clearAuth() {
    localStorage.removeItem(STORAGE_KEY);
  }

  const guestActions = document.getElementById("guest-actions");
  const userActions = document.getElementById("user-actions");

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  }

  let currentUser = null;

  function renderUser(user) {
    currentUser = user || null;
    guestHero.classList.toggle("hidden", Boolean(user));
    if (!user) {
      userActions.classList.replace("flex", "hidden");
      guestActions.classList.replace("hidden", "flex");
      hidePeople();
    } else {
      userActions.querySelector("[data-user-initials]").textContent = initials(user.name);
      userActions.querySelector("[data-user-name]").textContent = user.name;
      userActions.querySelector("[data-user-username]").textContent = `@${user.username}`;
      guestActions.classList.replace("flex", "hidden");
      userActions.classList.replace("hidden", "flex");
    }
    // chat.js decides between the conversation screen and the people picker.
    document.dispatchEvent(new CustomEvent("imarachat:session", { detail: { user: currentUser } }));
  }

  // ── People to chat with ──────────────────────────────────────────────

  const PEOPLE_LIMIT = 5;
  const guestHero = document.getElementById("guest-hero");
  const peopleView = document.getElementById("people-view");
  const peopleSubtitle = peopleView.querySelector("[data-people-subtitle]");
  const peoplePills = peopleView.querySelector("[data-people-pills]");

  const AVATAR_COLORS = [
    "from-[#25d366] to-[#008069]",
    "from-sky-400 to-indigo-600",
    "from-amber-400 to-orange-600",
    "from-rose-400 to-pink-600",
    "from-violet-400 to-purple-700",
    "from-teal-400 to-cyan-700",
  ];

  let peopleFor = null; // user id the list was loaded for

  // The signed-in user can pick their own colour (kept on this device).
  const avatarKey = (id) => `imarachat:avatar-color:${id}`;
  function avatarColorIndex(person) {
    try {
      const saved = parseInt(localStorage.getItem(avatarKey(person.id)), 10);
      if (saved >= 0 && saved < AVATAR_COLORS.length) return saved;
    } catch (_) { /* storage unavailable */ }
    return person.id % AVATAR_COLORS.length;
  }
  function setAvatarColor(person, index) {
    try { localStorage.setItem(avatarKey(person.id), String(index)); } catch (_) { /* ignore */ }
  }

  function avatar(person, sizeClass) {
    const el = document.createElement("span");
    el.className = `grid shrink-0 place-items-center rounded-full bg-gradient-to-br font-bold text-white ${sizeClass} ` +
      AVATAR_COLORS[avatarColorIndex(person)];
    el.textContent = initials(person.name);
    return el;
  }

  const PILL_CLASS = "inline-flex h-11 items-center rounded-full bg-white p-1 text-sm font-semibold " +
    "shadow-sm ring-2 ring-wallpaper transition-all duration-300 hover:-translate-y-px hover:shadow-md hover:ring-brand/40 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60";

  // The first name stays hidden and slides out when the pill is hovered or
  // keyboard-focused; screen readers get the full name through aria-label.
  const PILL_NAME_CLASS = "max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-300 " +
    "group-hover:max-w-32 group-hover:pl-2 group-hover:pr-3 group-hover:opacity-100 " +
    "group-focus-visible:max-w-32 group-focus-visible:pl-2 group-focus-visible:pr-3 group-focus-visible:opacity-100";

  function personPill(person) {
    const item = document.createElement("li");
    item.className = "relative hover:z-10 focus-within:z-10"; // hovered pill rises above its neighbours
    const button = document.createElement("button");
    button.type = "button";
    button.className = `group ${PILL_CLASS}`;
    button.setAttribute("aria-label", `Chat with ${person.name} (@${person.username})`);
    button.append(avatar(person, "size-9 text-xs"));
    const label = document.createElement("span");
    label.className = PILL_NAME_CLASS;
    label.setAttribute("aria-hidden", "true");
    label.textContent = person.name.split(" ")[0];
    button.append(label);
    button.addEventListener("click", () => startChat(person, button));
    item.append(button);
    return item;
  }

  function morePill(remaining) {
    const item = document.createElement("li");
    item.className = "relative hover:z-10 focus-within:z-10"; // hovered pill rises above its neighbours
    const button = document.createElement("button");
    button.type = "button";
    button.className = PILL_CLASS.replace("p-1", "px-4") + " text-brand-dark";
    button.textContent = `+${remaining} more`;
    button.setAttribute("aria-label", `Show ${remaining} more people`);
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", openPeopleDialog);
    item.append(button);
    return item;
  }

  function renderPeople({ items, total }) {
    peopleView.setAttribute("aria-busy", "false");

    if (!items.length) {
      peopleSubtitle.textContent = "No one else is here yet. Invite a friend to ImaraChat to start chatting.";
      peoplePills.replaceChildren();
      return;
    }

    peopleSubtitle.textContent = "Say hello to someone below.";
    const shown = items.slice(0, PEOPLE_LIMIT);
    const pills = shown.map(personPill);
    const remaining = total - shown.length;
    if (remaining > 0) pills.push(morePill(remaining));
    peoplePills.replaceChildren(...pills);
  }

  async function loadPeople() {
    try {
      const result = await authedApi(`/users/discover?limit=${PEOPLE_LIMIT}`);
      if (!loadAuth()) return; // logged out meanwhile
      if (!result.ok) throw new Error(String(result.status));
      renderPeople(result.data);
    } catch (_) {
      peopleView.setAttribute("aria-busy", "false");
      peopleSubtitle.textContent = "Couldn't load people right now. Refresh the page to try again.";
    }
  }

  /** Show the "Start a chat" pills (used when the user has no chats yet). */
  function showPeople() {
    if (!currentUser) return;
    peopleView.classList.replace("hidden", "flex");
    if (peopleFor === currentUser.id) return;
    peopleFor = currentUser.id;
    loadPeople();
  }

  function hidePeople() {
    peopleView.classList.replace("flex", "hidden");
    if (currentUser) return; // keep the loaded pills for a quick return
    closePeopleDialog({ immediate: true });
    peopleFor = null;
    peoplePills.replaceChildren();
    peopleSubtitle.textContent = "Finding people to talk to…";
    peopleView.setAttribute("aria-busy", "true");
  }

  async function startChat(person, button, { quietError = false } = {}) {
    button.disabled = true;
    try {
      const result = await authedApi("/chats", { method: "POST", body: { user_id: person.id } });
      if (!result.ok) throw new Error(String(result.status));
      document.dispatchEvent(new CustomEvent("imarachat:chat-opened", { detail: result.data }));
      return true;
    } catch (_) {
      if (!quietError) toast(`Couldn't start a chat with ${person.name.split(" ")[0]}. Please try again.`);
      return false;
    } finally {
      button.disabled = false;
    }
  }

  // ── "New chat" dialog: everyone, grouped A–Z ─────────────────────────

  const DIRECTORY_LIMIT = 500;
  const peopleDialog = document.getElementById("people-dialog");
  const peopleSearch = document.getElementById("people-search");
  const peopleCount = peopleDialog.querySelector("[data-people-count]");
  const peopleScroll = peopleDialog.querySelector("[data-people-scroll]");
  const peopleList = peopleDialog.querySelector("[data-people-list]");
  const peopleEmpty = peopleDialog.querySelector("[data-people-empty]");

  let directory = { items: [], total: 0 }; // everyone loaded for the dialog
  let searchSeq = 0; // ignores out-of-order search responses
  let searchTimer;

  /** Lowercase and strip accents so "jose" matches "José". */
  function fold(value) {
    return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  /** Section letter for a name; anything that isn't A–Z goes under "#". */
  function letterOf(name) {
    const first = fold(name.trim()).charAt(0).toUpperCase();
    return /^[A-Z]$/.test(first) ? first : "#";
  }

  function groupByLetter(people) {
    const sorted = [...people].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const groups = new Map();
    for (const person of sorted) {
      const letter = letterOf(person.name);
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(person);
    }
    // WhatsApp lists the "#" bucket after Z.
    return [...groups].sort(([a], [b]) => (a === "#") - (b === "#") || a.localeCompare(b));
  }

  function personRow(person, isLast) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "flex w-full items-center gap-3 px-5 text-left transition hover:bg-slate-50 " +
      "focus-visible:bg-slate-50 focus-visible:outline-none disabled:opacity-60 sm:px-6";
    button.setAttribute("aria-label", `Chat with ${person.name} (@${person.username})`);
    button.append(avatar(person, "size-11 text-sm"));

    const text = document.createElement("span");
    text.className = "min-w-0 flex-1 py-3" + (isLast ? "" : " border-b border-slate-100");
    const name = document.createElement("span");
    name.className = "block truncate text-[15px] font-semibold";
    name.textContent = person.name;
    const username = document.createElement("span");
    username.className = "block truncate text-sm text-slate-500";
    username.textContent = `@${person.username}`;
    text.append(name, username);
    button.append(text);

    button.addEventListener("click", async () => {
      if (await startChat(person, button, { quietError: true })) {
        closePeopleDialog();
      } else {
        // A toast would sit behind the modal, so report the error inline.
        peopleCount.textContent = `Couldn't start a chat with ${person.name.split(" ")[0]}. Please try again.`;
      }
    });
    item.append(button);
    return item;
  }

  function renderDirectory(people, query) {
    peopleList.replaceChildren(
      ...groupByLetter(people).map(([letter, members]) => {
        const section = document.createElement("section");
        const headingId = `people-letter-${letter === "#" ? "other" : letter}`;
        section.setAttribute("aria-labelledby", headingId);
        const heading = document.createElement("h3");
        heading.id = headingId;
        heading.className = "sticky top-0 z-10 bg-white/95 px-5 pb-1 pt-3 text-xs font-semibold uppercase " +
          "tracking-wide text-brand-dark backdrop-blur sm:px-6";
        heading.textContent = letter;
        const list = document.createElement("ul");
        list.append(...members.map((person, index) => personRow(person, index === members.length - 1)));
        section.append(heading, list);
        return section;
      })
    );

    const searching = Boolean(query);
    peopleEmpty.classList.toggle("hidden", people.length > 0);
    peopleEmpty.textContent = searching
      ? `No one matches “${query}”.`
      : "No one else is here yet. Invite a friend to ImaraChat to start chatting.";
    peopleCount.textContent = searching
      ? `${people.length} ${people.length === 1 ? "result" : "results"}`
      : `${directory.total} ${directory.total === 1 ? "person" : "people"}`;
  }

  function renderDirectoryLoading() {
    peopleEmpty.classList.add("hidden");
    peopleCount.textContent = "Loading…";
    const rows = Array.from({ length: 7 }, () => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-3 px-5 py-3 sm:px-6";
      row.innerHTML = '<span class="size-11 shrink-0 animate-pulse rounded-full bg-slate-100"></span>' +
        '<span class="flex-1 space-y-2"><span class="block h-3.5 w-2/5 animate-pulse rounded bg-slate-100"></span>' +
        '<span class="block h-3 w-1/4 animate-pulse rounded bg-slate-100"></span></span>';
      return row;
    });
    peopleList.replaceChildren(...rows);
  }

  async function fetchDirectory(query = "") {
    const params = new URLSearchParams({ sort: "name", limit: String(DIRECTORY_LIMIT) });
    if (query) params.set("q", query);
    const result = await authedApi(`/users/discover?${params}`);
    if (!result.ok) throw new Error(String(result.status));
    return result.data;
  }

  async function runSearch() {
    const query = peopleSearch.value.trim();
    const seq = ++searchSeq;
    peopleScroll.scrollTop = 0;

    if (!query) return renderDirectory(directory.items, "");

    // Everyone is already loaded: filter locally, instantly.
    if (directory.items.length >= directory.total) {
      const needle = fold(query).replace(/^@/, "");
      const matches = directory.items.filter((person) =>
        fold(person.name).includes(needle) || fold(person.username).includes(needle));
      return renderDirectory(matches, query);
    }

    // Large directories are only partly loaded: ask the server.
    try {
      const data = await fetchDirectory(query.replace(/^@/, ""));
      if (seq === searchSeq) renderDirectory(data.items, query);
    } catch (_) {
      if (seq !== searchSeq) return;
      // A toast would sit behind the modal, so report the error inline.
      peopleList.replaceChildren();
      peopleCount.textContent = "";
      peopleEmpty.textContent = "Search failed. Check your connection and try again.";
      peopleEmpty.classList.remove("hidden");
    }
  }

  async function openPeopleDialog() {
    if (peopleDialog.open) return;
    peopleSearch.value = "";
    peopleScroll.scrollTop = 0;
    renderDirectoryLoading();
    peopleDialog.classList.remove("is-closing");
    peopleDialog.showModal();
    document.documentElement.classList.add("overflow-hidden");
    // Don't pop the on-screen keyboard on phones.
    if (matchMedia("(min-width: 640px)").matches) peopleSearch.focus({ preventScroll: true });

    const seq = ++searchSeq;
    try {
      directory = await fetchDirectory();
      if (seq === searchSeq) renderDirectory(directory.items, "");
      else runSearch(); // the user typed while we were loading
    } catch (_) {
      closePeopleDialog();
      toast("Couldn't load people. Please try again.");
    }
  }

  function closePeopleDialog({ immediate = false } = {}) {
    if (!peopleDialog.open || peopleDialog.classList.contains("is-closing")) return;
    clearTimeout(searchTimer);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      peopleDialog.removeEventListener("animationend", onAnimationEnd);
      peopleDialog.classList.remove("is-closing");
      peopleDialog.close();
      if (!dialog.open) document.documentElement.classList.remove("overflow-hidden");
    };
    const onAnimationEnd = (event) => event.target === peopleDialog && finish();
    if (immediate) return finish();
    peopleDialog.classList.add("is-closing");
    peopleDialog.addEventListener("animationend", onAnimationEnd);
    setTimeout(finish, 320); // fallback when animations are disabled
  }

  peopleSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 150);
  });
  peopleDialog.querySelector("[data-people-close]").addEventListener("click", () => closePeopleDialog());
  // First Esc clears the search, like most pickers; the next one closes.
  peopleSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && peopleSearch.value) {
      event.preventDefault(); // also stops the dialog's own cancel
      peopleSearch.value = "";
      runSearch();
    }
  });
  peopleDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePeopleDialog();
  });
  peopleDialog.addEventListener("mousedown", (event) => {
    if (event.target === peopleDialog) closePeopleDialog();
  });

  // One refresh at a time: refresh tokens rotate, so two parallel refreshes
  // would make the second one fail as "already used".
  let refreshing = null;

  function refreshTokens() {
    if (!refreshing) {
      refreshing = (async () => {
        const auth = loadAuth();
        if (!auth || !auth.tokens) return null;
        const refreshed = await api("/auth/refresh", {
          method: "POST",
          body: { refresh_token: auth.tokens.refresh_token },
        });
        if (!refreshed.ok) {
          if (refreshed.status === 401) {
            clearAuth();
            renderUser(null);
          }
          return null;
        }
        saveAuth(refreshed.data);
        return refreshed.data;
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  /** Call the API as the signed-in user, refreshing the access token once on 401. */
  async function authedApi(path, options = {}) {
    const auth = loadAuth();
    if (!auth || !auth.tokens) return { ok: false, status: 401, data: {} };
    const result = await api(path, { ...options, token: auth.tokens.access_token });
    if (result.status !== 401) return result;
    const refreshed = await refreshTokens();
    if (!refreshed) return result;
    return api(path, { ...options, token: refreshed.tokens.access_token });
  }

  async function restoreSession() {
    const auth = loadAuth();
    if (!auth || !auth.tokens) return;
    renderUser(auth.user);

    try {
      const me = await authedApi("/auth/me");
      if (me.ok) {
        const current = loadAuth();
        if (current) saveAuth({ user: me.data, tokens: current.tokens });
        renderUser(me.data);
      }
    } catch (_) {
      /* Offline: keep showing the cached user. */
    }
  }

  document.getElementById("logout-button").addEventListener("click", async () => {
    const auth = loadAuth();
    clearAuth();
    renderUser(null);
    toast("You've been logged out.");
    if (auth && auth.tokens) {
      api("/auth/logout", { method: "POST", token: auth.tokens.access_token }).catch(() => {});
    }
  });

  // ── Toast ────────────────────────────────────────────────────────────

  const toastEl = document.getElementById("toast");
  let toastTimer;

  function toast(message) {
    toastEl.querySelector("[data-message]").textContent = message;
    toastEl.classList.remove("opacity-0", "translate-y-4");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("opacity-0", "translate-y-4"), 3200);
  }

  // ── Wiring ───────────────────────────────────────────────────────────

  document.querySelectorAll("[data-auth-open]").forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      openAuth(trigger.dataset.authOpen);
    });
  });

  for (const [name, tab] of Object.entries(tabs)) {
    tab.addEventListener("click", () => {
      setMode(name);
      focusFirstField();
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const next = name === "login" ? "register" : "login";
        setMode(next);
        tabs[next].focus();
      }
    });
  }

  switchButton.addEventListener("click", () => {
    setMode(mode === "login" ? "register" : "login");
    focusFirstField();
  });

  dialog.querySelector("[data-auth-close]").addEventListener("click", closeAuth);

  // Esc: animate out instead of closing instantly.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAuth();
  });

  // Click on the backdrop (the <dialog> itself, outside the panel).
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeAuth();
  });

  // Deep links: /#login and /#get-started open the modal.
  function openFromHash() {
    if (location.hash === "#login") openAuth("login");
    else if (location.hash === "#get-started" || location.hash === "#signup") openAuth("register");
  }

  window.addEventListener("hashchange", openFromHash);

  // Shared with chat.js.
  window.ImaraChat = {
    authedApi,
    refreshTokens,
    loadAuth,
    avatar,
    AVATAR_COLORS,
    avatarColorIndex,
    setAvatarColor,
    initials,
    fold,
    toast,
    showPeople,
    hidePeople,
    openPeopleDialog,
    get user() { return currentUser; },
  };

  // Deferred scripts run before DOMContentLoaded, so chat.js is listening by then.
  document.addEventListener("DOMContentLoaded", () => {
    restoreSession();
    openFromHash();
  });
})();
