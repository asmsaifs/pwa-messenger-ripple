// Keep in sync with src/client/lib/theme.tsx's resolution logic — this only
// runs once, before first paint, to avoid a flash of the wrong theme.
(function () {
  try {
    var pref = localStorage.getItem('ripple-theme');
    var dark =
      pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    // localStorage/matchMedia unavailable — leave the default (light) theme.
  }
})();
