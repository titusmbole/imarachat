/* ImaraChat attachments: how photos, videos, audio and documents look inside
   message bubbles, the full-screen photo/video viewer, and the emoji set.
   Used by chat.js through window.ImaraChat.attachments. */
(() => {
  "use strict";

  const app = window.ImaraChat;
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(d, className) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  const ICONS = {
    download: "M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3",
    play: "M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z",
  };

  // ── Facts about a file ───────────────────────────────────────────────

  function kindOf(mime) {
    const type = (mime || "").toLowerCase();
    // Browsers can't show HEIC/TIFF, and SVG is never trusted inline.
    if (type.startsWith("image/") && !/svg|heic|heif|tiff/.test(type)) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    return "file";
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function extOf(name) {
    const match = /\.([a-z0-9]{1,5})$/i.exec(name || "");
    return match ? match[1].toUpperCase() : "FILE";
  }

  /** Message type for a set of attachments (what the server stores). */
  function messageType(attachments) {
    const kinds = new Set(attachments.map((a) => kindOf(a.mime_type)));
    if (kinds.size === 1) return kinds.has("file") ? "file" : [...kinds][0];
    if ([...kinds].every((k) => k === "image" || k === "video")) return "image";
    return "file";
  }

  /** Chat-list preview: "📷 Photo", "📄 report.pdf", or the caption. */
  function preview(message) {
    const attachments = message.attachments || [];
    if (!attachments.length) return message.content || "";
    const media = attachments.filter((a) => ["image", "video"].includes(kindOf(a.mime_type)));
    const first = attachments[0];
    const kind = kindOf(first.mime_type);
    const caption = message.content;
    if (kind === "image" || (media.length && media.length === attachments.length)) {
      const allVideo = media.every((a) => kindOf(a.mime_type) === "video");
      const label = media.length > 1 ? `${media.length} ${allVideo ? "videos" : "photos"}` : allVideo ? "Video" : "Photo";
      return `${allVideo ? "🎥" : "📷"} ${caption || label}`;
    }
    if (kind === "video") return `🎥 ${caption || "Video"}`;
    if (kind === "audio") return `🎵 ${caption || "Audio"}`;
    return `📄 ${caption || first.file_name || "Document"}`;
  }

  // ── Inside a bubble ──────────────────────────────────────────────────

  /**
   * Build the attachment part of a bubble.
   * Returns { node, mediaHost } — mediaHost is the photo/video block the
   * time stamp can be laid over when there is no caption.
   */
  function render(message, { progress = null } = {}) {
    const attachments = message.attachments || [];
    const node = el("div", "flex flex-col gap-1");
    const media = attachments.filter((a) => ["image", "video"].includes(kindOf(a.mime_type)));
    const others = attachments.filter((a) => !["image", "video"].includes(kindOf(a.mime_type)));
    let mediaHost = null;

    if (media.length) {
      mediaHost = mediaGrid(media, message);
      node.append(mediaHost);
    }
    for (const attachment of others) {
      node.append(kindOf(attachment.mime_type) === "audio" ? audioPlayer(attachment) : fileCard(attachment));
    }

    // Uploading: dim the content and show progress.
    if (progress !== null) {
      const host = mediaHost || node;
      host.classList.add("relative");
      const overlay = el("div", "absolute inset-0 z-10 grid place-items-center rounded-md bg-black/35");
      const ring = el("div", "grid size-14 place-items-center rounded-full bg-black/45 text-xs font-semibold text-white");
      const spinner = el("span", "absolute size-12 animate-spin rounded-full border-2 border-white/30 border-t-white");
      const label = el("span", "", `${Math.round(progress * 100)}%`);
      label.dataset.progressFor = message.client_message_id || "";
      ring.append(spinner, label);
      overlay.append(ring);
      host.append(overlay);
    }
    return { node, mediaHost };
  }

  function mediaGrid(media, message) {
    const shown = media.slice(0, 4);
    const extra = media.length - shown.length;
    const grid = el("div",
      "relative grid w-[min(300px,68vw)] gap-0.5 overflow-hidden rounded-md bg-black/5 " +
      (shown.length > 1 ? "grid-cols-2" : "grid-cols-1"));

    shown.forEach((attachment, index) => {
      const single = shown.length === 1;
      const cell = el("button",
        "group/media relative block overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand " +
        (single ? "" : "aspect-square") + (shown.length === 3 && index === 0 ? " col-span-2 aspect-[2/1]" : ""));
      cell.type = "button";
      const isVideo = kindOf(attachment.mime_type) === "video";
      cell.setAttribute("aria-label", `Open ${isVideo ? "video" : "photo"}${attachment.file_name ? ` ${attachment.file_name}` : ""}`);

      if (isVideo) {
        const video = el("video", "block size-full object-cover " + (single ? "max-h-[340px] min-h-40 w-full" : ""));
        video.src = `${attachment.url}#t=0.1`;
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        cell.append(video);
        const play = el("span", "absolute inset-0 grid place-items-center");
        const circle = el("span", "grid size-12 place-items-center rounded-full bg-black/50 text-white transition group-hover/media:bg-black/65");
        circle.append(icon(ICONS.play, "size-6 translate-x-px fill-current"));
        play.append(circle);
        cell.append(play);
      } else {
        const img = el("img", "block size-full object-cover transition group-hover/media:brightness-95 " +
          (single ? "max-h-[340px] min-h-32 w-full" : ""));
        img.src = attachment.url;
        img.alt = attachment.file_name || "Photo";
        img.loading = "lazy";
        img.decoding = "async";
        cell.append(img);
      }

      if (index === shown.length - 1 && extra > 0) {
        cell.append(el("span", "absolute inset-0 grid place-items-center bg-black/45 text-2xl font-semibold text-white", `+${extra}`));
      }
      cell.addEventListener("click", () => openViewer(media, index, message.content));
      grid.append(cell);
    });
    return grid;
  }

  function audioPlayer(attachment) {
    const audio = el("audio", "block h-10 w-[min(280px,65vw)]");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = attachment.url;
    return audio;
  }

  function fileCard(attachment) {
    const name = attachment.file_name || "Document";
    const card = el("a",
      "flex w-[min(300px,68vw)] items-center gap-3 rounded-md bg-black/5 p-2.5 text-left transition hover:bg-black/10 " +
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand");
    card.href = attachment.url;
    card.download = name;
    card.setAttribute("aria-label", `Download ${name}${attachment.file_size ? `, ${formatSize(attachment.file_size)}` : ""}`);

    const badge = el("span",
      "grid h-11 w-9 shrink-0 place-items-center rounded-md bg-white text-[9px] font-bold tracking-wide text-brand-dark shadow-sm ring-1 ring-black/5",
      extOf(name));
    const text = el("span", "min-w-0 flex-1");
    text.append(el("span", "block truncate text-sm font-medium text-ink", name));
    text.append(el("span", "block text-xs text-slate-500",
      [formatSize(attachment.file_size), extOf(name)].filter(Boolean).join(" · ")));
    card.append(badge, text, icon(ICONS.download, "size-5 shrink-0 text-slate-500"));
    return card;
  }

  // ── Full-screen viewer ───────────────────────────────────────────────

  const viewer = document.getElementById("media-viewer");
  const stage = viewer.querySelector("[data-viewer-stage]");
  const caption = viewer.querySelector("[data-viewer-caption]");
  const download = viewer.querySelector("[data-viewer-download]");
  const prev = viewer.querySelector("[data-viewer-prev]");
  const next = viewer.querySelector("[data-viewer-next]");
  let items = [];
  let current = 0;
  let viewerCaption = "";

  function showItem(index) {
    current = (index + items.length) % items.length;
    const item = items[current];
    const isVideo = kindOf(item.mime_type) === "video";
    const media = el(isVideo ? "video" : "img", "max-h-full max-w-full rounded object-contain shadow-2xl");
    media.src = item.url;
    if (isVideo) {
      media.controls = true;
      media.autoplay = true;
      media.playsInline = true;
    } else {
      media.alt = item.file_name || "Photo";
    }
    stage.replaceChildren(media);
    const position = items.length > 1 ? `${current + 1} of ${items.length}` : "";
    caption.textContent = [position, viewerCaption || item.file_name || ""].filter(Boolean).join(" · ");
    download.href = item.url;
    download.download = item.file_name || (isVideo ? "video" : "photo");
    prev.classList.toggle("hidden", items.length < 2);
    next.classList.toggle("hidden", items.length < 2);
  }

  function openViewer(list, index, text) {
    items = list;
    viewerCaption = text || "";
    showItem(index);
    if (!viewer.open) viewer.showModal();
  }

  function closeViewer() {
    stage.replaceChildren(); // stops any playing video
    if (viewer.open) viewer.close();
  }

  prev.addEventListener("click", () => showItem(current - 1));
  next.addEventListener("click", () => showItem(current + 1));
  viewer.querySelector("[data-viewer-close]").addEventListener("click", closeViewer);
  viewer.addEventListener("close", () => stage.replaceChildren());
  viewer.addEventListener("keydown", (event) => {
    if (items.length < 2) return;
    if (event.key === "ArrowLeft") showItem(current - 1);
    if (event.key === "ArrowRight") showItem(current + 1);
  });
  // Click on the dark area (not the photo or buttons) closes.
  viewer.addEventListener("click", (event) => {
    if (event.target === stage || event.target === viewer) closeViewer();
  });

  // ── Emoji ────────────────────────────────────────────────────────────

  const EMOJI = [
    ["Smileys", "😀", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖"],
    ["Gestures", "👍", "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 👀 👁️ 👅 👄 🧠 🫶 💅 🤳 🙋 🙆 🙅 🤷 🤦 🙇 💁 🧑‍💻 🧑‍🍳 🧑‍🎓 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵"],
    ["Hearts", "❤️", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤 ✨ 🔥 ⭐ 🌟 ⚡ 🎉 🎊"],
    ["Nature", "🐶", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🦎 🐙 🦑 🐠 🐬 🐳 🦈 🐊 🦓 🦒 🐘 🦏 🐪 🌵 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🌷 🌹 🌺 🌻 🌼 🌸 🌍 🌙 ☀️ 🌤️ ⛅ 🌧️ ⛈️ 🌈 ❄️ 🌊"],
    ["Food", "🍔", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥬 🥦 🧄 🧅 🍄 🥜 🍞 🥐 🥖 🧀 🥚 🍳 🥞 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🍚 🍙 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍩 🍿 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷"],
    ["Activities", "⚽", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏏 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸️ 🎿 🏂 🏋️ 🤸 🚴 🏊 🧘 🏆 🥇 🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 🎯 🎳 🎮 🧩"],
    ["Travel", "✈️", "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🏍️ 🛵 🚲 🛴 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🚀 🛸 🚁 ⛵ 🚤 🛳️ ⛴️ 🚢 ⚓ 🗺️ 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🏕️ 🏠 🏡 🏢 🏥 🏦 🏨 🏫 ⛪ 🕌"],
    ["Objects", "💡", "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙️ ⏰ ⏳ 🔋 🔌 💡 🔦 🕯️ 💸 💵 💳 💎 ⚖️ 🔧 🔨 🛠️ ⚙️ 🔫 💣 🔪 🛡️ 🔮 💊 💉 🩺 🧬 🧪 🌡️ 🧹 🧺 🧻 🚽 🛁 🔑 🗝️ 🚪 🛋️ 🛏️ 🎁 🎈 🎀 📦 ✉️ 📩 📝 📁 📅 📌 📎 ✂️ 🔒 🔓"],
    ["Symbols", "✅", "✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ❓ ❔ ❕ ❗ ‼️ ⁉️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ 🔀 🔁 🔂 ⬆️ ⬇️ ⬅️ ➡️ ↩️ ↪️ 🔄 🆗 🆕 🆒 🆓 🆙 🔝 ♻️ ⚠️ 🚫 ⛔ 📵 🔞 💲 ©️ ®️ ™️ #️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣"],
  ].map(([name, tab, list]) => ({ name, tab, list: list.split(" ") }));

  app.attachments = { kindOf, formatSize, extOf, messageType, preview, render, openViewer, closeViewer, EMOJI };
})();
