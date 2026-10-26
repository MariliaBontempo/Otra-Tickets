(function () {
  const INFO_CELL_VALUE_PREFIX = "otra-info-cell:";
  // Same separator as functions/_lib/hero-meta-text.js META_SEPARATOR.
  const INLINE_DOT = " · ";
  // event.html renderMeta() calls this after it builds the hero line, and
  // this script runs it again after every pass of page edits.
  if (typeof window !== "undefined") window.otraTidyMetaLine = tidyMetaLine;
  tidyMetaLine();
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("otra:event-rendered", () => tidyMetaLine());
  }
  const id = inferOverrideId();
  if (!id) return;
  // Set from the server answer: true only on an unpublished draft page.
  let draftOnlyRemovalsOk = false;

  // Staff sessions (the admin editor preview) send the admin token so pages of
  // events hidden on Otra Guide still show their edits there.
  let adminToken = "";
  try { adminToken = sessionStorage.getItem("otra_admin_token") || ""; } catch (e) { adminToken = ""; }
  fetch(
    "/api/override?id=" + encodeURIComponent(id),
    adminToken ? { cache: "no-store", headers: { authorization: "Bearer " + adminToken } } : { cache: "no-store" }
  )
    .then((resp) => (resp.ok ? resp.json() : null))
    .then((data) => {
      const override = data && data.override;
      if (!override) return;
      draftOnlyRemovalsOk = override.draftOnlyRemovals === true && /^draft-(?!prod-)/.test(id);
      applyLegacyOverride(override);
      applyFieldOverrides(override.fields || {});
      if (typeof document.addEventListener === "function") {
        document.addEventListener("otra:event-rendered", () => {
          applyLegacyOverride(override);
          applyFieldOverrides(override.fields || {}, 0, new Set());
        });
      }
    })
    .catch(() => {});

  function inferOverrideId() {
    const explicit = document.currentScript && document.currentScript.dataset.overrideId;
    if (isOverrideId(explicit)) return explicit;
    const param = new URLSearchParams(location.search).get("id");
    if (isOverrideId(param)) return param;
    if (/\/rnb(?:\.html)?\/?$/i.test(location.pathname)) return "7275";
    if (/\/clearboat(?:\.html)?\/?$/i.test(location.pathname)) return "6113";
    return "";
  }

  function isOverrideId(value) {
    return /^(?:\d+|draft-[a-zA-Z0-9-]+)$/.test(value || "");
  }

  function applyLegacyOverride(override) {
    if (override.accentColor && /^#[0-9A-Fa-f]{6}$/.test(override.accentColor)) {
      const current = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
        .toLowerCase();
      if (current !== override.accentColor.toLowerCase()) {
        document.documentElement.style.setProperty("--accent", override.accentColor);
      }
    }

    if (override.description) {
      const body = document.querySelector("#story .ev-body");
      if (body) {
        body.innerHTML = "";
        override.description
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean)
          .forEach((text) => {
            const p = document.createElement("p");
            p.textContent = text;
            body.appendChild(p);
          });
      }
    }

    if (override.image) {
      document.querySelectorAll(".ev-hero-img, .ev-story-img").forEach((img) => {
        applyGuardedImage(img, override.image);
      });
    }
  }

  function applyFieldOverrides(fields, attempt = 0, applied = new Set()) {
    for (const [key, field] of Object.entries(fields)) {
      if (applied.has(key)) continue;
      if (!field) { applied.add(key); continue; }
      const index = key.indexOf(":");
      if (index < 0) { applied.add(key); continue; }
      const type = key.slice(0, index);
      const selector = key.slice(index + 1);
      let el = null;
      try {
        el = document.querySelector(selector);
        if (!el && selector.startsWith("main > #")) {
          el = document.querySelector(selector.slice("main > ".length));
        }
      } catch {
        applied.add(key);
        continue;
      }
      if (!el) continue;

      if (type === "remove" && field.type === "remove") {
        // Before You Go is hidden only on an unpublished draft page; a live
        // page keeps it whatever selector a saved remove field uses.
        if (!draftOnlyRemovalsOk && hidesBeforeYouGo(el)) { applied.add(key); continue; }
        applyRemoval(el);
        applied.add(key);
        continue;
      }
      if (type === "text" && field.type === "text") {
        const value = typeof field.value === "string" ? field.value : "";
        if (isInfoCell(el)) {
          applyInfoCellText(el, value);
          revealInfoSection(el);
          applied.add(key);
          continue;
        }
        if (isDescriptionBody(el)) {
          applyDescriptionBody(el, value);
          applied.add(key);
          continue;
        }
        if (el.textContent !== value) {
          el.textContent = value;
          if (value.includes("\n")) el.style.whiteSpace = "pre-line";
        }
        revealBandText(el, value);
        const infoCell = el.closest && el.closest(".ev-info-cell");
        if (infoCell) {
          syncInfoCellDecorativeState(infoCell);
          revealInfoSection(infoCell);
        }
        applied.add(key);
        continue;
      }
      if (type === "image" && field.type === "image" && field.value) {
        applyGuardedImage(el, field.value);
        revealSlotSection(el, !isVideoUrl(field.value));
        applied.add(key);
        continue;
      }
      if (type === "video" && field.value) {
        // The video section holds the video (this field) and its poster/
        // thumbnail (the image: field for the same slot) in SEPARATE fields, so
        // uploading one never wipes the other and order does not matter. Prefer
        // the uploaded poster; otherwise keep whatever the slot already shows.
        const posterField = fields["image:" + selector];
        const poster =
          posterField && posterField.type === "image" && posterField.value && !isVideoUrl(posterField.value)
            ? posterField.value
            : el.tagName === "IMG"
            ? el.src
            : "";
        applyVideoOverride(el, field.value, poster);
        revealSlotSection(el, false);
        applied.add(key);
        continue;
      }
    }

    tidyMetaLine();
    const remaining = Object.keys(fields).filter((k) => !applied.has(k));
    if (remaining.length > 0 && attempt < 30) {
      setTimeout(() => applyFieldOverrides(fields, attempt + 1, applied), 250);
    }
  }

  // True when removing el would hide Before You Go: the section itself, its
  // info grid, or any wrapper that holds the section. Matches the ids in
  // functions/_lib/draft-only-sections.js.
  function hidesBeforeYouGo(el) {
    if (!el) return false;
    if (el.id === "evInfoSection" || el.id === "evInfoGrid") return true;
    return typeof el.querySelector === "function" && !!el.querySelector("#evInfoSection");
  }

  // A removed page section is hidden, never taken out of the DOM. event.html
  // renders into its sections by id ($("evRatesSection").querySelector(...))
  // and the edits load in parallel with the event, so a section deleted
  // before the render made that render throw and stop: every section after
  // it (prices, checkout) never appeared. Keeping the element also keeps
  // nth-of-type selectors pointing at the same sections when edits are
  // applied again after a render, and lets the editor restore it.
  // Small inner items (a price card) are rebuilt by the render, so they are
  // still removed outright.
  function applyRemoval(el) {
    const tag = String(el.tagName || "").toUpperCase();
    const isSection = !!el.id || tag === "SECTION" || tag === "FOOTER";
    if (!isSection || typeof el.setAttribute !== "function") {
      el.remove();
      return;
    }
    ensureRemovedStyle();
    el.setAttribute("data-otra-removed", "1");
    el.hidden = true;
  }

  function ensureRemovedStyle() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (document.getElementById("otra-removed-style")) return;
    const style = document.createElement("style");
    style.id = "otra-removed-style";
    // Triple attribute beats the editor rules that show hidden empty slots.
    style.textContent = "[data-otra-removed][data-otra-removed][data-otra-removed]{display:none !important}";
    (document.head || document.documentElement).appendChild(style);
  }

  // Hero line (#evMeta): item spans with a <span class="dot"> between them.
  // An item edited (or authored) blank is hidden together with its
  // separator, so "A · · B" reads "A · B"; a line with no visible item is
  // hidden whole. Items stay in the DOM (only hidden) so the nth-of-type
  // selectors saved page edits use keep pointing at the same items. The
  // homepage card applies the same rule in functions/_lib/schedule-line.js
  // (editedScheduleParts trims and drops blank items).
  function tidyMetaLine(host) {
    if (!host) {
      if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
      host = document.getElementById("evMeta");
    }
    if (!host || !host.children || typeof host.setAttribute !== "function") return;
    const children = Array.from(host.children);
    let visibleItems = 0;
    let pendingDot = null;
    for (const child of children) {
      if (isAdminControl(child)) continue;
      const isDot = !!(child.classList && child.classList.contains("dot"));
      if (isDot) {
        // A separator shows only between two visible items, once.
        setMetaHidden(child, true);
        if (visibleItems && !pendingDot) pendingDot = child;
        continue;
      }
      const blank = !metaText(child).trim();
      setMetaHidden(child, blank);
      if (blank) continue;
      markInlineDots(child);
      if (pendingDot) setMetaHidden(pendingDot, false);
      pendingDot = null;
      visibleItems += 1;
    }
    const items = children.filter((child) => !isAdminControl(child));
    const blankLine = items.length ? !visibleItems : !metaText(host).trim();
    setMetaHidden(host, blankLine);
  }

  // An item can hold its own " · " (days · times, from hero-meta-text.js on
  // the server). Wrap each one in a <span class="dot dot-inline"> so it gets
  // the separator's colour and spacing (event.html CSS). The text stays the
  // same, so saved edits still compare equal and the admin editor still
  // reads the item as before. Only plain text items are touched.
  function markInlineDots(item) {
    if (!item || (item.children && item.children.length)) return;
    if (typeof document === "undefined" || typeof document.createElement !== "function" || typeof document.createTextNode !== "function") return;
    const text = item.textContent || "";
    if (!text.includes(INLINE_DOT)) return;
    const parts = text.split(INLINE_DOT);
    item.textContent = "";
    parts.forEach((part, i) => {
      if (i) {
        const dot = document.createElement("span");
        dot.className = "dot dot-inline";
        dot.textContent = INLINE_DOT;
        item.appendChild(dot);
      }
      if (part) item.appendChild(document.createTextNode(part));
    });
  }

  // Text of a hero line node without the admin editor's own buttons.
  function metaText(el) {
    if (!el) return "";
    if (!el.children || !el.children.length) return el.textContent || "";
    let text = "";
    (el.childNodes ? Array.from(el.childNodes) : []).forEach((node) => {
      if (node.nodeType === 1 && isAdminControl(node)) return;
      text += node.textContent || "";
    });
    return text;
  }

  function isAdminControl(el) {
    return !!(el && el.classList && (el.classList.contains("otra-admin-edit-btn") || el.classList.contains("otra-admin-remove-btn")));
  }

  function setMetaHidden(el, hidden) {
    if (hidden) {
      el.setAttribute("data-otra-meta-empty", "");
      el.hidden = true;
    } else if (el.hasAttribute && el.hasAttribute("data-otra-meta-empty")) {
      el.removeAttribute("data-otra-meta-empty");
      el.hidden = false;
    }
  }

  // event.html keeps Before You Go hidden when its only cell is the
  // automatic Tickets price, but still renders the cells. A staff edit that
  // gives a cell text opens the section, unless a draft-only remove field
  // took it off.
  function revealInfoSection(cell) {
    if (!cell || !cell.closest || !(cell.textContent || "").trim()) return;
    const section = cell.closest("#evInfoSection");
    if (!section || !section.hidden) return;
    if (section.hasAttribute && section.hasAttribute("data-otra-removed")) return;
    section.hidden = false;
  }

  function isInfoCell(el) {
    return !!(el && el.classList && el.classList.contains("ev-info-cell"));
  }

  // Empty info cells may be authored as decorative colour blocks with an
  // inline background and no .k/.v children. A text override turns that block
  // into a normal value cell while leaving the rest of the grid untouched.
  function applyInfoCellText(el, value) {
    const next = parseInfoCellValue(value);
    if (!next.title && !next.subtitle) {
      el.innerHTML = "";
      syncInfoCellDecorativeState(el);
      return;
    }
    let title = el.querySelector(".k[data-otra-info-title]");
    let subtitle = el.querySelector(".v[data-otra-info-subtitle]");
    if (!title || !subtitle) {
      el.innerHTML = "";
      title = document.createElement("div");
      title.className = "k";
      title.dataset.otraInfoTitle = "1";
      el.appendChild(title);
      subtitle = document.createElement("div");
      subtitle.className = "v";
      subtitle.dataset.otraInfoSubtitle = "1";
      el.appendChild(subtitle);
    }
    if (title && title.textContent !== next.title) title.textContent = next.title;
    if (subtitle && subtitle.textContent !== next.subtitle) subtitle.textContent = next.subtitle;
    syncInfoCellDecorativeState(el);
  }

  function syncInfoCellDecorativeState(el) {
    if (!isInfoCell(el)) return;
    const title = el.querySelector(".k");
    const subtitle = el.querySelector(".v");
    const hasText = Boolean(
      (title && title.textContent.trim()) ||
      (subtitle && subtitle.textContent.trim())
    );
    if (!hasText) {
      el.classList.add("otra-empty-info-cell");
      el.style.removeProperty("background");
      el.style.removeProperty("background-color");
      el.style.removeProperty("background-image");
      return;
    }
    el.classList.remove("otra-empty-info-cell");
    el.style.removeProperty("background-color");
    el.style.removeProperty("background-image");
    // Force the normal information-cell surface after an empty slot gains
    // text, regardless of whether an older design supplied inline CSS.
    el.style.setProperty("background", "var(--ink, #11151b)", "important");
  }

  function parseInfoCellValue(value) {
    const raw = String(value || "");
    if (!raw.startsWith(INFO_CELL_VALUE_PREFIX)) {
      return { title: "", subtitle: raw };
    }
    try {
      const parsed = JSON.parse(raw.slice(INFO_CELL_VALUE_PREFIX.length));
      return {
        title: typeof parsed.title === "string" ? parsed.title : "",
        subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle : "",
      };
    } catch {
      return { title: "", subtitle: raw };
    }
  }

  function isDescriptionBody(el) {
    return el && el.classList && el.classList.contains("ev-body");
  }

  function applyDescriptionBody(el, value) {
    const next = String(value || "").trim();
    const current = [...el.querySelectorAll("p")]
      .map((p) => p.textContent.trim())
      .filter(Boolean)
      .join("\n\n");
    if (current === next) return;
    el.innerHTML = "";
    next
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        el.appendChild(p);
      });
  }

  // The template hides the story photo, feature photo/video, appreciation
  // band and photo band when the design has no image for them. A photo or
  // video saved from the editor for one of those empty slots must make it
  // show.
  function revealSlotSection(el, isImage) {
    if (!el || !el.closest) return;
    const section = el.closest("#story, #evVideoSection, #evBandSection, #evPhotoBandSection");
    if (!section) return;
    if (section.id === "story" && el.id === "evStoryImg") {
      el.hidden = false;
      if (section.style) section.style.gridTemplateColumns = "";
    } else if (section.id === "story") {
      return;
    }
    section.hidden = false;
    if (isImage && section.classList.contains("ev-video") && !section.classList.contains("is-live")) {
      section.classList.add("is-image");
    }
  }

  // Band heading or text saved from the editor on a draft whose design had
  // no band must make the band (and the hidden text block) show.
  function revealBandText(el, value) {
    if (!el || !el.closest || !String(value || "").trim()) return;
    if (el.id !== "evBandTitle" && el.id !== "evBandText") return;
    const band = el.closest("#evBandSection");
    if (!band) return;
    el.hidden = false;
    band.hidden = false;
  }

  function isVideoUrl(value) {
    return /\.(mp4|webm|mov)(\?|#|$)/i.test(value || "");
  }

  function applyGuardedImage(el, value) {
    if (isVideoUrl(value)) {
      applyVideoOverride(el, value);
      return;
    }
    if (el.tagName === "IMG") {
      const abs = new URL(value, location.href).href;
      if (el.src !== abs) {
        applyDecodedImage(el, value);
      }
      return;
    }
    if (el.tagName === "VIDEO") {
      const abs = new URL(value, location.href).href;
      if (el.poster !== abs) {
        el.poster = value;
      }
      return;
    }
    const bg = `url("${value.replace(/"/g, "%22")}")`;
    if (el.style.backgroundImage !== bg) {
      el.style.backgroundImage = bg;
    }
  }

  // An override value pointing at a video file turns the slot into a real
  // player: an <img> is swapped for a <video> (keeping id/class so selectors
  // and layout still match), an existing <video> just gets the new source.
  function applyVideoOverride(el, value, poster) {
    const abs = new URL(value, location.href).href;
    if (el.tagName === "VIDEO") {
      if (el.dataset.otraVideo !== abs) {
        el.src = value;
        el.controls = true;
        el.dataset.otraVideo = abs;
      }
      if (poster && !isVideoUrl(poster)) el.poster = poster;
      markVideoSectionLive(el);
      return;
    }
    if (el.dataset && el.dataset.otraVideo === abs) return;
    // Keep the original slot element in place (hidden): the page's own render
    // keeps finding it by id and writing the design image there - if the
    // <video> inherited that id, its src would be overwritten with a JPG and
    // playback would stall forever at readyState 0.
    const video = document.createElement("video");
    video.className = el.className;
    video.src = value;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    const posterSrc = poster && !isVideoUrl(poster) ? poster : el.tagName === "IMG" && el.src ? el.src : "";
    if (posterSrc) video.poster = posterSrc;
    // The event template sizes the video section's media by tag (.ev-video img)
    // and reserves .ev-video-el for a real full-bleed player; a swapped-in
    // <video> needs that class or it renders at its tiny intrinsic size.
    if (el.closest(".ev-video")) {
      video.classList.add("ev-video-el");
    } else if (!video.className) {
      video.style.width = "100%";
      video.style.height = "auto";
      video.style.display = "block";
    }
    el.dataset.otraVideo = abs;
    el.style.display = "none";
    el.insertAdjacentElement("afterend", video);
    markVideoSectionLive(video);
  }

  // The event template's video section shows a decorative play overlay on top
  // of the poster image; once a real player is in place the overlay must go.
  function markVideoSectionLive(el) {
    const section = el.closest && el.closest(".ev-video");
    if (section) section.classList.add("is-live");
  }

  function applyDecodedImage(el, value) {
    const pre = new Image();
    pre.src = value;
    function assign() { el.src = value; }
    if (typeof pre.decode === "function") {
      pre.decode().then(assign, assign);
    } else {
      pre.onload = pre.onerror = assign;
    }
  }
})();
