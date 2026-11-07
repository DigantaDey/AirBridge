/*
 * Injected into every page the Android shell loads.
 *
 * The paired UI is served by the desktop binary, not baked into the APK. This
 * shim keeps the status/navigation-bar, responsive header and Back behaviour
 * correct even when the desktop is still running an older build. Safe-area
 * insets are injected dynamically into CSS --ab-safe-top.
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
      'html.ab-native-shell[data-airbridge-native-shell]{' +
      '--ab-gutter:clamp(12px,4vw,24px);' +
      '--ab-safe-top:0px;--ab-safe-right:0px;--ab-safe-bottom:0px;--ab-safe-left:0px;}' +
      'html,body{width:100%!important;max-width:100vw!important;overflow-x:hidden!important;' +
      'overscroll-behavior-x:none!important;touch-action:pan-y!important;' +
      '-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}' +
      'input,textarea,select,pre,code,[contenteditable="true"]{-webkit-user-select:text!important;user-select:text!important;}' +
      'button,input,textarea,select{font:inherit;max-width:100%!important;}' +
      '.brand,.header-actions{min-width:0!important;}' +
      '.utility-modal{max-width:calc(100% - 40px)!important;}' +
      '.modal-backdrop{padding:12px var(--ab-gutter)!important;}' +
      '.text-button{white-space:normal!important;overflow-wrap:anywhere!important;}' +
      'html.ab-native-shell .header-action-label{display:none!important;}' +
      'html.ab-native-shell .header-count{display:none!important;}' +
      'html.ab-native-shell .header-action-button,html.ab-native-shell .header-actions>*{' +
      'min-width:38px!important;width:38px!important;height:38px!important;min-height:38px!important;' +
      'padding:0!important;border-radius:10px!important;display:inline-flex!important;align-items:center!important;' +
      'justify-content:center!important;position:relative!important;white-space:nowrap!important;overflow:visible!important;}' +
      'html.ab-native-shell .header-action-icon{width:18px!important;height:18px!important;}' +
      'html.ab-native-shell .header-count-badge{position:absolute!important;top:-4px!important;right:-4px!important;}' +
      '.utility-header{height:auto!important;min-height:calc(56px + var(--ab-safe-top,0px))!important;' +
      'padding-top:max(var(--ab-safe-top,0px),env(safe-area-inset-top,0px),28px)!important;' +
      'padding-bottom:10px!important;padding-left:var(--ab-gutter)!important;padding-right:var(--ab-gutter)!important;}' +
      '@media(max-width:920px){' +
      '.utility-header{flex-direction:row!important;flex-wrap:wrap!important;justify-content:space-between!important;align-items:center!important;gap:8px!important;}' +
      '.header-actions{display:flex!important;flex-wrap:nowrap!important;width:auto!important;' +
      'gap:8px!important;justify-content:flex-end!important;align-items:center!important;}' +
      '.utility-main{width:calc(100% - var(--ab-gutter) - var(--ab-gutter))!important;' +
      'max-width:680px!important;}' +
      '.device-heading h1,.device-copy strong,.device-copy small,.utility-footer{' +
      'overflow-wrap:anywhere!important;}' +
      '}' +
      '@media(max-width:480px){' +
      '.header-actions{display:flex!important;flex-wrap:nowrap!important;gap:6px!important;}' +
      '}';
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
