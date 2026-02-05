export const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fallback for environments where Clipboard API is unavailable.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
};
