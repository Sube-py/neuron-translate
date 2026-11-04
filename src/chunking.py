"""Split long source text into model-sized chunks without losing structure."""

from __future__ import annotations

import re
from dataclasses import dataclass

from models import TextChunk

_PARAGRAPH_SEPARATOR = re.compile(r"(\r?\n[ \t]*(?:\r?\n[ \t]*)+)")
_SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？!?…])|(?<=\.)(?=\s)")


@dataclass(frozen=True, slots=True)
class _Piece:
    text: str
    separator: str = ""


class TextChunker:
    """Greedy chunker that keeps paragraphs and sentence boundaries intact."""

    def __init__(self, chunk_chars: int = 3000) -> None:
        if chunk_chars < 100:
            raise ValueError("chunk_chars must be at least 100")
        self._chunk_chars = chunk_chars

    @property
    def chunk_chars(self) -> int:
        return self._chunk_chars

    def split(self, text: str) -> list[TextChunk]:
        if not text:
            return []

        pieces = self._pieces(text)
        if not pieces:
            return []

        chunks: list[TextChunk] = []
        buffer: list[_Piece] = []
        size = 0

        for piece in pieces:
            if buffer and size + len(piece.text) > self._chunk_chars:
                chunks.append(self._flush(buffer))
                buffer, size = [], 0
            buffer.append(piece)
            size += len(piece.text) + len(piece.separator)

        if buffer:
            chunks.append(self._flush(buffer))
        return chunks

    def _pieces(self, text: str) -> list[_Piece]:
        pieces: list[_Piece] = []
        for body, separator in self._split_keep(text, _PARAGRAPH_SEPARATOR):
            if not body:
                continue
            pieces.extend(self._paragraph_pieces(body, separator))
        return pieces

    def _paragraph_pieces(self, body: str, separator: str) -> list[_Piece]:
        if len(body) <= self._chunk_chars:
            return [_Piece(body, separator)]

        joiner = " " if " " in body else ""
        sentences = [s.strip() for s in _SENTENCE_BOUNDARY.split(body) if s.strip()]
        if len(sentences) <= 1:
            wrapped = [_Piece(part, joiner) for part in self._hard_wrap(body)]
            return self._retarget(wrapped, separator)

        pieces: list[_Piece] = []
        for sentence in sentences:
            if len(sentence) <= self._chunk_chars:
                pieces.append(_Piece(sentence, joiner))
                continue
            pieces.extend(_Piece(part, joiner) for part in self._hard_wrap(sentence))
        return self._retarget(pieces, separator)

    def _hard_wrap(self, text: str) -> list[str]:
        if len(text) <= self._chunk_chars:
            return [text]

        words = text.split(" ")
        if len(words) <= 1:
            return [
                text[index : index + self._chunk_chars]
                for index in range(0, len(text), self._chunk_chars)
            ]

        parts: list[str] = []
        current = ""
        for word in words:
            if not current:
                current = word
            elif len(current) + 1 + len(word) <= self._chunk_chars:
                current = f"{current} {word}"
            else:
                parts.append(current)
                current = word
        if current:
            parts.append(current)
        return parts

    @staticmethod
    def _retarget(pieces: list[_Piece], separator: str) -> list[_Piece]:
        """Move the paragraph separator onto the last piece."""
        if not pieces:
            return pieces
        head = pieces[:-1]
        last = pieces[-1]
        return [*head, _Piece(last.text, separator)]

    @staticmethod
    def _flush(buffer: list[_Piece]) -> TextChunk:
        body = "".join(piece.text + piece.separator for piece in buffer[:-1])
        last = buffer[-1]
        return TextChunk(text=body + last.text, separator=last.separator)

    @staticmethod
    def _split_keep(text: str, pattern: re.Pattern[str]) -> list[tuple[str, str]]:
        parts = pattern.split(text)
        pairs: list[tuple[str, str]] = []
        for index in range(0, len(parts), 2):
            body = parts[index]
            separator = parts[index + 1] if index + 1 < len(parts) else ""
            pairs.append((body, separator))
        return pairs
