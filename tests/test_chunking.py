from __future__ import annotations

from chunking import TextChunker


def joined(chunks) -> str:
    return "".join(chunk.text + chunk.separator for chunk in chunks)


def test_short_text_is_a_single_chunk() -> None:
    chunker = TextChunker(chunk_chars=1000)
    chunks = chunker.split("Hello world.")
    assert len(chunks) == 1
    assert chunks[0].text == "Hello world."
    assert chunks[0].separator == ""


def test_empty_text_produces_no_chunks() -> None:
    assert TextChunker().split("") == []


def test_paragraphs_are_kept_whole_and_round_trip() -> None:
    text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
    chunks = TextChunker(chunk_chars=1000).split(text)

    assert len(chunks) == 1
    assert joined(chunks) == text


def test_long_text_is_split_but_lossless() -> None:
    paragraph = " ".join(f"Sentence number {index}." for index in range(60))
    text = f"{paragraph}\n\n{paragraph}"
    chunker = TextChunker(chunk_chars=200)
    chunks = chunker.split(text)

    assert len(chunks) > 2
    assert all(len(chunk.text) <= 200 for chunk in chunks)
    assert "".join(chunk.text + chunk.separator for chunk in chunks).replace("\n", "") == (
        text.replace("\n", "")
    )


def test_cjk_sentences_use_empty_joiner() -> None:
    text = "这是一句话。这是第二句话。这是第三句话。" * 40
    chunks = TextChunker(chunk_chars=120).split(text)

    assert len(chunks) > 1
    assert all(len(chunk.text) <= 120 for chunk in chunks)
    assert joined(chunks) == text


def test_single_word_longer_than_limit_is_hard_split() -> None:
    chunks = TextChunker(chunk_chars=100).split("x" * 250)

    assert [len(chunk.text) for chunk in chunks] == [100, 100, 50]
    assert joined(chunks) == "x" * 250


def test_separator_is_preserved_between_paragraph_chunks() -> None:
    text = ("A" * 90) + "\n\n" + ("B" * 90)
    chunks = TextChunker(chunk_chars=100).split(text)

    assert len(chunks) == 2
    assert chunks[0].separator == "\n\n"
    assert chunks[1].text == "B" * 90
