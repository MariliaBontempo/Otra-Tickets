(function () {
  const id = inferOverrideId();
  if (!id) return;

  fetch("/api/override?id=" + encodeURIComponent(id), { cache: "no-store" })
    .then((resp) => (resp.ok ? resp.json() : null))
    .then((data) => {
      const override = data && data.override;
      if (!override) return;
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
        el.remove();
        applied.add(key);
        continue;
      }
      if (type === "text" && field.type === "text") {
        const value = typeof field.value === "string" ? field.value : "";
        if (isInfoCell(el)) {
          applyInfoCellText(el, value);
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
        applied.add(key);
        continue;
      }
      if (type === "image" && field.type === "image" && field.value) {
        applyGuardedImage(el, field.value);
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
        applied.add(key);
        continue;
      }
    }

    const remaining = Object.keys(fields).filter((k) => !applied.has(k));
    if (remaining.length > 0 && attempt < 30) {
      setTimeout(() => applyFieldOverrides(fields, attempt + 1, applied), 250);
    }
  }

  function isInfoCell(el) {
    return !!(el && el.classList && el.classList.contains("ev-info-cell"));
  }

  // Empty info cells may be authored as decorative colour blocks with an
  // inline background and no .k/.v children. A text override turns that block
  // into a normal value cell while leaving the rest of the grid untouched.
  function applyInfoCellText(el, value) {
    const next = String(value || "");
    let text = el.querySelector(".v[data-otra-info-text]");
    if (!text) {
      el.innerHTML = "";
      text = document.createElement("div");
      text.className = "v";
      text.dataset.otraInfoText = "1";
      text.style.marginTop = "0";
      el.appendChild(text);
    }
    if (text.textContent !== next) text.textContent = next;
    el.style.removeProperty("background");
    el.style.removeProperty("background-color");
    el.style.removeProperty("background-image");
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
