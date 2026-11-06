export function isDemoMode(): boolean {
  if (import.meta.env.VITE_DEMO === '1') return true;
  return new URLSearchParams(window.location.search).has('demo');
}
