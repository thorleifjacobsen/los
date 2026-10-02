// Apply the saved theme before the page paints (its own file, so the Content-Security-Policy needs no inline scripts).
try { const t = localStorage.getItem("los.theme"); if (t && t !== "auto") document.documentElement.dataset.theme = t; } catch {}
