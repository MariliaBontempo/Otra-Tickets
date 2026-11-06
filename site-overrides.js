(function () {
  const INFO_CELL_VALUE_PREFIX = "otra-info-cell:";
  // Same separator as functions/_lib/hero-meta-text.js META_SEPARATOR.
  const INLINE_DOT = " · ";
  // Same rules as functions/_lib/rich-text.js (server/test/rich-text.test.mjs
  // checks the two agree).
  const RICH_TEXT_SIZES = [50, 70, 75, 80, 90, 100, 110, 125, 150, 200];
  const RICH_TEXT_MAX_HTML = 40000;
  const RICH_TEXT_MAX_DEPTH = 6;
  const RICH_FORMAT_TAGS = { strong: "strong", b: "strong", em: "em", i: "em", u: "u" };
  // One price fit per task, however many triggers fire (see fitPriceAmounts).
  let fitQueued = false;
  let priceCardObserver = null;
  // event.html renderMeta() calls this after it builds the hero line, and
  // this script runs it again after every pass of page edits.
  if (typeof window !== "undefined") window.otraTidyMetaLine = tidyMetaLine;
  // Pencil rich text (font size, colour, bold, italic, underline). The admin
  // editor reads this from the preview page so both use one parser.
  if (typeof window !== "undefined") {
    window.otraRichText = {
      SIZES: RICH_TEXT_SIZES.slice(),
      parse: parseRichText,
      inlineSize: richInlineSize,
      serialize: serializeRichText,
      toPlain: richTextToPlain,
      hasFormatting: richTextHasFormatting,
      normalize: (html) => {
        const nodes = parseRichText(html);
        return richTextHasFormatting(nodes) ? serializeRichText(nodes) : "";
      },
      render: renderRichText,
      ensureStyle: ensureRichTextStyle,
    };
  }
  tidyMetaLine();
  // The event can render before this script loads, so its render event is
  // missed; sync the band classes now and again on load as well.
  syncBandLayout();
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("otra:event-rendered", () => tidyMetaLine());
    document.addEventListener("otra:event-rendered", queueFitPriceAmounts);
    document.addEventListener("otra:event-rendered", () => syncBandLayout());
    // Emails in design text (not only page edits) become mailto links.
    document.addEventListener("otra:event-rendered", () => linkifyContentEmails());
    document.addEventListener("DOMContentLoaded", () => linkifyContentEmails());
    document.addEventListener("DOMContentLoaded", queueFitPriceAmounts);
    document.addEventListener("input", (e) => {
      if (e.target && e.target.closest && e.target.closest(".ev-rate .rp")) queueFitPriceAmounts();
    });
    // Price widths change when the display font arrives.
    if (document.fonts && typeof document.fonts.addEventListener === "function") {
      document.fonts.addEventListener("loadingdone", queueFitPriceAmounts);
    }
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("load", queueFitPriceAmounts);
    window.addEventListener("load", () => syncBandLayout());
    window.addEventListener("load", () => linkifyContentEmails());
    window.addEventListener("resize", queueFitPriceAmounts);
  }
  const id = inferOverrideId();
  if (!id) return;
  // Set from the server answer: true only on an unpublished draft page.
  let draftOnlyRemovalsOk = false;
  let guideTitle = "";

  // Staff sessions (the admin editor preview) send the admin token so pages of
  // events hidden on Otra Guide still show their edits there.
  let adminToken = "";
  try { adminToken = sessionStorage.getItem("otra_admin_token") || ""; } catch (e) { adminToken = ""; }
  fetch(
    "/api/override?id=" + encodeURIComponent(id),
    adminToken ? { cache: "no-store", headers: { authorization: "Bearer " + adminToken } } : { cache: "no-store" }
  )
    .then((resp) => resp.json().catch(() => ({}))
      .then((data) => resp.ok ? data : { ...data, _httpError: true }))
    .then((data) => {
      const override = data && data.override;
      // Only blank the page when the server says the Guide-owned title is gone
      // or unavailable. Generic HTTP errors keep static/local manual pages visible.
      if (data && data.guideTitleHidden) { hideUnavailableManualTitle(); return; }
      if (data && data.guideTitleUnavailable) { hideUnavailableManualTitle(); return; }
      if (data && data._httpError) { showAvailableManualTitle(); return; }
      if (!override) { showAvailableManualTitle(); return; }
      guideTitle = typeof override.guideTitle === "string" ? override.guideTitle : "";
      draftOnlyRemovalsOk = override.draftOnlyRemovals === true && /^draft-(?!prod-)/.test(id);
      applyLegacyOverride(override);
      applyFieldOverrides(override.fields || {});
      showAvailableManualTitle();
      if (typeof document.addEventListener === "function") {
        document.addEventListener("otra:event-rendered", () => {
          applyLegacyOverride(override);
          applyFieldOverrides(override.fields || {}, 0, new Set());
        });
      }
    })
    // A network failure or a render error is not a Guide answer: keep the page
    // visible (non-owned manual pages are local content). An owned page that
    // already received its Guide title re-applies it so no static H1 remains.
    .catch(() => {
      try { applyGuideTitle(); } catch { /* keep page visible */ }
      showAvailableManualTitle();
    });

  function showAvailableManualTitle() {
    const main = document.querySelector("main[data-otra-guide-title-page]");
    if (main) main.hidden = false;
  }

  function hideUnavailableManualTitle() {
    // Generic event.html has its own API error/not-found state. Hand-built
    // pages must not leave static/legacy titles visible when Guide has none.
    const main = document.querySelector("main[data-otra-guide-title-page]");
    if (!main) return;
    main.hidden = true;
    document.title = "Event unavailable | Otra Tickets";
  }

  function applyGuideTitle() {
    if (!guideTitle) return;
    const h1 = document.querySelector("#evTitle");
    if (h1) {
      const plain = String(h1.textContent || "").replace(/\s+/g, " ").trim();
      // Keep an already-applied style-only rich title whose plain text matches.
      if (h1.__otraRichKey && plain === String(guideTitle).trim()) {
        /* keep rich markup */
      } else if (h1.textContent !== guideTitle) {
        h1.textContent = guideTitle;
        h1.__otraRichKey = "";
      }
    }
    document.title = "Otra Tickets — " + guideTitle;
  }

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
            linkifyEmails(p);
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
      const canonicalH1 = guideTitle ? document.querySelector("#evTitle") : null;
      // Legacy structural selectors can target H1 or its wrapper without
      // mentioning #evTitle. They cannot delete/replace a Guide-owned title.
      // Style-only rich html on the H1 itself is allowed when plain text still
      // equals the Guide title (Model B SSOT + #115 formatting layer).
      if (canonicalH1 && (type === "text" || type === "remove") &&
          (el === canonicalH1 || (typeof el.contains === "function" && el.contains(canonicalH1)))) {
        if (type === "text" && el === canonicalH1 && field && field.html) {
          const plain = (window.otraRichText && typeof window.otraRichText.toPlain === "function")
            ? String(window.otraRichText.toPlain(window.otraRichText.parse(field.html)) || "").trim()
            : String(field.value || "").trim();
          if (plain === String(guideTitle).trim()) applyRichField(el, field, false);
        }
        applied.add(key); continue;
      }

      if (type === "remove" && field.type === "remove") {
        // Before You Go is hidden only on an unpublished draft page; a live
        // page keeps it whatever selector a saved remove field uses.
        if (!draftOnlyRemovalsOk && hidesBeforeYouGo(el)) { applied.add(key); continue; }
        applyRemoval(el);
        applied.add(key);
        continue;
      }
      if (type === "text" && field.type === "text") {
        let value = typeof field.value === "string" ? field.value : "";
        if (isInfoCell(el)) {
          applyInfoCellText(el, value, field.htmlParts);
          revealInfoSection(el);
          applied.add(key);
          continue;
        }
        if (isDescriptionBody(el)) {
          if (!applyRichField(el, field, true)) applyDescriptionBody(el, value);
          applied.add(key);
          continue;
        }
        const priceAmount = isPriceAmount(el);
        if (applyRichField(el, field, false, priceAmount)) {
          if (priceAmount) fitPriceAmount(el);
          revealBandText(el, value);
          const richCell = el.closest && el.closest(".ev-info-cell");
          if (richCell) {
            syncInfoCellDecorativeState(richCell);
            revealInfoSection(richCell);
          }
          applied.add(key);
          continue;
        }
        if (priceAmount) value = value.replace(/\s+/g, " ").trim();
        if (el.textContent !== value || el.__otraRichKey) {
          el.textContent = value;
          el.__otraRichKey = "";
          if (value.includes("\n")) el.style.whiteSpace = "pre-line";
        }
        if (priceAmount) fitPriceAmount(el);
        // After the compare: a page re-render resets the text (and drops the
        // links) while it still equals the saved value. Only band / story /
        // info-cell text (same targets as linkifyContentEmails), never titles
        // or rate names.
        else if (
          (el.id === "evBandText") ||
          (el.classList && el.classList.contains("ev-body")) ||
          (el.classList && el.classList.contains("v") && el.closest && el.closest(".ev-info-cell"))
        ) {
          linkifyEmails(el);
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

    if (typeof syncBandLayout === "function") syncBandLayout();
    if (typeof linkifyContentEmails === "function") linkifyContentEmails();
    tidyMetaLine();
    applyGuideTitle();
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
    if (!item) return;
    if (item.children && item.children.length) {
      if (!item.hasAttribute || !item.hasAttribute("data-otra-rich")) return;
      const walk = (parent) => Array.from(parent.childNodes || []).forEach((node) => {
        if (node.nodeType === 1) {
          if (!isAdminControl(node) && !(node.classList && node.classList.contains("dot"))) walk(node);
          return;
        }
        if (node.nodeType !== 3 || !String(node.nodeValue || "").includes(INLINE_DOT)) return;
        String(node.nodeValue).split(INLINE_DOT).forEach((part, index) => {
          if (index) {
            const dot = document.createElement("span");
            dot.className = "dot dot-inline";
            dot.textContent = INLINE_DOT;
            parent.insertBefore(dot, node);
          }
          if (part) parent.insertBefore(document.createTextNode(part), node);
        });
        parent.removeChild(node);
      });
      walk(item);
      return;
    }
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
  function applyInfoCellText(el, value, htmlParts) {
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
    if (!applyRichField(title, { html: htmlParts && htmlParts.title }, false)) {
      if (title && (title.__otraRichKey || title.textContent !== next.title)) {
        title.textContent = next.title;
        title.__otraRichKey = "";
      }
    }
    if (!applyRichField(subtitle, { html: htmlParts && htmlParts.subtitle }, false)) {
      if (subtitle && (subtitle.__otraRichKey || subtitle.textContent !== next.subtitle)) {
        subtitle.textContent = next.subtitle;
        subtitle.__otraRichKey = "";
      }
    }
    if (subtitle) linkifyEmails(subtitle);
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

  // A price card amount ("XCG 5000") is one unit: a line break saved in its
  // text override becomes a space so currency and number never split.
  function isPriceAmount(el) {
    return !!(el && el.classList && el.classList.contains("rp") && el.closest && el.closest(".ev-rate"));
  }

  // Price card amounts never wrap (CSS nowrap). One wider than its card, like
  // "XCG 10,000" in a narrow four card row, gets just enough smaller to fit;
  // amounts that already fit keep the page's size.
  function fitPriceAmounts() {
    document.querySelectorAll(".ev-rate .rp").forEach(fitPriceAmount);
  }

  function fitPriceAmount(el) {
    if (!priceCardObserver && typeof ResizeObserver === "function") {
      priceCardObserver = new ResizeObserver(queueFitPriceAmounts);
    }
    // Refit whenever a card changes width (layout, viewport, editor frame).
    if (priceCardObserver && el.parentElement) priceCardObserver.observe(el.parentElement);
    if (el.style.fontSize) el.style.fontSize = "";
    const room = el.clientWidth;
    if (!room || el.scrollWidth <= room) return;
    const size = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = Math.floor((size * (room - 1)) / el.scrollWidth) + "px";
  }

  function queueFitPriceAmounts() {
    if (fitQueued || typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    fitQueued = true;
    setTimeout(() => {
      fitQueued = false;
      fitPriceAmounts();
    }, 0);
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
    if (current === next) {
      el.querySelectorAll("p").forEach(linkifyEmails);
      return;
    }
    el.innerHTML = "";
    next
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        el.appendChild(p);
        linkifyEmails(p);
      });
  }

  // Plain email addresses in page text become mailto links, e.g.
  // "Enquiries: a@b.com" -> "Enquiries: " + <a href="mailto:a@b.com">.
  // Only text nodes are split (never innerHTML), so the text is never parsed
  // as HTML, line breaks stay for white-space: pre-line, and el.textContent is
  // unchanged: compare-before-set guards and the admin editor read the same
  // text. Text already inside a link is left alone, so running it again is a
  // no-op. Price amounts are never passed in.
  function linkifyEmails(el) {
    if (!el || typeof document === "undefined") return;
    if (typeof document.createElement !== "function" || typeof document.createTextNode !== "function") return;
    if (!el.childNodes || typeof el.insertBefore !== "function") return;
    // Never a link inside a link or button (e.g. an edited .btn-metal).
    if (typeof el.closest === "function" && el.closest("a, button")) return;
    if (!String(el.textContent || "").includes("@")) return;
    const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
    const textNodes = [];
    const walk = (node) => {
      Array.from(node.childNodes || []).forEach((child) => {
        if (child.nodeType === 3) textNodes.push(child);
        else if (child.nodeType === 1 && String(child.tagName || "").toUpperCase() !== "A" && !isAdminControl(child)) walk(child);
      });
    };
    walk(el);
    textNodes.forEach((node) => {
      const text = node.nodeValue || "";
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const parent = node.parentNode;
      if (!parent || typeof parent.insertBefore !== "function" || typeof parent.removeChild !== "function") return;
      let last = 0;
      let match;
      while ((match = re.exec(text))) {
        const email = match[0];
        if (match.index > last) parent.insertBefore(document.createTextNode(text.slice(last, match.index)), node);
        const a = document.createElement("a");
        a.href = "mailto:" + email;
        a.textContent = email;
        a.setAttribute("data-otra-mailto", "1");
        // The pages have no global link style: keep the text colour, underlined.
        if (a.style) {
          a.style.color = "inherit";
          a.style.textDecoration = "underline";
          a.style.textUnderlineOffset = "3px";
        }
        parent.insertBefore(a, node);
        last = match.index + email.length;
      }
      if (last < text.length) parent.insertBefore(document.createTextNode(text.slice(last)), node);
      parent.removeChild(node);
    });
  }

  // Text blocks that may hold an organizer email, whatever set their text
  // (the event design render or a page edit).
  function linkifyContentEmails() {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    document.querySelectorAll("#evBandText, #evBody p, .ev-info-cell .v").forEach(linkifyEmails);
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
    // Guarded: the check scripts lift single functions out of this file.
    if (typeof syncBandLayout === "function") syncBandLayout(band);
  }

  // Mirrors the .ev-band:has(...) rules in event.html as classes, so a band
  // with text, sponsors or detailed perks grows to fit on browsers without
  // :has() instead of clipping inside its 16:9 box.
  function syncBandLayout(band) {
    if (typeof document === "undefined") return;
    const el = band || (typeof document.getElementById === "function" ? document.getElementById("evBandSection") : null);
    if (!el || !el.classList || typeof el.querySelector !== "function") return;
    const shown = (sel) => {
      const node = el.querySelector(sel);
      return !!node && !node.hidden;
    };
    const hasText = shown("#evBandText");
    const grow = hasText || shown("#evSponsors") || !!el.querySelector(".ev-like.detailed");
    el.classList.toggle("ev-band--text", hasText);
    el.classList.toggle("ev-band--grow", grow);
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
  // ---- Pencil rich text -------------------------------------------------
  // Stored markup is only <strong> <em> <u> <br> and
  // <span data-otra-size="N" data-otra-color="#rrggbb">. It is never set
  // through innerHTML: the parser below builds a whitelisted tree and the
  // page gets fresh elements from it. Sizes are percents of the element's
  // own (responsive, clamp()) font size, applied as em, so a 75% title is
  // 75% of the title size at every screen width. On phones a size above
  // 100% is capped at 120% so a large word cannot push past the screen.

  // Returns true when the field had rich text and it was rendered.
  function applyRichField(el, field, paragraphs, priceAmount) {
    if (!el || !field || typeof field.html !== "string" || !field.html) return false;
    const nodes = parseRichText(field.html);
    if (priceAmount) {
      const singleLine = (list) => list.forEach((node, index) => {
        if (typeof node === "string") list[index] = node.replace(/\s+/g, " ");
        else if (node.tag === "br") list[index] = " ";
        else singleLine(node.children || []);
      });
      singleLine(nodes);
    }
    if (!richTextHasFormatting(nodes)) return false;
    // Emails become links only where plain edits link them (band, story,
    // info text), never in titles or rate names.
    const linkify = !!paragraphs || el.id === "evBandText" ||
      !!(el.classList && el.classList.contains("v") && el.closest && el.closest(".ev-info-cell"));
    renderRichText(el, nodes, { paragraphs, linkify });
    return true;
  }

  function ensureRichTextStyle(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || typeof d.createElement !== "function" || typeof d.getElementById !== "function") return;
    if (d.getElementById("otra-rich-text-style")) return;
    const style = d.createElement("style");
    style.id = "otra-rich-text-style";
    style.textContent =
      "[data-otra-rich]{overflow-wrap:anywhere}" +
      "[data-otra-rich] .otra-rt{font-weight:inherit;letter-spacing:inherit;text-transform:inherit;font-style:inherit;color:inherit}" +
      "[data-otra-rich] .otra-rt:not([data-otra-size]){font-size:inherit}" +
      ".otra-rt[data-otra-size]{font-size:calc(1em * var(--otra-fs, 1) / var(--otra-parent-fs, 1))}" +
      "@media (max-width: 620px){.otra-rt[data-otra-size]{font-size:calc(1em * min(var(--otra-fs, 1), 1.2) / min(var(--otra-parent-fs, 1), 1.2))}}";
    (d.head || d.documentElement).appendChild(style);
  }

  // nodesOrHtml: a parsed tree or stored html. options.paragraphs splits the
  // text into <p> at blank lines (the story body), like plain edits do.
  function renderRichText(el, nodesOrHtml, options) {
    if (!el) return false;
    const nodes = typeof nodesOrHtml === "string" ? parseRichText(nodesOrHtml) : (nodesOrHtml || []);
    const key = serializeRichText(nodes) + (options && options.paragraphs ? "|p" : "");
    // Compare before set: a second pass with the same edit leaves the DOM alone.
    if (el.__otraRichKey === key && el.firstChild && el.firstChild === el.__otraRichFirst) return false;
    const doc = el.ownerDocument || document;
    const linkify = !(options && options.linkify === false);
    ensureRichTextStyle(doc);
    el.setAttribute("data-otra-rich", "1");
    while (el.firstChild) el.removeChild(el.firstChild);
    if (options && options.paragraphs) {
      splitRichParagraphs(nodes).forEach((part) => {
        const p = doc.createElement("p");
        appendRichNodes(doc, p, part);
        el.appendChild(p);
        if (linkify) linkifyEmails(p);
      });
    } else {
      appendRichNodes(doc, el, nodes);
      if (linkify) linkifyEmails(el);
    }
    if (el.style && el.style.whiteSpace === "pre-line") el.style.whiteSpace = "";
    el.__otraRichKey = key;
    el.__otraRichFirst = el.firstChild;
    return true;
  }

  function appendRichNodes(doc, parent, nodes, parentSize = 100) {
    (nodes || []).forEach((node) => {
      if (typeof node === "string") { parent.appendChild(doc.createTextNode(node)); return; }
      if (node.tag === "br") { parent.appendChild(doc.createElement("br")); return; }
      const tag = node.tag === "span" ? "span" : node.tag === "strong" ? "strong" : node.tag === "em" ? "em" : node.tag === "u" ? "u" : "";
      if (!tag) return;
      const child = doc.createElement(tag);
      if (tag === "span") {
        child.className = "otra-rt";
        if (node.size) {
          child.setAttribute("data-otra-size", String(node.size));
          child.style.setProperty("--otra-fs", String(node.size / 100));
          child.style.setProperty("--otra-parent-fs", String(parentSize / 100));
        }
        if (node.color) {
          child.setAttribute("data-otra-color", node.color);
          child.style.color = node.color;
        }
      }
      appendRichNodes(doc, child, node.children, node.size || parentSize);
      parent.appendChild(child);
    });
  }

  // Blank lines split story paragraphs even when the entire story is inside
  // a size/color span. Carry inline ancestors into each new paragraph.
  function splitRichParagraphs(nodes) {
    const leaves = [];
    const walk = (list, path) => (list || []).forEach((node) => {
      if (typeof node === "string" || node.tag === "br") leaves.push({ node, path });
      else walk(node.children, path.concat(node));
    });
    walk(nodes, []);
    const parts = [];
    let current = [];
    let breaks = [];
    const wrap = ({ node, path }) => path.reduceRight((child, parent) => ({ ...parent, children: [child] }), node);
    const flush = () => {
      if (current.length) parts.push(current);
      current = [];
    };
    leaves.forEach((leaf) => {
      if (leaf.node && leaf.node.tag === "br") { breaks.push(leaf); return; }
      if (typeof leaf.node === "string" && !leaf.node.trim() && breaks.length) return;
      if (breaks.length >= 2) flush();
      else if (breaks.length && current.length) current.push(wrap(breaks[0]));
      breaks = [];
      current.push(wrap(leaf));
    });
    flush();
    return parts;
  }

  function decodeRichEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
      const key = name.toLowerCase();
      if (key === "amp") return "&";
      if (key === "lt") return "<";
      if (key === "gt") return ">";
      if (key === "quot") return '"';
      if (key === "apos") return "'";
      if (key === "nbsp") return " ";
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    });
  }

  function richAttr(attrs, name) {
    const match = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i").exec(attrs || "");
    if (!match) return "";
    const raw = match[1] != null ? match[1] : match[2] != null ? match[2] : match[3] != null ? match[3] : "";
    return decodeRichEntities(raw).trim();
  }

  function richSize(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!/^\d{2,3}$/.test(text)) return 0;
    const size = Number(text);
    return RICH_TEXT_SIZES.indexOf(size) >= 0 ? size : 0;
  }

  function richColor(raw) {
    const text = String(raw == null ? "" : raw).trim().toLowerCase();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
    if (short) return "#" + short[1] + short[1] + short[2] + short[2] + short[3] + short[3];
    return /^#[0-9a-f]{6}$/.test(text) ? text : "";
  }

  function richInlineSize(raw) {
    const match = /^(\d+(?:\.\d+)?)(%|em|rem|px)$/i.exec(String(raw || "").trim());
    if (!match) return 0;
    const number = Number(match[1]);
    if (!(number > 0)) return 0;
    const percent = match[2].toLowerCase() === "%" ? number : match[2].toLowerCase() === "px" ? number / 16 * 100 : number * 100;
    return RICH_TEXT_SIZES.reduce((best, size) => Math.abs(size - percent) < Math.abs(best - percent) ? size : best, 100);
  }

  function richInlineProperty(attrs, name) {
    const style = richAttr(attrs, "style");
    let result = "";
    style.split(";").forEach((part) => {
      const index = part.indexOf(":");
      if (index >= 0 && part.slice(0, index).trim().toLowerCase() === name) result = part.slice(index + 1).trim();
    });
    return result;
  }

  function parseRichText(html) {
    const src = String(html == null ? "" : html)
      .slice(0, RICH_TEXT_MAX_HTML)
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<(script|style|template|iframe|object|embed|noscript|textarea|title|svg|math|select|button)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
    const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>|([^<]+)|(<)/g;
    const root = { tag: null, src: "", children: [] };
    const stack = [root];
    let skippedDepth = 0;
    const top = () => stack[stack.length - 1];
    const pushText = (text) => {
      if (!text) return;
      const list = top().children;
      String(text).split(/\r\n?|\n/).forEach((line, index) => {
        if (index) list.push({ tag: "br" });
        if (!line) return;
        if (typeof list[list.length - 1] === "string") list[list.length - 1] += line;
        else list.push(line);
      });
    };
    let match;
    while ((match = token.exec(src))) {
      if (match[4] != null || match[5] != null) {
        pushText(decodeRichEntities(match[4] != null ? match[4] : match[5]));
        continue;
      }
      const closing = match[1] === "/";
      const name = match[2].toLowerCase();
      if (name === "br") {
        if (!closing) top().children.push({ tag: "br" });
        continue;
      }
      if (name === "p" || name === "div" || name === "li") {
        if (closing) {
          top().children.push({ tag: "br" });
          if (name === "p") top().children.push({ tag: "br" });
        }
        continue;
      }
      const isFormat = Object.prototype.hasOwnProperty.call(RICH_FORMAT_TAGS, name);
      const isSpan = name === "span" || name === "font";
      if (!isFormat && !isSpan) continue;
      if (closing) {
        if (skippedDepth) { skippedDepth -= 1; continue; }
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].src === name) { stack.length = i; break; }
        }
        continue;
      }
      if (skippedDepth || stack.length > RICH_TEXT_MAX_DEPTH) { skippedDepth += 1; continue; }
      let node;
      if (isFormat) node = { tag: RICH_FORMAT_TAGS[name], src: name, children: [] };
      else {
        const attrs = match[3];
        const fontSize = name === "font" ? { 1: 50, 2: 75, 3: 100, 4: 125, 5: 150, 6: 150, 7: 200 }[richAttr(attrs, "size")] || 0 : 0;
        const size = richSize(richAttr(attrs, "data-otra-size")) || richInlineSize(richInlineProperty(attrs, "font-size")) || fontSize;
        const color = richColor(richAttr(attrs, "data-otra-color")) || richColor(richInlineProperty(attrs, "color")) || (name === "font" ? richColor(richAttr(attrs, "color")) : "");
        node = size || color ? { tag: "span", src: name, size, color, children: [] } : { tag: null, src: name, children: [] };
      }
      top().children.push(node);
      stack.push(node);
    }
    return tidyRichNodes(root.children, true);
  }

  function tidyRichNodes(nodes, isRoot) {
    const out = [];
    nodes.forEach((node) => {
      if (typeof node === "string") {
        if (!node) return;
        if (typeof out[out.length - 1] === "string") out[out.length - 1] += node;
        else out.push(node);
        return;
      }
      if (node.tag === "br") { out.push({ tag: "br" }); return; }
      const children = tidyRichNodes(node.children || [], false);
      if (!node.tag) {
        children.forEach((child) => {
          if (typeof child === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] += child;
          else out.push(child);
        });
        return;
      }
      if (!children.length) return;
      const next = { tag: node.tag, children };
      if (node.tag === "span") { next.size = node.size || 0; next.color = node.color || ""; }
      out.push(next);
    });
    if (isRoot) {
      while (out.length && out[0].tag === "br") out.shift();
      while (out.length && out[out.length - 1].tag === "br") out.pop();
    }
    return out;
  }

  function serializeRichText(nodes) {
    return (nodes || []).map((node) => {
      if (typeof node === "string") {
        return node.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      if (node.tag === "br") return "<br>";
      const inner = serializeRichText(node.children);
      if (node.tag === "span") {
        const size = node.size ? ' data-otra-size="' + node.size + '"' : "";
        const color = node.color ? ' data-otra-color="' + node.color + '"' : "";
        return "<span" + size + color + ">" + inner + "</span>";
      }
      return "<" + node.tag + ">" + inner + "</" + node.tag + ">";
    }).join("");
  }

  function richTextHasFormatting(nodes) {
    return (nodes || []).some((node) => typeof node === "object" && node.tag !== "br");
  }

  function richTextToPlain(nodes) {
    return (nodes || []).map((node) => {
      if (typeof node === "string") return node;
      if (node.tag === "br") return "\n";
      return richTextToPlain(node.children);
    }).join("");
  }
})();
