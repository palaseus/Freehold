export async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
  await navigator.clipboard.writeText(value);
}
