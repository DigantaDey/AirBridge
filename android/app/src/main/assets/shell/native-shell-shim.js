/*
 * Injected into every page the Android shell loads.
 *
 * The paired UI is served by the desktop binary, not baked into the APK. This
 * shim keeps the status/navigation-bar and Back behaviour correct even when the
 * desktop is still running an older build. The native container around the
 * WebView already reserves the real system-bar space, so CSS safe-area values
 * must stay at zero here to avoid double padding.
 */
(function () {
  if (window.__airbridgeNativeShellShimInstalled) return;
  window.__airbridgeNativeShellShimInstalled = true;

  var root = document.documentElement;
  root.classList.add("ab-native-shell");
  root.setAttribute("data-airbridge-native-shell", "1");

  var styleId = "__airbridgeNativeShellInsets";
  if (!document.getElementById(styleId)) {
    var style = document.createElement("style");
    style.id = styleId;
    style.textContent =
      ":root{--ab-safe-top:0px!important;--ab-safe-right:0px!important;" +
      "--ab-safe-bottom:0px!important;--ab-safe-left:0px!important;}" +
      "html,body{max-width:100%;overflow-x:hidden;}";
    (document.head || root).appendChild(style);
  }

  /* Preserve a page-specific handler (React app or connect.html) if present. */
  var existing = window.__airbridgeSystemBack;
  var selector =
    '.modal-backdrop,[aria-modal="true"],[role="dialog"],.utility-toast,[data-airbridge-overlay]';

  function visible(el) {
    if (!el || (el.hasAttribute && el.hasAttribute("hidden"))) return false;
    var computed = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (!computed) return true;
    var opacity = parseFloat(computed.opacity || "1");
    return (
      computed.display !== "none" &&
      computed.visibility !== "hidden" &&
      (isNaN(opacity) || opacity > 0)
    );
  }

  function topLayer() {
    var nodes = document.querySelectorAll(selector);
    for (var i = nodes.length - 1; i >= 0; i -= 1) {
      if (visible(nodes[i])) return nodes[i];
    }
    return null;
  }

  function escapeEvent() {
    if (typeof KeyboardEvent === "function") {
      return new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      });
    }
    var event = document.createEvent("Event");
    event.initEvent("keydown", true, true);
    event.key = "Escape";
    return event;
  }

  function dispatchEscape() {
    /* Bubbling from document reaches both document and window listeners once. */
    document.dispatchEvent(escapeEvent());
  }

  function closeLayer() {
    var layer = topLayer();
    if (!layer) return false;
    var close = layer.querySelector(
      '.modal-close,[aria-label="Close"],[aria-label="close"],[data-airbridge-close]'
    );
    if (close && typeof close.click === "function") {
      close.click();
      return true;
    }
    dispatchEscape();
    /* Consume Back while a sheet is visible rather than exiting the app. */
    return true;
  }

  window.__airbridgeSystemBack = function () {
    if (typeof existing === "function" && existing() === true) return true;
    return closeLayer();
  };
})();
