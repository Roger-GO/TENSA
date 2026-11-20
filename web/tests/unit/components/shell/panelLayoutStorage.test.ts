/**
 * Tests for `panelLayoutStorage`: what the shell's panel groups read of the
 * sizes they kept is a JSON object or nothing, and neither reading nor
 * writing throws when the browser's storage does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { panelLayoutStorage } from '@/components/shell/panelLayoutStorage';

const KEY = 'react-resizable-panels:tensa:layout-v1:outer';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('panelLayoutStorage', () => {
  it('reads and writes a kept layout', () => {
    panelLayoutStorage.setItem(KEY, '{"app-shell-left-sidebar-panel":25}');
    expect(window.localStorage.getItem(KEY)).toBe('{"app-shell-left-sidebar-panel":25}');
    expect(panelLayoutStorage.getItem(KEY)).toBe('{"app-shell-left-sidebar-panel":25}');
  });

  it('reads nothing where nothing is kept', () => {
    expect(panelLayoutStorage.getItem(KEY)).toBeNull();
  });

  it.each(['not-json{', 'null', '7', '"text"'])('reads %s as nothing kept', (value) => {
    window.localStorage.setItem(KEY, value);
    expect(panelLayoutStorage.getItem(KEY)).toBeNull();
  });

  it('reads nothing, and writes nothing, where the storage cannot be used', () => {
    const kept = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const refused = vi.fn(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: refused, setItem: refused },
    });
    try {
      expect(panelLayoutStorage.getItem(KEY)).toBeNull();
      expect(() => panelLayoutStorage.setItem(KEY, '{}')).not.toThrow();
      expect(refused).toHaveBeenCalledTimes(2);
    } finally {
      if (kept) Object.defineProperty(window, 'localStorage', kept);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });
});
