/** Split long source text into model-sized chunks without losing structure. */

import type { TextChunk } from "../domain/models.js";

interface Piece {
  text: string;
  separator: string;
}

const PARAGRAPH_SEPARATOR = /(\r?\n[ \t]*(?:\r?\n[ \t]*)+)/;
const SENTENCE_BOUNDARY = /(?<=[。！？!?…])|(?<=\.)(?=\s)/;

export class TextChunker {
  constructor(readonly chunkChars: number = 3000) {
    if (chunkChars < 100) throw new Error("chunkChars must be at least 100");
  }

  split(text: string): TextChunk[] {
    if (!text) return [];
    const pieces = this.pieces(text);
    if (pieces.length === 0) return [];

    const chunks: TextChunk[] = [];
    let buffer: Piece[] = [];
    let size = 0;

    for (const piece of pieces) {
      if (buffer.length > 0 && size + piece.text.length > this.chunkChars) {
        chunks.push(this.flush(buffer));
        buffer = [];
        size = 0;
      }
      buffer.push(piece);
      size += piece.text.length + piece.separator.length;
    }
    if (buffer.length > 0) chunks.push(this.flush(buffer));
    return chunks;
  }

  private pieces(text: string): Piece[] {
    const pieces: Piece[] = [];
    for (const [body, separator] of splitKeep(text, PARAGRAPH_SEPARATOR)) {
      if (!body) continue;
      pieces.push(...this.paragraphPieces(body, separator));
    }
    return pieces;
  }

  private paragraphPieces(body: string, separator: string): Piece[] {
    if (body.length <= this.chunkChars) return [{ text: body, separator }];

    const joiner = body.includes(" ") ? " " : "";
    const sentences = body
      .split(SENTENCE_BOUNDARY)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    if (sentences.length <= 1) {
      return retarget(
        this.hardWrap(body).map((part) => ({ text: part, separator: joiner })),
        separator,
      );
    }

    const pieces: Piece[] = [];
    for (const sentence of sentences) {
      if (sentence.length <= this.chunkChars) {
        pieces.push({ text: sentence, separator: joiner });
        continue;
      }
      for (const part of this.hardWrap(sentence)) pieces.push({ text: part, separator: joiner });
    }
    return retarget(pieces, separator);
  }

  private hardWrap(text: string): string[] {
    if (text.length <= this.chunkChars) return [text];

    const words = text.split(" ");
    if (words.length <= 1) {
      const parts: string[] = [];
      for (let index = 0; index < text.length; index += this.chunkChars) {
        parts.push(text.slice(index, index + this.chunkChars));
      }
      return parts;
    }

    const parts: string[] = [];
    let current = "";
    for (const word of words) {
      if (!current) current = word;
      else if (current.length + 1 + word.length <= this.chunkChars) current = `${current} ${word}`;
      else {
        parts.push(current);
        current = word;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  private flush(buffer: Piece[]): TextChunk {
    const head = buffer
      .slice(0, -1)
      .map((piece) => piece.text + piece.separator)
      .join("");
    const last = buffer[buffer.length - 1] as Piece;
    return { text: head + last.text, separator: last.separator };
  }
}

function retarget(pieces: Piece[], separator: string): Piece[] {
  if (pieces.length === 0) return pieces;
  const head = pieces.slice(0, -1);
  const last = pieces[pieces.length - 1] as Piece;
  return [...head, { text: last.text, separator }];
}

function splitKeep(text: string, pattern: RegExp): Array<[string, string]> {
  const parts = text.split(pattern);
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < parts.length; index += 2) {
    pairs.push([parts[index] ?? "", parts[index + 1] ?? ""]);
  }
  return pairs;
}
