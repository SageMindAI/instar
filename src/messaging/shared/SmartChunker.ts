/**
 * SmartChunker — Markdown-aware message chunking.
 *
 * WhatsApp messages have a ~4000 char practical limit. Naive chunking
 * can split code blocks, producing broken halves. This chunker respects
 * markdown structure.
 *
 * Rules:
 * 1. Never split inside a ``` code block (find closing ``` and chunk after it)
 * 2. If a code block exceeds the limit by itself, split at newlines within it
 * 3. Prefer splitting at paragraph boundaries (double newline)
 * 4. Fall back to splitting at single newlines
 * 5. Last resort: split at maxLength boundary
 */

export function smartChunk(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const splitPoint = findBestSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitPoint).trimEnd());
    remaining = remaining.slice(splitPoint).trimStart();
  }

  return chunks.filter(c => c.length > 0);
}

function findBestSplitPoint(text: string, maxLength: number): number {
  const searchRegion = text.slice(0, maxLength);

  // Check if we're inside a code block at the maxLength boundary
  const codeBlockBoundary = findCodeBlockBoundary(text, maxLength);
  if (codeBlockBoundary !== null) return codeBlockBoundary;

  // Try paragraph boundary (double newline)
  const paragraphBreak = searchRegion.lastIndexOf('\n\n');
  if (paragraphBreak > maxLength * 0.3) return paragraphBreak + 2;

  // Try single newline
  const lineBreak = searchRegion.lastIndexOf('\n');
  if (lineBreak > maxLength * 0.3) return lineBreak + 1;

  // Try space
  const spaceBreak = searchRegion.lastIndexOf(' ');
  if (spaceBreak > maxLength * 0.3) return spaceBreak + 1;

  // Last resort: hard split
  return maxLength;
}

function findCodeBlockBoundary(text: string, maxLength: number): number | null {
  // Find all code block markers
  const markers: number[] = [];
  let idx = 0;
  while (true) {
    const pos = text.indexOf('```', idx);
    if (pos === -1) break;
    markers.push(pos);
    idx = pos + 3;
  }

  if (markers.length < 2) return null;

  // Check if maxLength falls inside a code block (between an odd-indexed open and its close)
  for (let i = 0; i < markers.length - 1; i += 2) {
    const open = markers[i];
    const close = markers[i + 1] + 3; // Include the closing ```

    if (open < maxLength && close > maxLength) {
      // We're inside a code block. Can we fit it entirely?
      if (close <= text.length && close <= maxLength * 1.5) {
        // Extend to include the whole code block (up to 50% over limit)
        return close;
      }

      // Code block is too large — split within it at newlines
      const searchRegion = text.slice(0, maxLength);
      const lineBreak = searchRegion.lastIndexOf('\n');
      if (lineBreak > open) {
        // Insert a closing ``` before the split and opening ``` after
        return lineBreak + 1;
      }

      // Fall through to normal splitting
      return null;
    }
  }

  // Not inside a code block — try to split after a closed block
  for (let i = markers.length - 1; i >= 1; i -= 2) {
    const close = markers[i] + 3;
    if (close <= maxLength && close > maxLength * 0.3) {
      // Find the next newline after the close
      const nextNewline = text.indexOf('\n', close);
      if (nextNewline !== -1 && nextNewline <= maxLength) {
        return nextNewline + 1;
      }
      return close;
    }
  }

  return null;
}
