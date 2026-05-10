import '@testing-library/jest-dom/vitest';

// jsdom does not implement ResizeObserver; Radix primitives that observe
// element size (Slider, Tooltip popper, Select content sizing) need a stub.
// A no-op stub is sufficient — the wrapper code only cares that the API is
// callable; visual layout in jsdom is not exercised.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // Cast through unknown to satisfy strict typing without assuming a global
  // shape; the stub matches the runtime contract Radix uses.
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}

// jsdom + vitest's bundled jsdom build ships a `window.localStorage`
// object whose methods are stubs that throw at runtime (the
// `--localstorage-file` warning at vitest startup). Modules that bind
// `zustand/middleware/persist` capture the storage handle once at
// `create()` time, so installing a shim later in `beforeEach` is too
// late — the persist middleware already grabbed the broken object.
// Shim here at setup time so every store-import sees a working backend.
if (typeof window !== 'undefined') {
  const installInMemoryStorage = (key: 'localStorage' | 'sessionStorage') => {
    const store = new Map<string, string>();
    const shim: Storage = {
      get length() {
        return store.size;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      getItem(name: string) {
        return store.has(name) ? (store.get(name) ?? null) : null;
      },
      setItem(name: string, value: string) {
        store.set(name, String(value));
      },
      removeItem(name: string) {
        store.delete(name);
      },
      clear() {
        store.clear();
      },
    };
    Object.defineProperty(window, key, { configurable: true, value: shim });
  };
  // Detect the broken jsdom stub by checking for a callable setItem.
  if (typeof window.localStorage?.setItem !== 'function') {
    installInMemoryStorage('localStorage');
  }
  if (typeof window.sessionStorage?.setItem !== 'function') {
    installInMemoryStorage('sessionStorage');
  }
}

// jsdom does not implement window.matchMedia. uPlot calls it at module
// load to detect device-pixel-ratio changes; merely importing it under
// jsdom would throw without this stub. The plot tests vi.mock uPlot
// outright; this polyfill exists so non-plot tests that transitively
// import it (e.g., the App smoke test) don't crash on module load.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom also lacks DOMRect / pointer-capture helpers some Radix components
// reach for. The polyfills below are scoped to what the Slider + Select
// content positioning code actually invokes.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
