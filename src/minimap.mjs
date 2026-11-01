// Two independent columns: change density and current viewport.
const reset = '\x1b[0m';
const markers = [
  ['\x1b[41;37m', '\x1b[31m'],
  ['\x1b[43;30m', '\x1b[33m'],
  ['\x1b[42;30m', '\x1b[32m'],
];

export function minimapRows(content, offset, height) {
  const total = Math.max(1, content.length);
  return Array.from({ length: height }, (_, row) => {
    const start = Math.floor(row * total / height);
    const end = Math.min(total, Math.max(start + 1, Math.floor((row + 1) * total / height)));
    const color = markers.find(([prefix]) =>
      content.slice(start, end).some(line => line.startsWith(prefix))
    )?.[1] || '\x1b[90m';
    const visible = start < Math.min(total, offset + height) && end > offset;
    return `${color}│${reset}${visible ? '\x1b[36m┃' : '\x1b[90m│'}${reset}`;
  });
}

export function minimapOffset(row, height, length) {
  return Math.max(0, Math.min(Math.max(0, length - height),
    Math.floor((row - 1) * Math.max(1, length) / height)));
}
