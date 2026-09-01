export function compactTextPreservingEnds(value: string, maxLength: number) {
  const text = value.trim();
  if (text.length <= maxLength) return text;

  const marker = "\n\n[邮件中段因长度限制未完整传入，以下继续保留邮件末尾内容]\n\n";
  const available = Math.max(maxLength - marker.length, 2);
  const headLength = Math.ceil(available * 0.72);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength).trimEnd()}${marker}${text.slice(-tailLength).trimStart()}`;
}
