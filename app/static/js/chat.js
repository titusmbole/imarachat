/* ImaraChat conversation screen: chat list, message thread, composer and the
   Socket.IO connection (messages, ticks, typing, presence).

   Shown instead of the "Start a chat" pills once the user has at least one
   chat. Shared helpers come from auth.js through window.ImaraChat. */
(() => {
  "use strict";

  const app = window.ImaraChat;
  const media = app.attachments;
  const API = document.getElementById("app").dataset.api || "/api/v1";
  const MAX_FILES = 10; // per message, matches the server
  const MAX_FILE_MB = 25; // matches settings.MAX_UPLOAD_MB
  const PAGE_SIZE = 40;
  const TYPING_IDLE_MS = 3000; // stop "typing…" after this much quiet
  const TYPING_EXPIRE_MS = 6000; // drop a peer's "typing…" if no stop arrives
  const GROUP_GAP_MS = 5 * 60 * 1000; // same-sender bubbles closer than this are grouped
  const STATUS_RANK = { failed: -1, pending: 0, sent: 1, delivered: 2, read: 3 };

  // ── DOM ──────────────────────────────────────────────────────────────

  const main = document.querySelector("main");
  const loading = document.getElementById("session-loading");
  const view = document.getElementById("chat-view");
  const $ = (selector) => view.querySelector(selector);

  const chatSearch = document.getElementById("chat-search");
  const chatListScroll = $("[data-chat-list-scroll]");
  const chatList = $("[data-chat-list]");
  const chatListEmpty = $("[data-chat-list-empty]");

  const emptyPane = $("[data-conversation-empty]");
  const activePane = $("[data-conversation-active]");
  const peerAvatar = $("[data-peer-avatar]");
  const peerName = $("[data-peer-name]");
  const peerStatus = $("[data-peer-status]");
  const scroller = $("[data-messages-scroll]");
  const messagesTop = $("[data-messages-top]");
  const messageList = $("[data-messages]");
  const jumpButton = $("[data-jump-bottom]");
  const jumpCount = $("[data-jump-count]");
  const composer = $("[data-composer]");
  const input = document.getElementById("composer-input");
  const sendButton = $("[data-composer-send]");
  const announcer = $("[data-chat-announcer]");

  // ── State ────────────────────────────────────────────────────────────

  let me = null; // signed-in user
  let sessionSeq = 0; // bumps on sign in / out so stale responses are ignored
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  /** chat id -> { chat, messages[], loaded, loading, hasMore, nextBeforeId, typing, typingTimer, unseen } */
  const chats = new Map();
  const online = new Set(); // user ids with a live socket
  let activeId = null;
  let typingSent = false;
  let typingTimer = null;

  // ── Small helpers ────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Server datetimes may arrive without a zone; they are UTC. */
  function parseDate(value) {
    if (!value) return null;
    const text = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function daysAgo(date) {
    return Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  }

  function clock(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /** Chat list stamp: 14:05 · Yesterday · Tuesday · 12/03/2026 */
  function listStamp(date) {
    if (!date) return "";
    const days = daysAgo(date);
    if (days <= 0) return clock(date);
    if (days === 1) return "Yesterday";
    if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
    return date.toLocaleDateString();
  }

  /** Day separator inside a thread. */
  function dayLabel(date) {
    const days = daysAgo(date);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
    return date.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
  }

  function clientId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function firstName(person) {
    return (person && person.name ? person.name : "").split(" ")[0] || "them";
  }

  function chatTime(chat) {
    const last = chat.last_message;
    return parseDate((last && last.created_at) || chat.last_message_at || chat.created_at);
  }

  function isMine(message) {
    return Boolean(me && message.sender && message.sender.id === me.id);
  }

  function isPageVisible() {
    return document.visibilityState === "visible";
  }

  // ── Ticks ────────────────────────────────────────────────────────────

  const SVG_NS = "http://www.w3.org/2000/svg";
  const TICK_PATHS = {
    single: ["M2.5 8.5 6 12l7.5-8"],
    double: ["M1 8.5 4.5 12 12 4", "M8 11l1 1 7.5-8"],
    clock: ["M8 4.5V8l2.5 1.5", "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z"],
    failed: ["M8 4.5v4", "M8 11.2v.1", "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z"],
  };

  /** WhatsApp-style status: clock, ✓ sent, ✓✓ delivered, blue ✓✓ read. */
  function ticks(status, sizeClass = "h-[15px] w-4") {
    const kind = status === "pending" ? "clock" : status === "failed" ? "failed"
      : status === "sent" ? "single" : "double";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", kind === "double" ? "0 0 17 16" : "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `inline-block shrink-0 ${sizeClass} ` +
      (status === "read" ? "text-[#53bdeb]" : status === "failed" ? "text-rose-500" : "text-slate-400"));
    for (const d of TICK_PATHS[kind]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  const STATUS_TEXT = {
    pending: "Sending", failed: "Not sent", sent: "Sent", delivered: "Delivered", read: "Read",
  };

  // ── Views ────────────────────────────────────────────────────────────

  function showLoading() {
    main.classList.remove("hidden");
    view.classList.add("hidden");
    loading.classList.remove("hidden");
    app.hidePeople();
  }

  function showChatView() {
    loading.classList.add("hidden");
    app.hidePeople();
    main.classList.add("hidden");
    view.classList.remove("hidden");
    view.classList.add("flex");
  }

  /** No chats yet: back to the "Start a chat" pills. */
  function showPeopleView() {
    loading.classList.add("hidden");
    view.classList.add("hidden");
    view.classList.remove("flex");
    main.classList.remove("hidden");
    app.showPeople();
  }

  function hideAll() {
    loading.classList.add("hidden");
    view.classList.add("hidden");
    view.classList.remove("flex");
    main.classList.remove("hidden");
  }

  const mobile = matchMedia("(max-width: 767px)");

  function setPane(pane) {
    view.dataset.pane = pane;
  }

  // ── Chat list ────────────────────────────────────────────────────────

  function stateFor(chat) {
    let state = chats.get(chat.id);
    if (!state) {
      state = {
        chat, messages: [], loaded: false, loading: false, hasMore: false,
        nextBeforeId: null, typing: false, typingTimer: null, unseen: 0,
      };
      chats.set(chat.id, state);
    } else {
      // Keep the freshest last message we know about.
      const known = state.chat.last_message;
      const incoming = chat.last_message;
      state.chat = { ...state.chat, ...chat };
      if (known && (!incoming || (known.id || Infinity) > incoming.id)) state.chat.last_message = known;
    }
    return state;
  }

  function sortedChats() {
    return [...chats.values()].sort((a, b) =>
      (b.chat.is_pinned - a.chat.is_pinned) ||
      ((chatTime(b.chat) || 0) - (chatTime(a.chat) || 0)));
  }

  function previewOf(state) {
    const { chat } = state;
    const wrap = el("span", "flex min-w-0 flex-1 items-center gap-1 text-sm text-slate-500");
    if (state.typing) {
      wrap.append(el("span", "truncate font-medium text-brand", "typing…"));
      return wrap;
    }
    const last = chat.last_message;
    if (!last) {
      wrap.append(el("span", "truncate italic", "No messages yet — say hi!"));
      return wrap;
    }
    if (isMine(last) && !last.deleted_at) wrap.append(ticks(last.status));
    const text = last.deleted_at
      ? (isMine(last) ? "You deleted this message" : "This message was deleted")
      : media.preview(last);
    wrap.append(el("span", "truncate" + (last.deleted_at ? " italic" : ""), text));
    return wrap;
  }

  function avatarWithPresence(person, sizeClass, dotClass) {
    const holder = el("span", "relative block shrink-0");
    holder.append(app.avatar(person || { id: 0, name: "?" }, sizeClass));
    if (person && online.has(person.id)) {
      const dot = el("span", `absolute bottom-0 right-0 rounded-full bg-[#25d366] ring-2 ring-white ${dotClass}`);
      dot.setAttribute("aria-hidden", "true");
      holder.append(dot);
    }
    return holder;
  }

  function chatRow(state) {
    const { chat } = state;
    const peer = chat.peer || { id: 0, name: "Unknown user", username: "unknown" };
    const unread = chat.unread_count || 0;
    const active = chat.id === activeId;

    const item = el("li");
    const button = el("button",
      "flex w-full items-center gap-3 px-3 text-left transition focus-visible:outline-none " +
      (active ? "bg-slate-100" : "hover:bg-slate-50 focus-visible:bg-slate-50"));
    button.type = "button";
    button.dataset.chatId = String(chat.id);
    if (active) button.setAttribute("aria-current", "true");
    const labelBits = [peer.name];
    if (unread) labelBits.push(`${unread} unread`);
    if (state.typing) labelBits.push("typing");
    button.setAttribute("aria-label", labelBits.join(", "));

    button.append(avatarWithPresence(peer, "size-12 text-sm", "size-3"));

    const body = el("span", "min-w-0 flex-1 border-b border-slate-100 py-3");
    const top = el("span", "flex items-baseline justify-between gap-2");
    top.append(el("span", "truncate text-[15px] font-semibold text-ink", peer.name));
    top.append(el("span", "shrink-0 text-xs " + (unread ? "font-semibold text-[#1fa855]" : "text-slate-500"),
      listStamp(chatTime(chat))));
    const bottom = el("span", "mt-0.5 flex items-center gap-2");
    bottom.append(previewOf(state));
    if (unread) {
      bottom.append(el("span",
        "grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[#25d366] px-1.5 text-[11px] font-bold text-white",
        unread > 99 ? "99+" : String(unread)));
    }
    body.append(top, bottom);
    button.append(body);
    button.addEventListener("click", () => openChat(chat.id));
    item.append(button);
    return item;
  }

  function renderChatList() {
    const query = app.fold(chatSearch.value.trim()).replace(/^@/, "");
    const rows = sortedChats().filter(({ chat }) => {
      if (!query) return true;
      const peer = chat.peer || {};
      return app.fold(peer.name || "").includes(query) || app.fold(peer.username || "").includes(query);
    });
    chatList.replaceChildren(...rows.map(chatRow));
    chatListEmpty.classList.toggle("hidden", rows.length > 0);
    chatListEmpty.textContent = query ? `No chats match “${chatSearch.value.trim()}”.` : "No chats yet.";
  }

  // ── Conversation header ──────────────────────────────────────────────

  function renderHeader() {
    const state = chats.get(activeId);
    if (!state) return;
    const peer = state.chat.peer || { id: 0, name: "Unknown user", username: "unknown" };
    peerAvatar.replaceChildren(avatarWithPresence(peer, "size-10 text-sm", "size-2.5"));
    peerName.textContent = peer.name;
    if (state.typing) {
      peerStatus.textContent = "typing…";
      peerStatus.className = "truncate text-xs font-medium text-brand";
    } else if (online.has(peer.id)) {
      peerStatus.textContent = "online";
      peerStatus.className = "truncate text-xs text-slate-500";
    } else {
      peerStatus.textContent = `@${peer.username}`;
      peerStatus.className = "truncate text-xs text-slate-500";
    }
  }

  // ── Messages ─────────────────────────────────────────────────────────

  function messageKey(message) {
    return message.id ? `m${message.id}` : `c${message.client_message_id}`;
  }

  /** Insert or update a message, matching optimistic copies by client id.
      Until a thread's history is loaded only the chat preview is updated, so
      the thread never shows live messages with older ones missing between. */
  function upsertMessage(state, message) {
    if (!state.loaded && !state.loading && message.id) {
      const known = state.chat.last_message;
      if (!known || !known.id || message.id >= known.id) {
        state.chat.last_message = known && known.id === message.id ? { ...known, ...message } : message;
        if (message.created_at) state.chat.last_message_at = message.created_at;
        return !known || known.id !== message.id;
      }
      return false;
    }
    const list = state.messages;
    let index = message.id ? list.findIndex((m) => m.id === message.id) : -1;
    if (index < 0 && message.client_message_id) {
      index = list.findIndex((m) => m.client_message_id === message.client_message_id && isMine(m) === isMine(message));
    }
    let isNew = false;
    if (index >= 0) {
      const old = list[index];
      // Never move ticks backwards (a late MSG_SENT after MSG_READ, say).
      const status = (STATUS_RANK[old.status] || 0) > (STATUS_RANK[message.status] || 0) && message.id
        ? old.status : message.status;
      list[index] = { ...old, ...message, status };
    } else {
      list.push(message);
      isNew = true;
    }
    // Server messages in id order; unsent ones stay at the end.
    list.sort((a, b) => (a.id || Infinity) - (b.id || Infinity));

    const last = list[list.length - 1];
    const known = state.chat.last_message;
    if (last && (!known || !known.id || !last.id || last.id >= known.id)) {
      state.chat.last_message = last;
      if (last.created_at) state.chat.last_message_at = last.created_at;
    } else if (known && message.id === known.id) {
      state.chat.last_message = { ...known, ...message };
    }
    return isNew;
  }

  function applyStatus(update) {
    const state = chats.get(update.chat_id);
    if (!state) return;
    const apply = (message) => {
      if (!message || message.id !== update.message_id) return false;
      if ((STATUS_RANK[update.status] || 0) < (STATUS_RANK[message.status] || 0)) return true;
      message.status = update.status;
      if (update.delivered_at) message.delivered_at = update.delivered_at;
      if (update.read_at) message.read_at = update.read_at;
      return true;
    };
    state.messages.forEach(apply);
    apply(state.chat.last_message);
    renderChatList();
    if (update.chat_id === activeId) renderMessages({ keep: true });
  }

  function isNearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  // Whether the reader is following the newest messages. Late layout changes
  // (styles, fonts, emoji) must not push them off the bottom.
  let pinned = true;

  function scrollToBottom() {
    pinned = true;
    scroller.scrollTop = scroller.scrollHeight;
  }

  const pinObserver = new ResizeObserver(() => {
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
  });
  pinObserver.observe(messageList);
  pinObserver.observe(scroller); // the composer grew (emoji panel, file tray)

  function bubble(message, { first, mine }) {
    const row = el("li", `flex items-start gap-3 ${mine ? "justify-end" : "justify-start"} ${first ? "mt-3" : "mt-0.5"}`);
    row.dataset.key = messageKey(message);

    const attachments = (!message.deleted_at && message.attachments) || [];
    const box = el("div",
      "relative max-w-[85%] rounded-lg text-[14.5px] leading-[20px] text-ink shadow-[0_1px_0.5px_rgba(11,20,26,.13)] sm:max-w-[65%] " +
      (attachments.length ? "p-1 " : "px-2.5 pb-1.5 pt-1.5 ") +
      (mine ? "bg-[#d9fdd3]" : "bg-white") +
      (first ? (mine ? " rounded-tr-none" : " rounded-tl-none") : ""));

    if (first) {
      // Bubble tail.
      const tail = document.createElementNS(SVG_NS, "svg");
      tail.setAttribute("viewBox", "0 0 8 13");
      tail.setAttribute("aria-hidden", "true");
      tail.setAttribute("class", `absolute top-0 h-[13px] w-2 ${mine ? "-right-2 text-[#d9fdd3]" : "-left-2 text-white"}`);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("fill", "currentColor");
      path.setAttribute("d", mine ? "M0 0h8L0 13z" : "M8 0H0l8 13z");
      tail.append(path);
      box.append(tail);
    }

    const created = parseDate(message.created_at) || new Date();
    const meta = el("span", "flex items-center gap-1 whitespace-nowrap text-[11px] leading-none text-slate-500");
    if (message.edited_at && !message.deleted_at) meta.append(el("span", "", "edited"));
    meta.append(el("time", "", clock(created)));
    if (mine && !message.deleted_at) meta.append(ticks(message.status));

    let mediaHost = null;
    if (attachments.length) {
      const uploading = uploadProgress.has(message.client_message_id) && message.status === "pending";
      const view = media.render(message, { progress: uploading ? uploadProgress.get(message.client_message_id) : null });
      box.append(view.node);
      mediaHost = view.mediaHost;
    }

    if (!attachments.length || message.content) {
      const text = el("span", "whitespace-pre-wrap break-words [overflow-wrap:anywhere]");
      if (message.deleted_at) {
        text.className += " italic text-slate-500";
        text.textContent = mine ? "You deleted this message" : "This message was deleted";
      } else {
        text.textContent = message.content || "";
      }

      // An invisible copy of the meta reserves room so the visible one can sit
      // in the bottom-right corner without overlapping the last line of text.
      const spacer = meta.cloneNode(true);
      spacer.className = "invisible ml-2 inline-flex items-center gap-1 align-bottom text-[11px] leading-none";
      spacer.setAttribute("aria-hidden", "true");
      meta.className += " absolute bottom-1.5 right-2";

      const textWrap = el("div", attachments.length ? "px-1.5 pb-0.5 pt-1" : "");
      textWrap.append(text, spacer);
      box.append(textWrap, meta);
    } else if (mediaHost) {
      // Photo without a caption: the time sits on the photo, like WhatsApp.
      meta.className = meta.className.replace("text-slate-500", "text-white") +
        " pointer-events-none absolute bottom-0 right-0 z-[1] rounded-tl-lg bg-gradient-to-tl from-black/50 via-black/20 to-transparent px-2 pb-1.5 pt-4 pl-6";
      mediaHost.append(meta);
    } else {
      meta.className += " justify-end px-1.5 pt-1";
      box.append(meta);
    }

    const sr = el("span", "sr-only",
      `${mine ? "You" : message.sender ? message.sender.name : "Them"}, ${clock(created)}` +
      (mine && !message.deleted_at ? `, ${STATUS_TEXT[message.status] || ""}` : ""));
    box.prepend(sr);

    if (message.status === "failed") {
      const retry = el("button",
        "mt-1 block text-xs font-semibold text-rose-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400",
        "Not sent — tap to retry");
      retry.type = "button";
      retry.addEventListener("click", () => resend(message));
      box.append(retry);
    }

    // Avatar beside the first bubble of each group; later bubbles keep a
    // blank slot of the same width so they stay aligned.
    const person = mine ? app.user : (message.sender || (chats.get(activeId)?.chat.peer));
    const slot = first && person
      ? el("span", "block shrink-0")
      : el("span", "block size-8 shrink-0", "");
    if (first && person) slot.append(app.avatar(person, "size-8 text-xs"));
    slot.setAttribute("aria-hidden", "true");

    if (mine) row.append(box, slot);
    else row.append(slot, box);
    return row;
  }

  /** Re-render the open thread. Stays pinned to the bottom if the reader was there. */
  function renderMessages({ stick = false } = {}) {
    const state = chats.get(activeId);
    if (!state) return;
    const wasNearBottom = isNearBottom();

    const nodes = [];
    let previous = null;
    let lastDay = null;
    for (const message of state.messages) {
      const created = parseDate(message.created_at) || new Date();
      const day = startOfDay(created);
      if (day !== lastDay) {
        const sep = el("li", "sticky top-0 z-10 my-2 flex justify-center");
        sep.append(el("span",
          "rounded-lg bg-white/95 px-3 py-1 text-xs font-medium text-slate-600 shadow-[0_1px_0.5px_rgba(11,20,26,.13)]",
          dayLabel(created)));
        nodes.push(sep);
        lastDay = day;
        previous = null;
      }
      const mine = isMine(message);
      const prevCreated = previous && (parseDate(previous.created_at) || new Date());
      const first = !previous || isMine(previous) !== mine ||
        (prevCreated && created - prevCreated > GROUP_GAP_MS);
      nodes.push(bubble(message, { first, mine }));
      previous = message;
    }
    messageList.replaceChildren(...nodes);

    if (state.loading && !state.loaded) messagesTop.textContent = "Loading messages…";
    else if (state.loading) messagesTop.textContent = "Loading earlier messages…";
    else if (state.loaded && !state.hasMore && state.messages.length) messagesTop.textContent = "";
    else if (state.loaded && !state.messages.length) {
      messagesTop.textContent = `This is the start of your chat with ${firstName(state.chat.peer)}. Say hello!`;
    } else messagesTop.textContent = "";

    if (stick || wasNearBottom) scrollToBottom();
    updateJumpButton();
  }

  function updateJumpButton() {
    const state = chats.get(activeId);
    const show = !isNearBottom();
    jumpButton.classList.toggle("hidden", !show);
    jumpButton.classList.toggle("grid", show);
    const unseen = state ? state.unseen : 0;
    jumpCount.classList.toggle("hidden", !(show && unseen));
    jumpCount.textContent = unseen > 99 ? "99+" : String(unseen);
    if (!show && state && state.unseen) state.unseen = 0;
  }

  async function loadMessages(state, { older = false } = {}) {
    if (state.loading || (older && !state.hasMore)) return;
    const seq = sessionSeq;
    state.loading = true;
    if (state.chat.id === activeId) renderMessages({ keep: true });

    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (older && state.nextBeforeId) params.set("before_id", String(state.nextBeforeId));
    try {
      const result = await app.authedApi(`/chats/${state.chat.id}/messages?${params}`);
      if (seq !== sessionSeq) return;
      if (!result.ok) throw new Error(String(result.status));
      const page = result.data;

      const heightBefore = scroller.scrollHeight;
      const topBefore = scroller.scrollTop;
      if (!older) {
        // A newest page that doesn't reach what we hold (lots arrived while we
        // were away) would leave a hole in the thread: start over from it.
        const newestKnown = Math.max(0, ...state.messages.filter((m) => m.id).map((m) => m.id));
        const oldestInPage = page.items.length ? page.items[0].id : Infinity;
        if (page.has_more && newestKnown && oldestInPage > newestKnown) {
          state.messages = state.messages.filter((m) => !m.id);
        }
      }
      for (const message of page.items) upsertMessage(state, message);
      state.hasMore = page.has_more;
      state.nextBeforeId = page.next_before_id;
      state.loaded = true;
      state.loading = false;

      if (state.chat.id === activeId) {
        if (older) {
          renderMessages({ keep: true });
          // Keep the reader's place when older messages are prepended.
          scroller.scrollTop = topBefore + (scroller.scrollHeight - heightBefore);
        } else {
          renderMessages({ stick: true });
          markRead(state);
        }
      }
      renderChatList();
    } catch (_) {
      state.loading = false;
      if (seq !== sessionSeq) return;
      if (state.chat.id === activeId) {
        renderMessages({ keep: true });
        messagesTop.textContent = "";
        const retry = el("button", "font-semibold text-brand-dark hover:underline", "Couldn't load messages. Retry");
        retry.type = "button";
        retry.addEventListener("click", () => loadMessages(state, { older }));
        messagesTop.replaceChildren(retry);
      }
    }
  }

  scroller.addEventListener("scroll", () => {
    pinned = isNearBottom();
    const state = chats.get(activeId);
    if (!pinned && state && state.loaded && state.hasMore && scroller.scrollTop < 150) {
      loadMessages(state, { older: true });
    }
    updateJumpButton();
  }, { passive: true });

  jumpButton.addEventListener("click", () => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  });

  // ── Opening / closing chats ──────────────────────────────────────────

  function openChat(chatId, { focus = true } = {}) {
    const state = chats.get(chatId);
    if (!state) return;
    if (activeId !== chatId) stopTyping();
    const switching = activeId !== chatId;
    if (switching) setChatMenu(false);
    activeId = chatId;
    sessionStorage.setItem("imarachat.activeChat", String(chatId));

    emptyPane.classList.add("hidden");
    activePane.classList.remove("hidden");
    activePane.classList.add("flex");

    if (mobile.matches && view.dataset.pane !== "chat") {
      setPane("chat");
      history.pushState({ imarachatChat: chatId }, "");
    }

    renderHeader();
    renderChatList();
    if (switching) {
      state.unseen = 0;
      clearPicked();
      closeAttachMenu();
      toggleEmoji(false);
      input.value = drafts.get(chatId) || "";
      resizeInput();
    }
    renderMessages({ stick: true });
    if (!state.loaded) loadMessages(state);
    else markRead(state);

    if (focus && !mobile.matches) input.focus({ preventScroll: true });
  }

  function closeChat({ fromHistory = false } = {}) {
    stopTyping();
    if (activeId !== null) drafts.set(activeId, input.value);
    activeId = null;
    sessionStorage.removeItem("imarachat.activeChat");
    activePane.classList.add("hidden");
    activePane.classList.remove("flex");
    emptyPane.classList.remove("hidden");
    setPane("list");
    renderChatList();
    if (!fromHistory && history.state && history.state.imarachatChat) history.back();
  }

  $("[data-conversation-back]").addEventListener("click", () => closeChat());

  // ── Chat actions menu (header, top right) ────────────────────────────

  const chatMenu = $("[data-chat-menu]");
  const chatMenuToggle = $("[data-chat-menu-toggle]");

  function setChatMenu(open, { focusToggle = false } = {}) {
    chatMenu.dataset.open = open ? "true" : "false";
    chatMenuToggle.setAttribute("aria-expanded", String(open));
    if (open) chatMenu.querySelector("[role=menuitem]").focus();
    else if (focusToggle) chatMenuToggle.focus();
  }

  chatMenuToggle.addEventListener("click", () => setChatMenu(chatMenu.dataset.open !== "true"));

  chatMenu.addEventListener("keydown", (event) => {
    const items = [...chatMenu.querySelectorAll("[role=menuitem]")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      setChatMenu(false, { focusToggle: event.key === "Escape" });
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (chatMenu.dataset.open === "true" && !chatMenu.contains(event.target) && !chatMenuToggle.contains(event.target)) {
      setChatMenu(false);
    }
  });

  chatMenu.addEventListener("click", async (event) => {
    const item = event.target.closest("[data-chat-action]");
    if (!item) return;
    setChatMenu(false);
    const action = item.dataset.chatAction;

    if (action === "close") {
      closeChat();
    } else if (action === "logout") {
      document.getElementById("logout-button").click();
    } else if (action === "delete" && activeId !== null) {
      const state = chats.get(activeId);
      const name = (state && state.chat.peer && state.chat.peer.name) || "this user";
      if (!window.confirm(`Delete your chat with ${name}? This removes it for both of you and can't be undone.`)) return;
      const id = activeId;
      try {
        await app.authedApi(`/chats/${id}`, { method: "DELETE" });
        removeChat(id);
        app.toast("Chat deleted");
      } catch (error) {
        app.toast((error && error.message) || "Couldn't delete the chat. Try again.");
      }
    }
  });

  window.addEventListener("popstate", () => {
    if (view.dataset.pane === "chat" && mobile.matches) closeChat({ fromHistory: true });
  });

  // Rotating to landscape / resizing past md shows both panes again.
  mobile.addEventListener("change", () => {
    if (!mobile.matches) setPane(activeId ? "chat" : "list");
  });

  // ── Read receipts ────────────────────────────────────────────────────

  function markRead(state) {
    if (!state || state.chat.id !== activeId || !isPageVisible()) return;
    const hasUnread = state.chat.unread_count > 0 ||
      state.messages.some((m) => !isMine(m) && m.id && m.status !== "read");
    if (!hasUnread) return;

    state.chat.unread_count = 0;
    for (const message of state.messages) {
      if (!isMine(message) && message.id) message.status = "read";
    }
    renderChatList();

    const chatId = state.chat.id;
    if (socket && socket.connected) {
      socket.emit("MSG_READ", { chat_id: chatId });
    } else {
      app.authedApi(`/chats/${chatId}/read`, { method: "POST", body: {} }).catch(() => {});
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (isPageVisible() && activeId !== null) markRead(chats.get(activeId));
  });

  // ── Composer ─────────────────────────────────────────────────────────

  const drafts = new Map(); // chat id -> unsent text

  // ── Attachments: "+" menu, picked files, uploads ─────────────────────

  const attachToggle = $("[data-attach-toggle]");
  const attachMenu = $("[data-attach-menu]");
  const attachItems = [...attachMenu.querySelectorAll("[data-attach-action]")];
  const tray = $("[data-attach-tray]");
  const trayList = $("[data-attach-list]");
  const traySummary = $("[data-attach-summary]");
  const trayError = $("[data-attach-error]");
  const dropZone = $("[data-drop-zone]");
  const pickers = {
    media: document.getElementById("attach-media"),
    camera: document.getElementById("attach-camera"),
    document: document.getElementById("attach-document"),
  };

  let picked = []; // [{ id, file, url, kind }] waiting in the tray
  const uploadProgress = new Map(); // client_message_id -> 0..1 while uploading

  function visibleItems() {
    return attachItems.filter((item) => item.offsetParent !== null);
  }

  function openAttachMenu() {
    attachMenu.dataset.open = "true";
    attachToggle.setAttribute("aria-expanded", "true");
    const first = visibleItems()[0];
    if (first) requestAnimationFrame(() => first.focus());
  }

  function closeAttachMenu({ focusToggle = false } = {}) {
    if (attachMenu.dataset.open !== "true") return;
    attachMenu.dataset.open = "false";
    attachToggle.setAttribute("aria-expanded", "false");
    if (focusToggle) attachToggle.focus();
  }

  attachToggle.addEventListener("click", () => {
    if (attachMenu.dataset.open === "true") closeAttachMenu();
    else openAttachMenu();
  });

  attachMenu.addEventListener("keydown", (event) => {
    const items = visibleItems();
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1].focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      closeAttachMenu({ focusToggle: event.key === "Escape" });
    }
  });

  // Click anywhere else closes the menu.
  document.addEventListener("pointerdown", (event) => {
    if (attachMenu.dataset.open === "true" && !attachMenu.contains(event.target) && !attachToggle.contains(event.target)) {
      closeAttachMenu();
    }
  });

  for (const item of attachItems) {
    item.addEventListener("click", () => {
      const action = item.dataset.attachAction;
      closeAttachMenu();
      if (action === "emoji") toggleEmoji();
      else pickers[action].click();
    });
  }

  for (const picker of Object.values(pickers)) {
    picker.addEventListener("change", () => {
      addFiles(picker.files);
      picker.value = ""; // picking the same file again still fires change
    });
  }

  function uploadError(message) {
    trayError.textContent = message;
    trayError.classList.toggle("hidden", !message);
    if (message) tray.classList.remove("hidden");
    else if (!picked.length) tray.classList.add("hidden");
  }

  function addFiles(fileList) {
    if (activeId === null) return;
    const files = [...(fileList || [])];
    if (!files.length) return;
    const problems = [];
    for (const file of files) {
      if (picked.length >= MAX_FILES) {
        problems.push(`You can send up to ${MAX_FILES} files at a time.`);
        break;
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        problems.push(`“${file.name}” is larger than ${MAX_FILE_MB} MB.`);
        continue;
      }
      if (!file.size) {
        problems.push(`“${file.name}” is empty.`);
        continue;
      }
      picked.push({ id: clientId(), file, url: URL.createObjectURL(file), kind: media.kindOf(file.type) });
    }
    renderTray();
    uploadError(problems.join(" "));
    resizeInput();
    if (!mobile.matches) input.focus({ preventScroll: true });
  }

  function removePicked(id) {
    const item = picked.find((p) => p.id === id);
    if (item) URL.revokeObjectURL(item.url);
    picked = picked.filter((p) => p.id !== id);
    renderTray();
    uploadError("");
    resizeInput();
  }

  function clearPicked() {
    picked.forEach((p) => URL.revokeObjectURL(p.url));
    picked = [];
    renderTray();
    uploadError("");
    if (input) resizeInput();
  }

  function renderTray() {
    tray.classList.toggle("hidden", !picked.length);
    input.placeholder = picked.length ? "Add a caption" : "Type a message";
    traySummary.textContent = picked.length === 1 ? "1 file ready to send" : `${picked.length} files ready to send`;
    trayList.replaceChildren(...picked.map((item) => {
      const li = el("li", "group relative shrink-0");
      const thumb = el("div", "grid size-16 place-items-center overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/5");
      if (item.kind === "image") {
        const img = el("img", "size-full object-cover");
        img.src = item.url;
        img.alt = "";
        thumb.append(img);
      } else if (item.kind === "video") {
        const video = el("video", "size-full object-cover");
        video.src = `${item.url}#t=0.1`;
        video.muted = true;
        video.preload = "metadata";
        thumb.append(video);
      } else {
        thumb.className += " px-1 text-center";
        thumb.append(el("span", "text-[10px] font-bold text-brand-dark", media.extOf(item.file.name)));
      }
      const name = el("p", "mt-1 w-16 truncate text-[11px] text-slate-600", item.file.name || "File");
      const remove = el("button",
        "absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-ink text-white shadow ring-2 ring-[#f0f2f5] transition hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-brand");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${item.file.name || "file"}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 18 18 6M6 6l12 12"/></svg>';
      remove.addEventListener("click", () => removePicked(item.id));
      li.title = `${item.file.name} · ${media.formatSize(item.file.size)}`;
      li.append(thumb, name, remove);
      return li;
    }));
  }

  $("[data-attach-clear]").addEventListener("click", clearPicked);

  /** Upload one file as a raw body; reports progress; refreshes the token once. */
  function uploadFile(file, onProgress, retried = false) {
    return new Promise((resolve, reject) => {
      const auth = app.loadAuth();
      if (!auth || !auth.tokens) return reject(new Error("You're signed out."));
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API}/uploads?name=${encodeURIComponent(file.name || "file")}`);
      xhr.setRequestHeader("Authorization", `Bearer ${auth.tokens.access_token}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded);
      xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
      xhr.onload = async () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
        if (xhr.status === 401 && !retried) {
          const refreshed = await app.refreshTokens();
          if (!refreshed) return reject(new Error("You're signed out."));
          return uploadFile(file, onProgress, true).then(resolve, reject);
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        reject(new Error((data.error && data.error.message) || "Upload failed."));
      };
      xhr.send(file);
    });
  }

  /** Upload a message's local files; returns the attachment list for the server. */
  async function uploadAll(message) {
    const pending = message.attachments.filter((a) => a._file);
    const total = pending.reduce((sum, a) => sum + a._file.size, 0) || 1;
    let done = 0;
    const report = (loaded) => {
      const value = Math.min(1, (done + loaded) / total);
      uploadProgress.set(message.client_message_id, value);
      const label = messageList.querySelector(`[data-progress-for="${message.client_message_id}"]`);
      if (label) label.textContent = `${Math.round(value * 100)}%`;
    };
    const result = [];
    for (const attachment of message.attachments) {
      if (!attachment._file) {
        result.push(attachment);
        continue;
      }
      const uploaded = await uploadFile(attachment._file, report);
      done += attachment._file.size;
      result.push({
        url: uploaded.url,
        file_name: attachment.file_name,
        mime_type: attachment.mime_type, // keep the precise type for display
        file_size: uploaded.file_size,
      });
    }
    return result;
  }

  // Paste screenshots / files straight into the message box.
  input.addEventListener("paste", (event) => {
    const files = event.clipboardData && event.clipboardData.files;
    if (files && files.length) {
      event.preventDefault();
      addFiles(files);
    }
  });

  // Drag & drop onto the conversation.
  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes("Files");
  activePane.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    dropZone.classList.replace("hidden", "grid");
  });
  activePane.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  activePane.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.replace("grid", "hidden");
  });
  activePane.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropZone.classList.replace("grid", "hidden");
    addFiles(event.dataTransfer.files);
  });

  // ── Emoji panel ──────────────────────────────────────────────────────

  const emojiPanel = $("[data-emoji-panel]");
  const emojiTabs = $("[data-emoji-tabs]");
  const emojiGrid = $("[data-emoji-grid]");
  const RECENT_KEY = "imarachat.recentEmoji";
  let emojiCategory = 0;
  let caret = null; // where to insert when the box isn't focused (phones)

  function recentEmoji() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (_) { return []; }
  }

  function emojiCategories() {
    const recent = recentEmoji();
    return recent.length ? [{ name: "Recent", tab: "🕘", list: recent }, ...media.EMOJI] : media.EMOJI;
  }

  function renderEmoji() {
    const categories = emojiCategories();
    emojiCategory = Math.min(emojiCategory, categories.length - 1);
    emojiTabs.replaceChildren(...categories.map((category, index) => {
      const tab = el("button",
        "relative grid size-10 shrink-0 place-items-center rounded-lg text-xl transition hover:bg-slate-100 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand " +
        (index === emojiCategory ? "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand" : "opacity-60"),
        category.tab);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === emojiCategory));
      tab.setAttribute("aria-label", category.name);
      tab.title = category.name;
      tab.addEventListener("click", () => {
        emojiCategory = index;
        renderEmoji();
        emojiGrid.scrollTop = 0;
      });
      return tab;
    }));
    const close = el("button",
      "ml-auto grid size-9 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand");
    close.type = "button";
    close.setAttribute("aria-label", "Close emoji");
    close.innerHTML = '<svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 18 18 6M6 6l12 12"/></svg>';
    close.addEventListener("click", () => toggleEmoji(false, { focusInput: true }));
    emojiTabs.append(close);

    emojiGrid.setAttribute("aria-label", categories[emojiCategory].name);
    emojiGrid.replaceChildren(...categories[emojiCategory].list.map((emoji) => {
      const button = el("button",
        "grid h-11 place-items-center rounded-lg text-2xl transition hover:scale-110 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        emoji);
      button.type = "button";
      button.addEventListener("click", () => insertEmoji(emoji));
      return button;
    }));
  }

  function insertEmoji(emoji) {
    const start = caret ? caret[0] : input.selectionStart ?? input.value.length;
    const end = caret ? caret[1] : input.selectionEnd ?? input.value.length;
    input.setRangeText(emoji, start, end, "end");
    caret = [input.selectionStart, input.selectionEnd];
    input.dispatchEvent(new Event("input", { bubbles: true })); // resize, draft, typing
    if (!mobile.matches) input.focus({ preventScroll: true });

    const recent = [emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 32);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  }

  function toggleEmoji(force, { focusInput = false } = {}) {
    const open = force === undefined ? emojiPanel.classList.contains("hidden") : force;
    if (open === !emojiPanel.classList.contains("hidden")) return;
    emojiPanel.classList.toggle("hidden", !open);
    if (open) {
      caret = [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length];
      emojiCategory = 0;
      renderEmoji();
      const first = emojiGrid.querySelector("button");
      if (first && !mobile.matches) first.focus({ preventScroll: true });
    } else {
      caret = null;
      if (focusInput && !mobile.matches) input.focus({ preventScroll: true });
    }
  }

  // Typing moves the caret; forget the remembered one.
  input.addEventListener("click", () => { caret = null; });
  input.addEventListener("keyup", () => { caret = null; });
  emojiPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      toggleEmoji(false, { focusInput: true });
    }
  });

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
    sendButton.disabled = !input.value.trim() && !picked.length;
  }

  function sendTyping(isTyping) {
    if (!socket || !socket.connected || activeId === null) return;
    socket.emit(isTyping ? "typing:start" : "typing:stop", { chat_id: activeId });
  }

  function stopTyping() {
    clearTimeout(typingTimer);
    if (typingSent) sendTyping(false);
    typingSent = false;
  }

  input.addEventListener("input", () => {
    resizeInput();
    if (activeId !== null) drafts.set(activeId, input.value);
    if (!input.value.trim()) return stopTyping();
    if (!typingSent) {
      typingSent = true;
      sendTyping(true);
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  });

  input.addEventListener("keydown", (event) => {
    // Enter sends, Shift+Enter adds a line. Leave IME composition alone.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !mobile.matches) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = input.value.trim();
    const state = chats.get(activeId);
    if ((!content && !picked.length) || !state) return;

    // Picked files travel with the message; their preview URLs are freed
    // once the server copy replaces them.
    const attachments = picked.map(({ file, url }) => ({
      url,
      file_name: file.name || null,
      mime_type: file.type || "application/octet-stream",
      file_size: file.size,
      _file: file,
    }));
    picked = [];
    renderTray();
    toggleEmoji(false);

    stopTyping();
    input.value = "";
    drafts.delete(activeId);
    resizeInput();
    if (!mobile.matches) input.focus();

    const message = {
      id: null,
      chat_id: state.chat.id,
      client_message_id: clientId(),
      sender: { id: me.id, name: me.name, username: me.username },
      recipient_id: state.chat.peer ? state.chat.peer.id : null,
      type: attachments.length ? media.messageType(attachments) : "text",
      content: content || null,
      status: "pending",
      attachments,
      created_at: new Date().toISOString(),
    };
    if (attachments.length) uploadProgress.set(message.client_message_id, 0);
    upsertMessage(state, message);
    state.chat.last_message_at = message.created_at;
    renderMessages({ stick: true });
    renderChatList();
    deliver(state, message);
  });

  async function deliver(state, message) {
    const fail = () => {
      uploadProgress.delete(message.client_message_id);
      upsertMessage(state, { ...message, status: "failed" });
      if (state.chat.id === activeId) renderMessages({ keep: true });
      renderChatList();
    };

    // 1. Upload any files that aren't on the server yet.
    if (message.attachments.some((a) => a._file)) {
      const previews = message.attachments.filter((a) => a._file).map((a) => a.url);
      try {
        message = { ...message, attachments: await uploadAll(message) };
        // The server copies replace the local previews: free their memory.
        setTimeout(() => previews.forEach((url) => URL.revokeObjectURL(url)), 5000);
      } catch (error) {
        if (error && error.message) uploadError(error.message);
        return fail();
      }
      uploadProgress.delete(message.client_message_id);
      upsertMessage(state, message);
      if (state.chat.id === activeId) renderMessages({ keep: true });
    }

    // 2. Send the message itself.
    const payload = {
      chat_id: state.chat.id,
      content: message.content,
      type: message.type || "text",
      client_message_id: message.client_message_id,
    };
    if (message.attachments.length) {
      payload.attachments = message.attachments.map(({ url, file_name, mime_type, file_size }) =>
        ({ url, file_name, mime_type, file_size }));
    }

    if (socket && socket.connected) {
      socket.timeout(10000).emit("MSG_SEND", payload, (err, ack) => {
        if (err || !ack || !ack.ok) return fail();
        receiveOwn(ack.message);
      });
      return;
    }
    // Offline socket: the REST endpoint persists and queues delivery too.
    try {
      const result = await app.authedApi(`/chats/${state.chat.id}/messages`, {
        method: "POST",
        body: { ...payload, chat_id: undefined },
      });
      if (!result.ok) throw new Error(String(result.status));
      receiveOwn(result.data);
    } catch (_) {
      fail();
    }
  }

  function resend(message) {
    const state = chats.get(message.chat_id);
    if (!state) return;
    const retry = { ...message, status: "pending" };
    if (retry.attachments.some((a) => a._file)) uploadProgress.set(retry.client_message_id, 0);
    upsertMessage(state, retry);
    renderMessages({ keep: true });
    deliver(state, retry); // same client id, so the server won't duplicate it
  }

  function receiveOwn(message) {
    if (!message) return;
    const state = chats.get(message.chat_id);
    if (!state) return;
    upsertMessage(state, message);
    if (message.chat_id === activeId) renderMessages({ keep: true });
    renderChatList();
  }

  // ── Chat list loading ────────────────────────────────────────────────

  async function fetchChats() {
    const result = await app.authedApi("/chats");
    if (!result.ok) throw new Error(String(result.status));
    return result.data;
  }

  async function fetchChat(chatId) {
    const result = await app.authedApi(`/chats/${chatId}`);
    if (!result.ok) throw new Error(String(result.status));
    return result.data;
  }

  /** Replace list metadata with the server's view (after load or reconnect). */
  function syncChats(list) {
    const ids = new Set(list.map((chat) => chat.id));
    for (const id of [...chats.keys()]) {
      if (!ids.has(id)) removeChat(id, { silent: true });
    }
    for (const chat of list) {
      const state = stateFor(chat);
      state.chat.unread_count = chat.unread_count;
    }
  }

  function removeChat(chatId, { silent = false } = {}) {
    const state = chats.get(chatId);
    if (!state) return;
    clearTimeout(state.typingTimer);
    chats.delete(chatId);
    if (activeId === chatId) closeChat();
    if (!silent) {
      renderChatList();
      if (!chats.size) showPeopleView();
    }
  }

  function addChat(chat, { open = false } = {}) {
    const isNew = !chats.has(chat.id);
    stateFor(chat);
    if (view.classList.contains("hidden")) showChatView();
    renderChatList();
    if (open) openChat(chat.id);
    return isNew;
  }

  const meAvatar = $("[data-me-avatar]");

  function renderMe() {
    if (!me) return;
    meAvatar.replaceChildren(app.avatar(me, "size-8 text-xs"));
  }

  // ── Account dialog (opened from the "You" button) ────────────────────

  const accountDialog = document.getElementById("account-dialog");
  const accountQ = (selector) => accountDialog.querySelector(selector);
  const meToggle = $("[data-me-toggle]");

  function renderAccount() {
    if (!me) return;
    accountQ("[data-account-avatar]").replaceChildren(app.avatar(me, "size-20 text-2xl"));
    accountQ("[data-account-name]").textContent = me.name;
    accountQ("[data-account-username]").textContent = `@${me.username}`;
    accountQ("[data-account-detail-name]").textContent = me.name;
    accountQ("[data-account-detail-username]").textContent = `@${me.username}`;
    accountQ("[data-account-detail-email]").textContent = me.email || "—";
    const current = app.avatarColorIndex(me);
    const swatches = app.AVATAR_COLORS.map((color, index) => {
      const button = el("button",
        `size-10 rounded-full bg-gradient-to-br ${color} ring-offset-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ` +
        (index === current ? "ring-2 ring-ink" : "hover:scale-105"));
      button.type = "button";
      button.setAttribute("aria-label", `Avatar colour ${index + 1}`);
      button.setAttribute("aria-pressed", String(index === current));
      button.addEventListener("click", () => {
        app.setAvatarColor(me, index);
        renderMe();
        renderAccount();
        renderChatList();
        if (activeId !== null) renderMessages();
      });
      return button;
    });
    accountQ("[data-account-colors]").replaceChildren(...swatches);
  }

  function openAccount() {
    if (accountDialog.open || !me) return;
    renderAccount();
    accountDialog.classList.remove("is-closing");
    accountDialog.showModal();
    document.documentElement.classList.add("overflow-hidden");
  }

  function closeAccount({ immediate = false } = {}) {
    if (!accountDialog.open || accountDialog.classList.contains("is-closing")) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      accountDialog.removeEventListener("animationend", onEnd);
      accountDialog.classList.remove("is-closing");
      accountDialog.close();
      document.documentElement.classList.remove("overflow-hidden");
    };
    const onEnd = (event) => event.target === accountDialog && finish();
    if (immediate) return finish();
    accountDialog.classList.add("is-closing");
    accountDialog.addEventListener("animationend", onEnd);
    setTimeout(finish, 400);
  }

  meToggle.addEventListener("click", openAccount);
  accountQ("[data-account-close]").addEventListener("click", () => closeAccount());
  accountDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeAccount(); });
  accountDialog.addEventListener("click", (event) => { if (event.target === accountDialog) closeAccount(); });
  accountQ("[data-account-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`@${me.username}`);
      app.toast("Username copied");
    } catch (_) {
      app.toast("Couldn't copy the username");
    }
  });
  accountQ("[data-account-logout]").addEventListener("click", () => {
    closeAccount({ immediate: true });
    document.getElementById("logout-button").click();
  });

  async function enter(user) {
    const seq = ++sessionSeq;
    me = user;
    renderMe();
    showLoading();
    let list;
    try {
      list = await fetchChats();
    } catch (_) {
      if (seq !== sessionSeq) return;
      showChatView();
      chatList.replaceChildren();
      chatListEmpty.classList.remove("hidden");
      chatListEmpty.replaceChildren(el("p", "", "Couldn't load your chats."));
      const retry = el("button", "mt-2 font-semibold text-brand-dark hover:underline", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => enter(user));
      chatListEmpty.append(retry);
      return;
    }
    if (seq !== sessionSeq) return;

    syncChats(list);
    if (!chats.size) showPeopleView();
    else {
      showChatView();
      renderChatList();
      // Reopen the chat from before a refresh (desktop keeps both panes).
      const remembered = Number(sessionStorage.getItem("imarachat.activeChat"));
      if (remembered && chats.has(remembered) && !mobile.matches) openChat(remembered, { focus: false });
    }
    connect();
  }

  function leave() {
    sessionSeq++;
    closeAccount({ immediate: true });
    disconnect();
    for (const state of chats.values()) clearTimeout(state.typingTimer);
    chats.clear();
    online.clear();
    drafts.clear();
    activeId = null;
    me = null;
    clearPicked();
    closeAttachMenu();
    toggleEmoji(false);
    uploadProgress.clear();
    sessionStorage.removeItem("imarachat.activeChat");
    messageList.replaceChildren();
    chatList.replaceChildren();
    chatSearch.value = "";
    activePane.classList.add("hidden");
    activePane.classList.remove("flex");
    emptyPane.classList.remove("hidden");
    setPane("list");
    hideAll();
  }

  chatSearch.addEventListener("input", renderChatList);
  chatSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && chatSearch.value) {
      chatSearch.value = "";
      renderChatList();
    }
  });

  $("[data-new-chat]").addEventListener("click", () => app.openPeopleDialog());

  // ── Socket.IO ────────────────────────────────────────────────────────

  function connect() {
    if (socket || typeof io !== "function") return;
    socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      // Read the token on every (re)connect so refreshed tokens are used.
      auth: (cb) => {
        const auth = app.loadAuth();
        cb({ token: auth && auth.tokens ? auth.tokens.access_token : "" });
      },
    });

    socket.on("connect", onConnect);
    socket.on("connect_error", onConnectError);
    socket.on("disconnect", () => {
      online.clear();
      renderChatList();
      if (activeId !== null) renderHeader();
    });

    socket.on("MSG_SENT", (event) => receiveOwn(event.message));
    socket.on("MSG_RECEIVED", (event) => receiveMessage(event.message));
    socket.on("MSG_DELIVERED", applyStatus);
    socket.on("MSG_READ", applyStatus);
    socket.on("message:read", onReadCursor);
    socket.on("message:updated", (event) => receiveEdit(event.message));
    socket.on("message:deleted", (event) => receiveEdit(event.message));
    socket.on("chat:added", (event) => event.chat && addChat(event.chat));
    socket.on("chat:deleted", (event) => removeChat(event.chat_id));
    socket.on("typing:start", (event) => setTyping(event, true));
    socket.on("typing:stop", (event) => setTyping(event, false));
    socket.on("presence:online", (event) => setPresence(event.user, true));
    socket.on("presence:offline", (event) => setPresence(event.user, false));
  }

  // Close the socket when the page goes away (or into the back/forward cache)
  // so the peer sees us go offline straight away; reconnect if restored.
  window.addEventListener("pagehide", () => socket && socket.disconnect());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && socket && !socket.connected) socket.connect();
  });

  function disconnect() {
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    if (!socket) return;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  let connectedBefore = false;

  async function onConnect() {
    reconnectAttempts = 0;
    const seq = sessionSeq;
    // After a reconnect, catch up on anything that changed while we were away.
    if (connectedBefore) {
      try {
        const list = await fetchChats();
        if (seq !== sessionSeq) return;
        syncChats(list);
        for (const state of chats.values()) {
          if (state.chat.id === activeId) {
            state.loaded = false;
            loadMessages(state);
          } else if (state.loaded) {
            state.loaded = false;
            state.messages = state.messages.filter((m) => !m.id); // keep unsent ones
          }
        }
        if (!chats.size) showPeopleView();
        renderChatList();
      } catch (_) { /* keep what we have */ }
    }
    connectedBefore = true;
    checkPresence();
  }

  /** The server refuses expired tokens: refresh once, then retry with backoff. */
  async function onConnectError(error) {
    if (!socket || socket.active) return; // transport hiccup: socket.io retries itself
    const seq = sessionSeq;
    if (/expired|invalid|token|auth/i.test(error.message || "")) await app.refreshTokens();
    if (seq !== sessionSeq || !socket || !app.loadAuth()) return;
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts++);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => socket && socket.connect(), delay);
  }

  function checkPresence() {
    for (const { chat } of chats.values()) {
      socket.emit("presence:check", { chat_id: chat.id }, (reply) => {
        if (!reply || !reply.ok || !chat.peer) return;
        setPresence(chat.peer, reply.online_user_ids.includes(chat.peer.id));
      });
    }
  }

  function setPresence(user, isOnline) {
    if (!user || (me && user.id === me.id)) return;
    if (isOnline === online.has(user.id)) return;
    if (isOnline) online.add(user.id);
    else online.delete(user.id);
    renderChatList();
    const state = chats.get(activeId);
    if (state && state.chat.peer && state.chat.peer.id === user.id) renderHeader();
  }

  function setTyping(event, isTyping) {
    if (!event.user || (me && event.user.id === me.id)) return;
    const state = chats.get(event.chat_id);
    if (!state) return;
    clearTimeout(state.typingTimer);
    state.typing = isTyping;
    if (isTyping) {
      state.typingTimer = setTimeout(() => setTyping({ ...event }, false), TYPING_EXPIRE_MS);
    }
    renderChatList();
    if (event.chat_id === activeId) renderHeader();
  }

  async function receiveMessage(message) {
    if (!message) return;
    let state = chats.get(message.chat_id);
    if (!state) {
      // A chat we haven't seen yet (opened while this tab was offline).
      try {
        addChat(await fetchChat(message.chat_id));
      } catch (_) {
        return;
      }
      state = chats.get(message.chat_id);
      if (!state) return;
    }

    // Their message implies they've stopped typing.
    clearTimeout(state.typingTimer);
    state.typing = false;

    const knownLastId = state.chat.last_message && state.chat.last_message.id;
    const isNew = upsertMessage(state, message);
    const reading = message.chat_id === activeId && isPageVisible();

    // Redeliveries after reconnect are already counted in unread_count.
    if (isNew && !reading && !(knownLastId && message.id <= knownLastId)) {
      state.chat.unread_count = (state.chat.unread_count || 0) + 1;
    }

    if (message.chat_id === activeId) {
      const atBottom = isNearBottom();
      if (!atBottom && isNew) state.unseen++;
      renderMessages({ keep: true });
      renderHeader();
      if (isNew) announcer.textContent = `${message.sender ? message.sender.name : "New message"}: ${media.preview(message)}`;
      markRead(state);
    }
    renderChatList();
  }

  function receiveEdit(message) {
    if (!message) return;
    const state = chats.get(message.chat_id);
    if (!state) return;
    const exists = state.messages.some((m) => m.id === message.id) ||
      (state.chat.last_message && state.chat.last_message.id === message.id);
    if (!exists) return;
    upsertMessage(state, message);
    if (message.chat_id === activeId) renderMessages({ keep: true });
    renderChatList();
  }

  /** Someone (possibly me in another tab) read up to a message. */
  function onReadCursor(receipt) {
    if (!me || receipt.user_id !== me.id) return;
    const state = chats.get(receipt.chat_id);
    if (!state || !state.chat.unread_count) return;
    state.chat.unread_count = 0;
    renderChatList();
  }

  // ── Wiring to auth.js ────────────────────────────────────────────────

  document.addEventListener("imarachat:session", (event) => {
    const user = event.detail.user;
    if (!user) {
      if (me) leave();
      return;
    }
    if (me && me.id === user.id) {
      me = user; // refreshed profile
      renderMe();
      if (accountDialog.open) renderAccount();
      return;
    }
    if (me) leave();
    enter(user);
  });

  document.addEventListener("imarachat:chat-opened", (event) => {
    if (!me) return;
    addChat(event.detail, { open: true });
  });
})();
