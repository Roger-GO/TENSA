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
