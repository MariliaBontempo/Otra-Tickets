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
      document.documentElement.style.setProperty("--accent", override.accentColor);
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
        img.src = override.image;
      });
    }
  }

  function applyFieldOverrides(fields, attempt = 0) {
    let applied = 0;
    for (const [key, field] of Object.entries(fields)) {
      if (!field) continue;
      const index = key.indexOf(":");
      if (index < 0) continue;
      const type = key.slice(0, index);
      const selector = key.slice(index + 1);
      let el = null;
      try {
        el = document.querySelector(selector);
        if (!el && selector.startsWith("main > #")) {
          el = document.querySelector(selector.slice("main > ".length));
        }
      } catch {
        continue;
      }
      if (!el) continue;

      if (type === "remove" && field.type === "remove") {
        el.remove();
        applied++;
        continue;
      }
      if (type === "text" && field.type === "text") {
        const value = typeof field.value === "string" ? field.value : "";
        el.textContent = value;
        if (value.includes("\n")) el.style.whiteSpace = "pre-line";
        applied++;
      }
      if (type === "image" && field.type === "image" && field.value) {
        applyImage(el, field.value);
        applied++;
      }
    }

    if (attempt < 30) {
      setTimeout(() => applyFieldOverrides(fields, attempt + 1), 250);
    }
  }

  function applyImage(el, value) {
    if (el.tagName === "IMG" || el.tagName === "VIDEO") {
      if (el.tagName === "VIDEO") el.poster = value;
      else el.src = value;
      return;
    }
    el.style.backgroundImage = `url("${value.replace(/"/g, "%22")}")`;
  }
})();
