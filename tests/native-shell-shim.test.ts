// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const script = readFileSync(
  path.join(
    process.cwd(),
    "android/app/src/main/assets/shell/native-shell-shim.js",
  ),
  "utf8",
);

interface ShimWindow extends Window {
  eval(script: string): unknown;
  __airbridgeSystemBack?: () => boolean;
  __airbridgeNativeShellShimInstalled?: boolean;
}

const opened: JSDOM[] = [];

function mount(body: string): { dom: JSDOM; win: ShimWindow } {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    runScripts: "dangerously",
    url: "http://127.0.0.1/",
  });
  opened.push(dom);
  return {
    dom,
    win: dom.window as unknown as ShimWindow,
  };
}

afterEach(() => {
  while (opened.length) opened.pop()?.window.close();
});

describe("Android native-shell shim", () => {
  it("marks the page native and zeroes CSS safe areas exactly once", () => {
    const { win } = mount("");
    win.eval(script);
    win.eval(script);

    expect(win.document.documentElement.classList.contains("ab-native-shell")).toBe(true);
    expect(
      win.document.documentElement.getAttribute("data-airbridge-native-shell"),
    ).toBe("1");
    expect(win.__airbridgeNativeShellShimInstalled).toBe(true);
    expect(
      win.document.querySelectorAll("#__airbridgeNativeShellInsets"),
    ).toHaveLength(1);
    const style = win.document.getElementById("__airbridgeNativeShellInsets");
    expect(style?.textContent).toContain("--ab-safe-top:0px;");
    expect(style?.textContent).toContain("--ab-safe-bottom:0px;");
    expect(style?.textContent).toContain("--ab-gutter:clamp(12px,4vw,24px)");
    expect(style?.textContent).toContain(".header-actions");
    expect(style?.textContent).toContain("@media(max-width:920px)");
    expect(style?.textContent).toContain("@media(max-width:480px)");
  });

  it("closes a visible layer with Escape when the page has no Back hook", () => {
    const { win } = mount('<div class="modal-backdrop" role="dialog">Sheet</div>');
    const layer = win.document.querySelector(".modal-backdrop") as HTMLElement;
    let escapes = 0;
    win.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        escapes += 1;
        layer.remove();
      }
    });

    win.eval(script);
    expect(win.__airbridgeSystemBack?.()).toBe(true);
    expect(escapes).toBe(1);
    expect(win.document.querySelector(".modal-backdrop")).toBeNull();
    expect(win.__airbridgeSystemBack?.()).toBe(false);
  });

  it("clicks a sheet's close button when page scripts ignore Escape", () => {
    const { win } = mount(
      '<div class="modal-backdrop" role="dialog"><button class="modal-close" type="button">×</button></div>',
    );
    const layer = win.document.querySelector(".modal-backdrop") as HTMLElement;
    const close = win.document.querySelector(".modal-close") as HTMLButtonElement;
    let clicked = 0;
    close.addEventListener("click", () => {
      clicked += 1;
      layer.remove();
    });

    win.eval(script);
    expect(win.__airbridgeSystemBack?.()).toBe(true);
    expect(clicked).toBe(1);
    expect(win.document.querySelector(".modal-backdrop")).toBeNull();
  });

  it("preserves a page-specific Back handler and falls back only when needed", () => {
    const { win } = mount(
      '<div class="modal-backdrop" role="dialog"><button class="modal-close" type="button">×</button></div>',
    );
    let calls = 0;
    win.__airbridgeSystemBack = () => {
      calls += 1;
      return false;
    };
    const layer = win.document.querySelector(".modal-backdrop") as HTMLElement;
    const close = win.document.querySelector(".modal-close") as HTMLButtonElement;
    close.addEventListener("click", () => layer.remove());

    win.eval(script);
    expect(win.__airbridgeSystemBack?.()).toBe(true);
    expect(calls).toBe(1);
    expect(win.document.querySelector(".modal-backdrop")).toBeNull();
  });
});
