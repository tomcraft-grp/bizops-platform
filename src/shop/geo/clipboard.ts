// Copy a text to the clipboard. The modern call needs a secure page and a user gesture; the old one works inside some in-app browsers. Never throws: false = it did not work
// (the caller then shows the text so it can be selected and copied by hand).
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* try the old way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
