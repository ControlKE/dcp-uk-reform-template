// Applies the saved light/dark choice before the page paints. With no saved
// choice the admin follows the device setting (prefers-color-scheme).
try {
  const theme = localStorage.getItem('adm-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage blocked: follow the device */ }
