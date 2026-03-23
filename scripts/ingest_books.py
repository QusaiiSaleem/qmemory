#!/usr/bin/env python3
"""
Ingest books from Apple Books into Donna's Qmemory graph.

Processes PDFs (Gemini OCR) + EPUBs (text extraction), then:
  1. Extracts structure (Gemini → YAML frontmatter + Markdown)
  2. Chunks text (~900 tokens, 15% overlap, Arabic-aware)
  3. Generates embeddings (Voyage AI)
  4. Stores into Qmemory SurrealDB (memory + entity + relates)

Usage:
  python scripts/ingest_books.py "/path/to/Apple Books"
  python scripts/ingest_books.py "/path/to/Apple Books" --limit 5
  python scripts/ingest_books.py "/path/to/Apple Books" --skip-ocr
  python scripts/ingest_books.py "/path/to/Apple Books" --dry-run
"""

import asyncio
import argparse
import os
import re
import sys
import time
import random
import string
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

import yaml

# ─── Configuration ───────────────────────────────────────────────────────────

# SurrealDB (Qmemory's local database)
# Uses QMEMORY_ prefix to avoid conflicts with Awqaf's SURREAL_* vars
SURREAL_URL = os.getenv("QMEMORY_URL", "ws://localhost:8000")
SURREAL_NS = os.getenv("QMEMORY_NS", "qmemory")
SURREAL_DB = os.getenv("QMEMORY_DB", "main")
SURREAL_USER = os.getenv("QMEMORY_USER", "root")
SURREAL_PASS = os.getenv("QMEMORY_PASS", "root")

# API Keys (from environment)
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
VOYAGE_API_KEY = os.getenv("VOYAGE_API_KEY", "")

# Processing parameters
GEMINI_BATCH_SIZE = 10        # Pages per OCR batch
PDF_DPI = 300                 # DPI for page rendering
GEMINI_RATE_DELAY = 2         # Seconds between Gemini calls
CHUNK_TARGET_TOKENS = 900     # Target tokens per chunk
CHUNK_OVERLAP_RATIO = 0.15    # 15% overlap between chunks
MIN_TEXT_PER_PAGE = 50        # Chars/page threshold for "has text"
VOYAGE_BATCH_SIZE = 128       # Max items per Voyage batch
VOYAGE_BATCH_TOKENS = 90_000  # Max tokens per Voyage batch

# Memory node defaults
MEMORY_SALIENCE = 0.35        # Low — surfaces only via vector search
MEMORY_CATEGORY = "domain"
MEMORY_SCOPE = "global"
MEMORY_CONFIDENCE = 0.95
MEMORY_SOURCE_TYPE = "agent"
MEMORY_EVIDENCE_TYPE = "observed"

# Intermediate files directory (mutable — updated via --output flag)
DATA_DIR = Path(__file__).parent.parent / "data" / "books"


def _update_data_dir(new_dir: Path):
    """Update the global DATA_DIR (called from CLI parser)."""
    global DATA_DIR
    DATA_DIR = new_dir

# Gemini model fallback chain — ordered by capacity (RPD), not quality.
# Model names verified against Google AI Studio API (models.list).
# NOTE: If you get "spending cap exceeded", increase cap in Google AI Studio Settings.
GEMINI_MODELS = [
    "gemini-2.5-flash",              # 2K RPM, 100K RPD — best quality for batch
    "gemini-2.0-flash",              # 10K RPM, Unlimited RPD — stable fallback
    "gemini-2.5-flash-lite",         # 10K RPM, Unlimited RPD — lightweight
    "gemini-2.0-flash-lite",         # 20K RPM, Unlimited RPD — highest capacity
    "gemini-3.1-flash-lite-preview", # 10K RPM, 350K RPD — newest
    "gemini-3-flash-preview",        # 2K RPM, 100K RPD — newer model
    "gemini-2.5-pro",                # 1K RPM, 50K RPD — last resort (premium)
]

# ─── Prompts ─────────────────────────────────────────────────────────────────

OCR_PROMPT = """You are an expert Arabic OCR transcription system.

Transcribe ALL text from these document pages exactly as written.
- Maintain the original Arabic text direction (RTL)
- Preserve paragraph structure and headings
- Include any diacritics (tashkeel) if present
- Transcribe tables as markdown tables
- Note any unclear/illegible sections with [unclear]

OUTPUT: Plain text transcription only. No commentary."""

STRUCTURE_PROMPT = """You are an expert Arabic document structuring system.

Given this raw text from a book/document, produce a structured version:

1. Start with YAML frontmatter between --- markers containing:
   - title_ar: Arabic title of the book/document
   - title_en: English translation of the title (if determinable)
   - author_ar: Arabic name of the author (if mentioned)
   - author_en: English transliteration of the author name (if determinable)
   - year: Year of writing or publication (integer, if mentioned or estimable)
   - category: One of: fiqh, history, economics, governance, law, education, social, science, philosophy, literature, self-help, general
   - topics: List of 3-7 keywords describing the main topics

2. Then organize the content with proper Markdown headings (## for chapters/sections).
   - Preserve the original text faithfully — do NOT summarize or paraphrase.
   - Clean up obvious OCR artifacts (broken words, stray characters).
   - Use ## for major sections and ### for subsections.

3. If a frontmatter field cannot be determined, omit it (do not guess wildly).

OUTPUT: YAML frontmatter + structured markdown only. No commentary."""


# ─── Helpers ─────────────────────────────────────────────────────────────────

def generate_id(prefix: str) -> str:
    """Generate a Qmemory-compatible ID: {prefix}{timestamp}{random4}"""
    timestamp = int(time.time() * 1000)
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
    return f"{prefix}{timestamp}{suffix}"


def sanitize_filename(name: str) -> str:
    """Convert a filename to a safe string for intermediate files."""
    # Remove extension, normalize unicode, replace spaces
    stem = Path(name).stem
    safe = re.sub(r"[^\w\s\-\u0600-\u06FF]", "", stem)  # Keep Arabic + alphanumeric
    return safe.strip()[:80]  # Truncate to 80 chars


def estimate_tokens(text: str) -> int:
    """Estimate token count (Arabic-aware).

    Arabic text uses ~0.4 tokens per character (more complex script).
    English text uses ~0.25 tokens per character.
    We detect which is dominant and use the right ratio.
    """
    if not text:
        return 0
    # Count Arabic characters
    arabic_chars = sum(1 for c in text if "\u0600" <= c <= "\u06FF" or "\u0750" <= c <= "\u077F")
    total_chars = len(text.strip())
    if total_chars == 0:
        return 0
    arabic_ratio = arabic_chars / total_chars
    # Use Arabic rate if >30% Arabic
    tokens_per_char = 0.4 if arabic_ratio > 0.3 else 0.25
    return int(total_chars * tokens_per_char)


def log(msg: str, level: str = "INFO"):
    """Simple colored logger."""
    colors = {
        "INFO": "\033[36m",     # Cyan
        "OK": "\033[32m",       # Green
        "WARN": "\033[33m",     # Yellow
        "ERROR": "\033[31m",    # Red
        "STEP": "\033[35m",     # Magenta
    }
    reset = "\033[0m"
    color = colors.get(level, "")
    print(f"{color}[{level}]{reset} {msg}")


# ─── Stage 1: Text Extraction ───────────────────────────────────────────────

def extract_text_from_pdf_native(pdf_path: str) -> Optional[str]:
    """Try extracting text from PDF using PyMuPDF (no OCR, fast).

    Returns the text if quality is good enough, otherwise None.
    """
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    texts = []
    for page in doc:
        texts.append(page.get_text())
    doc.close()

    full_text = "\n".join(texts)
    page_count = len(texts)

    # Check quality: average chars per page
    if page_count == 0:
        return None
    avg_chars = len(full_text.strip()) / page_count
    if avg_chars < MIN_TEXT_PER_PAGE:
        log(f"  Native text too sparse ({avg_chars:.0f} chars/page avg) — will use OCR", "WARN")
        return None

    log(f"  Native text extraction OK ({avg_chars:.0f} chars/page avg, {page_count} pages)")
    return full_text


def extract_text_from_pdf_ocr(pdf_path: str, model_idx: int = 0) -> str:
    """Extract text from PDF using Gemini Vision OCR.

    Renders pages to images at 300 DPI, sends batches of 10 to Gemini.
    Falls back through model chain on rate limits.
    """
    import fitz  # PyMuPDF for page rendering
    from PIL import Image
    import google.genai as genai
    import io

    if not GOOGLE_API_KEY:
        raise RuntimeError("GOOGLE_API_KEY not set — needed for Gemini OCR")

    client = genai.Client(
        api_key=GOOGLE_API_KEY,
        http_options={"timeout": 300_000},  # 5 min timeout
    )
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    all_text = []
    current_model_idx = model_idx

    log(f"  OCR: {page_count} pages, batch size {GEMINI_BATCH_SIZE}")

    for batch_start in range(0, page_count, GEMINI_BATCH_SIZE):
        batch_end = min(batch_start + GEMINI_BATCH_SIZE, page_count)
        batch_num = (batch_start // GEMINI_BATCH_SIZE) + 1
        total_batches = (page_count + GEMINI_BATCH_SIZE - 1) // GEMINI_BATCH_SIZE

        log(f"  OCR batch {batch_num}/{total_batches} (pages {batch_start+1}-{batch_end})")

        # Render pages to PIL Images
        images = []
        for page_idx in range(batch_start, batch_end):
            page = doc[page_idx]
            # Render at 300 DPI
            pix = page.get_pixmap(dpi=PDF_DPI)
            img_bytes = pix.tobytes("png")
            img = Image.open(io.BytesIO(img_bytes))
            images.append(img)

        # Build Gemini request: prompt + images
        contents = [OCR_PROMPT] + images

        # Try models in fallback chain (HTTP timeout set on client)
        batch_text = None
        while current_model_idx < len(GEMINI_MODELS):
            model_name = GEMINI_MODELS[current_model_idx]
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=genai.types.GenerateContentConfig(temperature=0),
                )
                batch_text = response.text or ""
                break  # Success
            except Exception as e:
                error_str = str(e)
                if "timeout" in error_str.lower() or "timed out" in error_str.lower():
                    log(f"  OCR TIMEOUT on {model_name} (>5 min), trying next", "WARN")
                    current_model_idx += 1
                elif "429" in error_str or "rate" in error_str.lower() or "spending" in error_str.lower():
                    log(f"  Rate limited on {model_name}, switching to next model", "WARN")
                    current_model_idx += 1
                else:
                    log(f"  OCR error on {model_name}: {error_str[:100]}", "ERROR")
                    # Retry with backoff
                    time.sleep(10)
                    break

        if batch_text is None:
            if current_model_idx >= len(GEMINI_MODELS):
                # All models exhausted — stop OCR entirely for this book
                log(f"  All Gemini models rate-limited. Stopping OCR after batch {batch_num}.", "ERROR")
                log(f"  Skipping remaining {total_batches - batch_num} batches.", "WARN")
                break
            all_text.append(f"[OCR FAILED: batch {batch_num}, pages {batch_start+1}-{batch_end}]")
        else:
            all_text.append(batch_text)
            # Reset to first model on success (rate limit may have cleared)
            current_model_idx = 0

        # Rate limit delay
        time.sleep(GEMINI_RATE_DELAY)

    doc.close()
    return "\n\n".join(all_text)


def extract_text_from_epub(epub_path: str) -> str:
    """Extract text from EPUB using ebooklib + BeautifulSoup.

    EPUBs are ZIP files containing HTML chapters — no OCR needed.
    """
    import ebooklib
    from ebooklib import epub
    from bs4 import BeautifulSoup

    book = epub.read_epub(epub_path, options={"ignore_ncx": True})
    texts = []

    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "lxml")
        # Remove script/style elements
        for tag in soup(["script", "style"]):
            tag.decompose()
        text = soup.get_text(separator="\n")
        # Clean up excessive whitespace
        text = re.sub(r"\n{3,}", "\n\n", text)
        if text.strip():
            texts.append(text.strip())

    full_text = "\n\n".join(texts)
    log(f"  EPUB extracted: {len(texts)} chapters, {len(full_text)} chars")
    return full_text


def extract_text(file_path: str) -> str:
    """Stage 1: Extract raw text from a PDF or EPUB file.

    For PDFs: tries native text extraction first, falls back to Gemini OCR.
    For EPUBs: uses ebooklib (text is already available in HTML).
    """
    ext = Path(file_path).suffix.lower()

    if ext == ".pdf":
        # Try fast native extraction first
        text = extract_text_from_pdf_native(file_path)
        if text and len(text.strip()) > 100:
            return text
        # Fall back to Gemini OCR
        return extract_text_from_pdf_ocr(file_path)

    elif ext == ".epub":
        return extract_text_from_epub(file_path)

    else:
        raise ValueError(f"Unsupported file type: {ext}")


# ─── Stage 2: Structure Extraction ──────────────────────────────────────────

def extract_structure(raw_text: str, filename: str) -> tuple[dict, str]:
    """Stage 2: Send raw text to Gemini for structuring.

    Returns (metadata_dict, structured_markdown).
    Gemini adds YAML frontmatter + organizes content with ## headings.
    """
    import google.genai as genai
    import httpx

    if not GOOGLE_API_KEY:
        raise RuntimeError("GOOGLE_API_KEY not set — needed for structure extraction")

    # 5-minute HTTP timeout to prevent infinite hangs
    client = genai.Client(
        api_key=GOOGLE_API_KEY,
        http_options={"timeout": 300_000},  # 300 seconds in ms
    )

    # For very long texts, take first 500K chars (Gemini's limit)
    text_for_gemini = raw_text[:500_000]
    prompt = f"{STRUCTURE_PROMPT}\n\n--- RAW TEXT ---\n\n{text_for_gemini}"

    # For very large texts, truncate more aggressively to avoid hangs
    if len(text_for_gemini) > 200_000:
        log(f"  Large text ({len(text_for_gemini)} chars) — truncating to 200K for structure", "WARN")
        text_for_gemini = text_for_gemini[:200_000]
        prompt = f"{STRUCTURE_PROMPT}\n\n--- RAW TEXT ---\n\n{text_for_gemini}"

    # Try models in fallback chain (HTTP timeout set on client)
    structured = ""
    for model_name in GEMINI_MODELS:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=genai.types.GenerateContentConfig(temperature=0),
            )
            structured = response.text or ""
            break
        except Exception as e:
            error_str = str(e)
            if "timeout" in error_str.lower() or "timed out" in error_str.lower():
                log(f"  Structure TIMEOUT on {model_name} (>5 min), trying next", "WARN")
                continue
            elif "429" in error_str or "rate" in error_str.lower() or "spending" in error_str.lower():
                log(f"  Structure rate limited on {model_name}, trying next", "WARN")
                continue
            else:
                log(f"  Structure error on {model_name}: {error_str[:100]}", "ERROR")
                time.sleep(5)
                continue

    if not structured:
        log(f"  Structure extraction FAILED for {filename}", "ERROR")
        # Return minimal metadata with raw text as markdown
        return {"title_ar": filename}, raw_text

    # Parse YAML frontmatter
    metadata, markdown = parse_frontmatter(structured)

    # If Gemini didn't extract a title, use filename
    if not metadata.get("title_ar"):
        metadata["title_ar"] = filename

    # Safety: if Gemini returned metadata but no content, use raw text
    if len(markdown.strip()) < 500 and len(raw_text) > 500:
        log("  Gemini returned metadata only — using raw text as content", "WARN")
        markdown = raw_text

    return metadata, markdown


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse YAML frontmatter from structured markdown.

    Handles two formats Gemini may produce:
      1. Standard: --- / yaml / --- at the top
      2. Code block: ```yaml / yaml / ``` anywhere in the text

    Merges both if present. Returns (metadata_dict, remaining_markdown).
    """
    metadata = {}
    markdown = text

    # Try standard --- frontmatter first
    fm_pattern = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
    fm_match = fm_pattern.match(text)
    if fm_match:
        try:
            metadata = yaml.safe_load(fm_match.group(1)) or {}
        except yaml.YAMLError:
            pass
        markdown = text[fm_match.end():]

    # Also check for ```yaml code blocks (Gemini sometimes puts metadata here)
    code_pattern = re.compile(r"```ya?ml\s*\n(.*?)\n```", re.DOTALL)
    for code_match in code_pattern.finditer(text):
        try:
            extra = yaml.safe_load(code_match.group(1)) or {}
            if isinstance(extra, dict):
                # Merge: code block fields fill in gaps (don't overwrite)
                for k, v in extra.items():
                    if k not in metadata or not metadata[k]:
                        metadata[k] = v
        except yaml.YAMLError:
            pass
        # Remove the code block from markdown body
        markdown = markdown.replace(code_match.group(0), "")

    return metadata, markdown


# ─── Stage 3: Chunking ──────────────────────────────────────────────────────

@dataclass
class Section:
    title: str
    heading_level: int
    content: str
    section_index: int


@dataclass
class Chunk:
    content: str
    chunk_index: int
    section_title: str
    section_index: int
    token_count: int


def parse_sections(markdown: str) -> list[Section]:
    """Split markdown into sections by headings.

    ## Chapter Title → section with heading_level 2
    ### Subsection   → section with heading_level 3
    Text before first heading → "مقدمة" (Introduction) section
    """
    heading_re = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
    sections = []
    section_idx = 0

    matches = list(heading_re.finditer(markdown))

    # Text before first heading → Introduction
    if matches and matches[0].start() > 0:
        intro_text = markdown[:matches[0].start()].strip()
        if intro_text:
            sections.append(Section(
                title="مقدمة",
                heading_level=0,
                content=intro_text,
                section_index=section_idx,
            ))
            section_idx += 1

    for i, match in enumerate(matches):
        level = len(match.group(1))
        title = match.group(2).strip()

        # Content runs from after this heading to before the next heading
        content_start = match.end()
        content_end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        content = markdown[content_start:content_end].strip()

        if content:
            sections.append(Section(
                title=title,
                heading_level=level,
                content=content,
                section_index=section_idx,
            ))
            section_idx += 1

    # If no headings at all, treat entire text as one section
    if not sections and markdown.strip():
        sections.append(Section(
            title="النص الكامل",
            heading_level=0,
            content=markdown.strip(),
            section_index=0,
        ))

    return sections


def chunk_section(section: Section, global_chunk_idx: int) -> list[Chunk]:
    """Split a section into overlapping chunks.

    - Target: ~900 tokens per chunk
    - Overlap: 15% (ensures context at boundaries)
    - Arabic-aware: uses 0.4 tokens/char for Arabic text
    - Boundary-aware: splits at sentence ends (. ؟ ! \\n\\n)
    """
    text = section.content
    total_tokens = estimate_tokens(text)

    # If section fits in one chunk, return as-is
    if total_tokens <= CHUNK_TARGET_TOKENS * 1.3:  # 30% tolerance
        return [Chunk(
            content=text,
            chunk_index=global_chunk_idx,
            section_title=section.title,
            section_index=section.section_index,
            token_count=total_tokens,
        )]

    # Calculate char-to-token ratio for this text
    arabic_chars = sum(1 for c in text if "\u0600" <= c <= "\u06FF")
    total_chars = len(text)
    arabic_ratio = arabic_chars / max(total_chars, 1)
    tokens_per_char = 0.4 if arabic_ratio > 0.3 else 0.25

    # Convert target tokens to chars
    target_chars = int(CHUNK_TARGET_TOKENS / tokens_per_char)
    overlap_chars = int(target_chars * CHUNK_OVERLAP_RATIO)
    step_chars = target_chars - overlap_chars

    chunks = []
    start = 0
    idx = global_chunk_idx

    while start < len(text):
        # Proposed end
        proposed_end = min(start + target_chars, len(text))

        # If we're near the end, just take everything remaining
        remaining = len(text) - proposed_end
        remainder_threshold = int(target_chars * 0.3)
        if remaining < remainder_threshold:
            proposed_end = len(text)

        # Search for sentence boundary near proposed_end
        end = find_sentence_boundary(text, proposed_end)

        chunk_text = text[start:end].strip()
        if chunk_text:
            chunks.append(Chunk(
                content=chunk_text,
                chunk_index=idx,
                section_title=section.title,
                section_index=section.section_index,
                token_count=estimate_tokens(chunk_text),
            ))
            idx += 1

        # Advance by step (not by chunk size) to create overlap
        if end >= len(text):
            break
        start = start + step_chars
        if start >= end:
            start = end  # Ensure forward progress

    return chunks


def find_sentence_boundary(text: str, position: int, radius: int = 100) -> int:
    """Find the nearest sentence boundary near `position`.

    Looks for: . ؟ ! \\n\\n within ±radius characters.
    Prefers forward boundaries (don't cut short).
    """
    if position >= len(text):
        return len(text)

    # Sentence-ending characters (Arabic + English)
    boundaries = ".؟!。"

    # Search forward first
    for i in range(position, min(position + radius, len(text))):
        if text[i] in boundaries:
            return i + 1
        if i + 1 < len(text) and text[i] == "\n" and text[i + 1] == "\n":
            return i + 2

    # Search backward
    for i in range(position, max(position - radius, 0), -1):
        if text[i] in boundaries:
            return i + 1
        if i + 1 < len(text) and text[i] == "\n" and text[i + 1] == "\n":
            return i + 2

    # No boundary found — use proposed position
    return position


def chunk_markdown(markdown: str) -> list[Chunk]:
    """Stage 3: Split structured markdown into overlapping chunks.

    1. Parse into sections (by headings)
    2. Split each section into ~900 token chunks
    3. Return flat list of all chunks with metadata
    """
    sections = parse_sections(markdown)
    all_chunks = []
    global_idx = 0

    for section in sections:
        section_chunks = chunk_section(section, global_idx)
        all_chunks.extend(section_chunks)
        global_idx += len(section_chunks)

    return all_chunks


# ─── Stage 4: Embeddings ────────────────────────────────────────────────────

def generate_embeddings_batch(texts: list[str]) -> list[Optional[list[float]]]:
    """Stage 4: Generate Voyage AI embeddings for a list of texts.

    Batches into groups of 128 items / 90K tokens.
    Returns list of embeddings (or None for failures).
    """
    if not VOYAGE_API_KEY:
        log("  No VOYAGE_API_KEY — skipping embeddings", "WARN")
        return [None] * len(texts)

    import voyageai

    client = voyageai.Client(api_key=VOYAGE_API_KEY)
    all_embeddings: list[Optional[list[float]]] = [None] * len(texts)

    # Build batches respecting token limits
    batches: list[list[int]] = []  # Each batch is a list of indices
    current_batch: list[int] = []
    current_tokens = 0

    for i, text in enumerate(texts):
        text_tokens = estimate_tokens(text)
        # Start new batch if limits exceeded
        if (len(current_batch) >= VOYAGE_BATCH_SIZE or
                current_tokens + text_tokens > VOYAGE_BATCH_TOKENS):
            if current_batch:
                batches.append(current_batch)
            current_batch = [i]
            current_tokens = text_tokens
        else:
            current_batch.append(i)
            current_tokens += text_tokens

    if current_batch:
        batches.append(current_batch)

    log(f"  Embedding: {len(texts)} texts in {len(batches)} batches")

    for batch_num, batch_indices in enumerate(batches):
        batch_texts = [texts[i] for i in batch_indices]
        try:
            result = client.embed(
                texts=batch_texts,
                model="voyage-3",
                input_type="document",
            )
            for j, idx in enumerate(batch_indices):
                all_embeddings[idx] = result.embeddings[j]
        except Exception as e:
            log(f"  Embedding batch {batch_num + 1} failed: {e}", "ERROR")
            # Rate limit — wait and retry once
            if "429" in str(e):
                time.sleep(30)
                try:
                    result = client.embed(
                        texts=batch_texts,
                        model="voyage-3",
                        input_type="document",
                    )
                    for j, idx in enumerate(batch_indices):
                        all_embeddings[idx] = result.embeddings[j]
                except Exception as retry_e:
                    log(f"  Retry failed: {retry_e}", "ERROR")

        # Rate limit delay between batches
        if batch_num < len(batches) - 1:
            time.sleep(1)

    embedded_count = sum(1 for e in all_embeddings if e is not None)
    log(f"  Embedded: {embedded_count}/{len(texts)} texts", "OK")
    return all_embeddings


# ─── Stage 5: Store in SurrealDB ────────────────────────────────────────────

async def connect_db():
    """Connect to Qmemory's SurrealDB instance."""
    from surrealdb import AsyncSurreal

    db = AsyncSurreal(SURREAL_URL)
    await db.connect()
    await db.use(SURREAL_NS, SURREAL_DB)
    await db.signin({"username": SURREAL_USER, "password": SURREAL_PASS})
    log(f"  Connected to SurrealDB ({SURREAL_URL} → {SURREAL_NS}/{SURREAL_DB})", "OK")
    return db


async def find_or_create_entity(
    db,
    name: str,
    entity_type: str,
    aliases: Optional[list[str]] = None,
    embedding: Optional[list[float]] = None,
) -> str:
    """Find an existing entity by name, or create a new one.

    Returns the entity ID (e.g., "ent1710864000abc").
    """
    # Search by name (case-insensitive)
    results = await db.query(
        "SELECT id, name FROM entity WHERE name = $name AND type = $type LIMIT 1",
        {"name": name, "type": entity_type},
    )

    # Extract results from SurrealDB response
    rows = _extract_rows(results)
    if rows:
        entity_id = _id_to_str(rows[0]["id"])
        log(f"  Entity exists: {name} ({entity_id})")
        return entity_id

    # Also check aliases
    if aliases:
        for alias in aliases:
            if alias:
                results = await db.query(
                    "SELECT id, name FROM entity WHERE $alias IN aliases AND type = $type LIMIT 1",
                    {"alias": alias, "type": entity_type},
                )
                rows = _extract_rows(results)
                if rows:
                    entity_id = _id_to_str(rows[0]["id"])
                    log(f"  Entity exists (via alias '{alias}'): {name} ({entity_id})")
                    return entity_id

    # Create new entity
    eid = generate_id("ent")
    data = {
        "name": name,
        "type": entity_type,
        "aliases": [a for a in (aliases or []) if a],
    }

    await db.query(
        f"CREATE entity:`{eid}` CONTENT $data",
        {"data": data},
    )

    # Add embedding separately (optional field)
    if embedding:
        await db.query(
            f"UPDATE entity:`{eid}` SET embedding = $emb",
            {"emb": embedding},
        )

    log(f"  Entity created: {name} (entity:{eid})", "OK")
    return eid


async def create_memory(
    db,
    content: str,
    section_title: str,
    book_title: str,
    chunk_index: int,
    embedding: Optional[list[float]] = None,
) -> str:
    """Create a memory node for a book chunk.

    Returns the memory ID.
    """
    mid = generate_id("mem")

    # Prepend section context to help with search relevance
    # Format: "[Book Title > Section] content..."
    contextualized = f"[{book_title} > {section_title}] {content}"

    data = {
        "content": contextualized,
        "category": MEMORY_CATEGORY,
        "salience": MEMORY_SALIENCE,
        "scope": MEMORY_SCOPE,
        "confidence": MEMORY_CONFIDENCE,
        "source_type": MEMORY_SOURCE_TYPE,
        "evidence_type": MEMORY_EVIDENCE_TYPE,
        "is_active": True,
        "linked": False,
        "recall_count": 0,
    }

    await db.query(
        f"CREATE memory:`{mid}` CONTENT $data",
        {"data": data},
    )

    # Add embedding separately (option<array<float>>)
    if embedding:
        await db.query(
            f"UPDATE memory:`{mid}` SET embedding = $emb",
            {"emb": embedding},
        )

    return mid


async def create_relates_edge(
    db,
    from_table: str,
    from_id: str,
    to_table: str,
    to_id: str,
    rel_type: str,
    reason: str = "",
) -> None:
    """Create a deterministic relates edge between two nodes.

    Uses deterministic ID to prevent duplicates on re-runs.
    """
    edge_id = f"{from_id}_{to_id}"

    data = {
        "type": rel_type,
        "reason": reason,
        "confidence": 1.0,
        "created_by": "agent",
    }

    await db.query(
        f"RELATE {from_table}:`{from_id}`->relates:`{edge_id}`->{to_table}:`{to_id}` CONTENT $data",
        {"data": data},
    )


async def check_book_exists(db, book_name: str) -> bool:
    """Check if a book entity already exists (skip duplicates)."""
    results = await db.query(
        'SELECT id FROM entity WHERE name = $name AND type = "book" LIMIT 1',
        {"name": book_name},
    )
    rows = _extract_rows(results)
    return len(rows) > 0


def _extract_rows(results) -> list:
    """Extract rows from SurrealDB query results.

    SurrealDB SDK returns various formats — handle them all.
    """
    if results is None:
        return []
    if isinstance(results, list):
        # Might be a list of result sets
        for item in results:
            if isinstance(item, dict) and "result" in item:
                result = item["result"]
                if isinstance(result, list):
                    return result
            elif isinstance(item, list):
                return item
            elif isinstance(item, dict):
                return [item]
        # If the list itself contains row dicts
        if results and isinstance(results[0], dict) and "id" in results[0]:
            return results
        return results
    return []


def _id_to_str(record_id) -> str:
    """Convert a SurrealDB RecordId to a plain string.

    SurrealDB SDK returns RecordId objects, not strings.
    """
    s = str(record_id)
    # Remove table prefix if present (e.g., "entity:ent123" → "ent123")
    if ":" in s:
        return s.split(":", 1)[1]
    return s


# ─── Main Pipeline ───────────────────────────────────────────────────────────

@dataclass
class BookResult:
    filename: str
    title: str = ""
    author: str = ""
    chunks: int = 0
    success: bool = False
    error: str = ""


async def process_book(file_path: str, dry_run: bool = False, skip_ocr: bool = False) -> BookResult:
    """Process a single book through the full pipeline.

    Stages 1-5 with intermediate file caching for resume support.
    Checks DB for existing book entity to skip duplicates.
    """
    filename = Path(file_path).name
    safe_name = sanitize_filename(filename)
    result = BookResult(filename=filename)

    raw_path = DATA_DIR / f"{safe_name}_raw.txt"
    structured_path = DATA_DIR / f"{safe_name}_structured.md"

    try:
        # ── Dedup: if structured file exists, check if book is already in DB ──
        if not dry_run and structured_path.exists():
            try:
                structured_text = structured_path.read_text(encoding="utf-8")
                meta_check, _ = parse_frontmatter(structured_text)
                title_check = meta_check.get("title_ar", "")
                title_en_check = meta_check.get("title_en", "")
                # Use English title if Arabic looks like filename
                if not title_check or title_check.endswith(".pdf") or title_check.endswith(".epub"):
                    title_check = title_en_check or ""

                if title_check:
                    db = await connect_db()
                    # Check by extracted title
                    if await check_book_exists(db, title_check):
                        log(f"  SKIP — '{title_check}' already in DB", "OK")
                        result.success = True
                        result.title = title_check
                        await db.close()
                        return result
                    # Also check by filename (earlier runs stored filename as title)
                    if await check_book_exists(db, filename):
                        log(f"  SKIP — '{filename}' already in DB", "OK")
                        result.success = True
                        result.title = filename
                        await db.close()
                        return result
                    await db.close()
            except Exception:
                pass  # Dedup check failed — proceed normally
        # ── Stage 1: Text Extraction ──
        if structured_path.exists() and skip_ocr:
            log(f"  Skipping OCR — using existing {structured_path.name}")
            structured_text = structured_path.read_text(encoding="utf-8")
            metadata, markdown = parse_frontmatter(structured_text)
        else:
            if raw_path.exists():
                log(f"  Raw text exists — loading {raw_path.name}")
                raw_text = raw_path.read_text(encoding="utf-8")
            else:
                log("  Stage 1: Extracting text...", "STEP")
                raw_text = extract_text(file_path)
                # Save intermediate
                raw_path.write_text(raw_text, encoding="utf-8")
                log(f"  Saved: {raw_path.name} ({len(raw_text)} chars)", "OK")

            if dry_run:
                result.title = filename
                result.success = True
                return result

            # ── Stage 2: Structure Extraction ──
            if structured_path.exists():
                log(f"  Structured text exists — loading {structured_path.name}")
                structured_text = structured_path.read_text(encoding="utf-8")
                metadata, markdown = parse_frontmatter(structured_text)
            else:
                log("  Stage 2: Extracting structure...", "STEP")
                metadata, markdown = extract_structure(raw_text, filename)
                # Save intermediate (frontmatter + markdown)
                full_structured = "---\n"
                full_structured += yaml.dump(metadata, allow_unicode=True, default_flow_style=False)
                full_structured += "---\n\n"
                full_structured += markdown
                structured_path.write_text(full_structured, encoding="utf-8")
                log(f"  Saved: {structured_path.name}", "OK")

        if dry_run:
            result.title = metadata.get("title_ar", filename)
            result.author = metadata.get("author_ar", "")
            result.success = True
            return result

        # Extract metadata — prefer meaningful names over filenames
        title_ar = metadata.get("title_ar", "")
        title_en = metadata.get("title_en", "")
        # Use title_en as primary if title_ar looks like a filename
        if not title_ar or title_ar.endswith(".pdf") or title_ar.endswith(".epub"):
            title_ar = title_en or filename
        author_ar = metadata.get("author_ar", "")
        author_en = metadata.get("author_en", "")
        if not author_ar:
            author_ar = author_en or "مؤلف غير معروف"
        category = metadata.get("category", "general")
        topics = metadata.get("topics", [])
        year = metadata.get("year")

        result.title = title_ar
        result.author = author_ar

        # ── Stage 3: Chunking ──
        log("  Stage 3: Chunking...", "STEP")
        chunks = chunk_markdown(markdown)
        log(f"  Chunked: {len(chunks)} chunks from {len(parse_sections(markdown))} sections")
        result.chunks = len(chunks)

        if len(chunks) == 0:
            log("  No chunks generated — skipping", "WARN")
            result.success = True
            return result

        # ── Stage 4: Embeddings ──
        log("  Stage 4: Generating embeddings...", "STEP")
        chunk_texts = [c.content for c in chunks]
        # Also embed the book itself (title + first chunk)
        book_embed_text = f"{title_ar} — {author_ar}"
        if topics:
            book_embed_text += " — " + "، ".join(topics if isinstance(topics, list) else [topics])

        all_texts = [book_embed_text] + chunk_texts
        all_embeddings = generate_embeddings_batch(all_texts)
        book_embedding = all_embeddings[0]
        chunk_embeddings = all_embeddings[1:]

        # ── Stage 5: Store in SurrealDB ──
        log("  Stage 5: Storing in SurrealDB...", "STEP")
        db = await connect_db()

        try:
            # Check if book already exists
            if await check_book_exists(db, title_ar):
                log(f"  Book already in DB: {title_ar} — skipping", "WARN")
                result.success = True
                return result

            # Create book entity
            book_eid = await find_or_create_entity(
                db, title_ar, "book",
                aliases=[title_en] if title_en else [],
                embedding=book_embedding,
            )

            # Create author entity
            author_eid = await find_or_create_entity(
                db, author_ar, "person",
                aliases=[author_en] if author_en else [],
            )

            # Create "wrote" edge: author → book
            await create_relates_edge(
                db, "entity", author_eid, "entity", book_eid,
                "wrote", f"{author_ar} authored {title_ar}",
            )

            # Create memory nodes for each chunk + "from_book" edges
            for i, chunk in enumerate(chunks):
                embedding = chunk_embeddings[i] if i < len(chunk_embeddings) else None

                mem_id = await create_memory(
                    db,
                    content=chunk.content,
                    section_title=chunk.section_title,
                    book_title=title_ar,
                    chunk_index=chunk.chunk_index,
                    embedding=embedding,
                )

                # Create "from_book" edge: memory → book entity
                await create_relates_edge(
                    db, "memory", mem_id, "entity", book_eid,
                    "from_book", f"Chunk {i+1} from {title_ar}",
                )

                if (i + 1) % 20 == 0:
                    log(f"  Stored {i+1}/{len(chunks)} chunks...")

            log(f"  Stored: {len(chunks)} chunks + 2 entities + {len(chunks)+1} edges", "OK")
            result.success = True

        finally:
            await db.close()

    except Exception as e:
        result.error = str(e)[:200]
        log(f"  FAILED: {e}", "ERROR")

    return result


async def main():
    parser = argparse.ArgumentParser(
        description="Ingest books into Donna's Qmemory graph"
    )
    parser.add_argument(
        "input_dir",
        help="Directory containing PDF and EPUB files",
    )
    parser.add_argument(
        "--limit", type=int, default=0,
        help="Process only first N books (0 = all)",
    )
    parser.add_argument(
        "--skip-ocr", action="store_true",
        help="Skip OCR, re-ingest from existing .md files",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be processed, extract text only",
    )
    default_output = str(DATA_DIR)
    parser.add_argument(
        "--output", type=str, default=default_output,
        help=f"Directory for intermediate files (default: {default_output})",
    )

    args = parser.parse_args()

    # Update DATA_DIR if custom output specified
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    _update_data_dir(output_dir)

    input_dir = Path(args.input_dir)
    if not input_dir.exists():
        log(f"Directory not found: {input_dir}", "ERROR")
        sys.exit(1)

    # Find all PDF and EPUB files
    files = sorted(
        [f for f in input_dir.iterdir()
         if f.suffix.lower() in (".pdf", ".epub") and not f.name.startswith(".")],
        key=lambda f: f.name,
    )

    if args.limit > 0:
        files = files[:args.limit]

    log(f"Found {len(files)} books in {input_dir}")
    if args.dry_run:
        log("DRY RUN — no database writes", "WARN")

    # Check dependencies
    _check_dependencies()

    # Check API keys
    if not args.dry_run:
        if not GOOGLE_API_KEY:
            log("WARNING: GOOGLE_API_KEY not set — OCR will fail for scanned PDFs", "WARN")
        if not VOYAGE_API_KEY:
            log("WARNING: VOYAGE_API_KEY not set — embeddings will be skipped", "WARN")

    # Process each book
    results: list[BookResult] = []
    start_time = time.time()

    for i, file_path in enumerate(files):
        log(f"\n{'='*60}")
        log(f"[{i+1}/{len(files)}] {file_path.name}", "STEP")
        log(f"{'='*60}")

        result = await process_book(
            str(file_path),
            dry_run=args.dry_run,
            skip_ocr=args.skip_ocr,
        )
        results.append(result)

        # Small delay between books to avoid rate limits
        if not args.dry_run and i < len(files) - 1:
            time.sleep(1)

    # ── Summary ──
    elapsed = time.time() - start_time
    success = [r for r in results if r.success]
    failed = [r for r in results if not r.success]
    total_chunks = sum(r.chunks for r in success)

    log(f"\n{'='*60}")
    log("SUMMARY", "STEP")
    log(f"{'='*60}")
    log(f"Total: {len(results)} books")
    log(f"Success: {len(success)}", "OK")
    if failed:
        log(f"Failed: {len(failed)}", "ERROR")
        for r in failed:
            log(f"  - {r.filename}: {r.error}", "ERROR")
    log(f"Total chunks: {total_chunks}")
    log(f"Time: {elapsed:.0f}s ({elapsed/60:.1f} min)")

    if not args.dry_run and success:
        log(f"\nDonna now has {total_chunks} new domain memories from {len(success)} books!", "OK")
        log("Qmemory's Linker will auto-discover connections in the background.", "OK")


def _check_dependencies():
    """Verify all required Python packages are installed."""
    missing = []
    try:
        import fitz  # noqa: F401
    except ImportError:
        missing.append("PyMuPDF")
    try:
        import google.genai  # noqa: F401
    except ImportError:
        missing.append("google-genai")
    try:
        import voyageai  # noqa: F401
    except ImportError:
        missing.append("voyageai")
    try:
        import ebooklib  # noqa: F401
    except ImportError:
        missing.append("ebooklib")
    try:
        from bs4 import BeautifulSoup  # noqa: F401
    except ImportError:
        missing.append("beautifulsoup4")
    try:
        import surrealdb  # noqa: F401
    except ImportError:
        missing.append("surrealdb")

    if missing:
        log(f"Missing packages: {', '.join(missing)}", "ERROR")
        log(f"Install with: pip install {' '.join(missing)}", "ERROR")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
