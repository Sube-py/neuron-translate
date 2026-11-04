import { describe, expect, it } from "vitest";

import { TextChunker } from "../src/translate/chunker.js";

const join = (chunks: Array<{ text: string; separator: string }>) =>
  chunks.map((chunk) => chunk.text + chunk.separator).join("");

describe("TextChunker", () => {
  it("keeps short text in a single chunk", () => {
    const chunks = new TextChunker(1000).split("Hello world.");
    expect(chunks).toEqual([{ text: "Hello world.", separator: "" }]);
  });

  it("returns nothing for empty input", () => {
    expect(new TextChunker().split("")).toEqual([]);
  });

  it("keeps paragraphs whole and round-trips", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = new TextChunker(1000).split(text);
    expect(chunks).toHaveLength(1);
    expect(join(chunks)).toBe(text);
  });

  it("splits long text without losing content", () => {
    const paragraph = Array.from({ length: 60 }, (_, index) => `Sentence number ${index}.`).join(" ");
    const text = `${paragraph}\n\n${paragraph}`;
    const chunks = new TextChunker(200).split(text);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= 200)).toBe(true);
    expect(join(chunks).replaceAll("\n", "")).toBe(text.replaceAll("\n", ""));
  });

  it("uses no joiner for CJK sentences", () => {
    const text = "这是一句话。这是第二句话。这是第三句话。".repeat(20);
    const chunks = new TextChunker(120).split(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 120)).toBe(true);
    expect(join(chunks)).toBe(text);
  });

  it("hard-splits a single long word", () => {
    const chunks = new TextChunker(100).split("x".repeat(250));
    expect(chunks.map((chunk) => chunk.text.length)).toEqual([100, 100, 50]);
    expect(join(chunks)).toBe("x".repeat(250));
  });

  it("keeps the paragraph separator on the chunk", () => {
    const text = "A".repeat(90) + "\n\n" + "B".repeat(90);
    const chunks = new TextChunker(100).split(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.separator).toBe("\n\n");
    expect(chunks[1]?.text).toBe("B".repeat(90));
  });
});
