// A logical paragraph keeps its original single-page source blocks and offsets.
export function paragraphAnchor(reader, id) {
  const blocks = reader.doc.blocks, current = blocks.find(b => b.id === id);
  if (!current) return null;
  const single = () => reader.anchorFor(id, 0, current.text.length);
  const group = current.paragraph_group;
  if (!reader.doc.pdf || !group || !Array.isArray(group.blocks) ||
      group.blocks.length < 2 || group.blocks.length > 256 || !group.blocks.includes(id)) return single();
  const first = blocks.findIndex(b => b.id === group.blocks[0]);
  const members = blocks.slice(first, first + group.blocks.length);
  if (first < 0 || members.length !== group.blocks.length || members.some((b, i) =>
    b.id !== group.blocks[i] || b.type !== "paragraph" || b.asset_url || b.inline_objects?.length ||
    b.paragraph_group?.id !== group.id || JSON.stringify(b.paragraph_group.blocks) !== JSON.stringify(group.blocks) ||
    b.source?.book_id !== reader.doc.pdf.book_id || b.source?.source_sha256 !== reader.doc.pdf.source_sha256 ||
    b.source?.revision !== reader.doc.version || !b.source?.conversion_task_id ||
    b.source.conversion_task_id !== members[0].source?.conversion_task_id)) return single();
  const parts = members.map(b => reader.anchorFor(b.id, 0, b.text.length));
  if (parts.some(p => !p || p.version !== reader.doc.version || p.kind !== "text" || !p.quote)) return single();
  return {...parts[0], quote: parts.map(p => p.quote).join("\n\n"), segments: parts};
}
