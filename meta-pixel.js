(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined" || window.OTRAMeta) return;

  const PIXEL_ID = "9500041730032996";
  const query = new URLSearchParams(window.location.search);
  const production = window.location.protocol === "https:" &&
    ["otratickets.com", "www.otratickets.com", "otraguide.com", "www.otraguide.com"].includes(window.location.hostname);
  let enabled = production || query.get("meta_debug") === "1";
  // Exclude staff previews, including the editor's same-origin iframe.
  try {
    enabled = enabled && window.top === window &&
      !/^\/admin(?:\/|\.html|$)/.test(window.location.pathname) &&
      !query.has("_preview") && query.get("preview") !== "1" && query.get("adminView") !== "1" &&
      !window.sessionStorage.getItem("otra_admin_token");
  } catch { enabled = false; }

  let pageViewed = false;
  const viewed = new Set();
  const conversions = new Set();
  function track(name, params, eventID) {
    if (!enabled || typeof window.fbq !== "function") return false;
    try {
      if (eventID) window.fbq("track", name, params, { eventID });
      else window.fbq("track", name, params);
      return true;
    } catch { return false; }
  }

  function conversionParams(data) {
    if (!data || typeof data.value !== "number" || !Number.isFinite(data.value) || data.value < 0 ||
        typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency) ||
        !Array.isArray(data.contents) || !data.contents.length) return null;
    const contents = [];
    for (const item of data.contents) {
      if (!item || !/^[\w-]{1,200}$/.test(String(item.id ?? "")) ||
          !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
          typeof item.item_price !== "number" || !Number.isFinite(item.item_price) || item.item_price < 0) return null;
      // Explicit allowlist: never forward customer fields from a checkout payload.
      contents.push({ id: String(item.id), quantity: item.quantity, item_price: item.item_price });
    }
    const num_items = contents.reduce((sum, item) => sum + item.quantity, 0);
    if (!Number.isSafeInteger(num_items)) return null;
    return { content_ids: contents.map(item => item.id), contents, content_type: "product",
      value: data.value, currency: data.currency, num_items };
  }

  async function conversion(name, data, id) {
    try {
      if (!enabled || !/^[\w-]{1,200}$/.test(String(id ?? ""))) return false;
      const params = conversionParams(data);
      if (!params || (name === "Purchase" && data.paymentStatus !== "paid")) return false;
      // Backend CAPI must use this exact event_id for the same order/session.
      const eventID = `otratickets:${name}:${id}`;
      const key = `meta:${PIXEL_ID}:${eventID}`;
      const send = () => {
        // Fail closed when storage is unavailable, rather than re-counting purchases.
        const storage = name === "Purchase" ? window.localStorage : window.sessionStorage;
        if (conversions.has(key) || storage.getItem(key)) return false;
        storage.setItem(key, "1");
        if (!track(name, params, eventID)) {
          storage.removeItem(key);
          return false;
        }
        conversions.add(key);
        return true;
      };
      // Serialize purchase notifications from multiple tabs where Web Locks is supported.
      if (name === "Purchase" && window.navigator?.locks) {
        return await window.navigator.locks.request(key, send);
      }
      // ponytail: without Web Locks, storage dedupes refreshes but not simultaneous tabs;
      // server-side CAPI/order deduplication is the upgrade for cross-device guarantees.
      return send();
    } catch { return false; }
  }

  window.OTRAMeta = {
    enabled,
    pageView() {
      // This is a multi-page site. Canonical replaceState and #book are not new views.
      if (!pageViewed) pageViewed = track("PageView");
    },
    viewContent(event) {
      if (!event || event.id == null || !event.title || event.isDraft) return;
      const id = String(event.id);
      if (viewed.has(id)) return;
      // Display prices vary by tier/date and the API may default missing currency.
      // Omit money here; conversion events must use the confirmed checkout amounts.
      if (track("ViewContent", {
        content_ids: [id], content_name: event.title,
        content_type: "product", content_category: "Event",
      })) viewed.add(id);
    },
    purchase(data) { return conversion("Purchase", data, data?.orderId); },
    initiateCheckout(data) { return conversion("InitiateCheckout", data, data?.checkoutId); },
  };

  window.addEventListener("message", function (event) {
    try {
      if (!enabled || event.data?.type !== "OTRA_CHECKOUT_STARTED") return;
      const iframe = document.querySelector("#otra-checkout-container iframe");
      if (!iframe || event.source !== iframe.contentWindow) return;
      const origin = new URL(iframe.src).origin;
      const localTest = !production && query.get("meta_debug") === "1" &&
        ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
      if (event.origin !== origin || (origin !== "https://otraguide.com" && !localTest)) return;
      window.OTRAMeta.initiateCheckout(event.data.data);
    } catch { /* No acknowledgement, navigation or payment dependency. */ }
  });

  if (!enabled) return;
  try {
    // Meta's standard asynchronous loader; fbq queues events before fbevents is ready.
    !function(f,b,e,v,n,t,s) {
      if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};
      if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
      n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t,s);
    }(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');
    window.fbq("init", PIXEL_ID);
    window.OTRAMeta.pageView();
  } catch { /* Tracking must never interrupt the page or checkout. */ }
})();
