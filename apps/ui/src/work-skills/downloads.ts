export function downloadLocalJson(file: { name: string; content: string }) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name.replace(/[/\\:*?"<>|]/g, '_');
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
