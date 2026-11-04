import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout engine, so `offsetParent` is always null. Modal uses it to skip
// hidden elements when collecting focusable children; treat everything as visible here.
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() {
    return this.parentElement;
  },
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  document.body.style.overflow = '';
});
