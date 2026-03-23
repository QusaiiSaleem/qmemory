# Book Ingestion Pipeline — Spec

> Process 78 books (45 PDFs + 33 EPUBs) from Apple Books into Donna's Qmemory graph.
> No schema changes. Uses existing `memory`, `entity`, and `relates` tables.

---

## Data Mapping

| Book Concept | Qmemory Table | Fields |
|-------------|---------------|--------|
| Book | `entity` (type: "book") | name, type, aliases, embedding |
| Author | `entity` (type: "person") | name, type, aliases |
| Chapter/chunk | `memory` (category: "domain") | content, salience: 0.35, scope: global |
| "Author wrote Book" | `relates` (type: "wrote") | from: author → to: book |
| "Chunk from Book" | `relates` (type: "from_book") | from: memory → to: book entity |

## Pipeline Stages

### Stage 1: Text Extraction
- **PDFs**: Try PyMuPDF text extraction first (free, fast). If text is poor (<50 chars/page avg), fall back to Gemini OCR (10 pages/batch, 300 DPI)
- **EPUBs**: `ebooklib` + BeautifulSoup HTML parsing (text already available)
- **Output**: `data/books/{filename}_raw.txt`

### Stage 2: Structure Extraction (Gemini)
- Send raw text to Gemini → get YAML frontmatter + Markdown with headings
- Extracts: title_ar, title_en, author_ar, author_en, year, category, topics
- **Output**: `data/books/{filename}_structured.md`

### Stage 3: Chunking
- Parse markdown by headings (## for chapters, ### for sections)
- Split into ~900 token chunks with 15% overlap
- Arabic-aware: 0.4 tokens/char for Arabic, 0.25 for English
- Sentence boundary detection (. ؟ ! \n\n)

### Stage 4: Embedding (Voyage AI)
- Model: `voyage-3` (matches Qmemory's default)
- Batch: up to 128 items, 90K tokens/batch
- Rate limit aware (3 RPM free tier)

### Stage 5: Store in Qmemory SurrealDB
1. Create `entity` for book (type: "book")
2. Create `entity` for author (type: "person") — dedup by name
3. Create `relates` edge: author → book (type: "wrote")
4. For each chunk: create `memory` (category: domain, salience: 0.35)
5. Create `relates` edge: memory → book (type: "from_book")

## Memory Node Fields

```
content:       chunk text (Arabic/English)
category:      "domain"
salience:      0.35 (low — surfaces only via vector search)
scope:         "global"
confidence:    0.95 (published text)
source_type:   "agent"
evidence_type: "observed"
is_active:     true
linked:        false (Linker processes later)
embedding:     [1024-dim vector]
```

## Volume Estimates

| Item | Estimate |
|------|----------|
| Book entities | ~78 |
| Author entities | ~50 |
| Memory nodes (chunks) | ~4,000–7,000 |
| Relates edges | ~4,200–7,200 |
| Gemini OCR calls | ~50–200 (PDFs without text only) |
| Gemini structure calls | ~78 |
| Voyage embedding batches | ~30–55 |

## Resume Support

Each stage saves intermediate files. Re-running skips completed stages:
- `{name}_raw.txt` exists → skip Stage 1
- `{name}_structured.md` exists → skip Stage 2
- Book entity already in DB → skip Stages 3–5 for that book

## Dependencies

```
PyMuPDF>=1.24.0       # PDF text extraction + page rendering
google-genai>=1.0.0   # Gemini OCR + structure extraction
voyageai>=0.3.0       # Embeddings
ebooklib>=0.18        # EPUB parsing
beautifulsoup4>=4.12  # HTML text extraction
lxml>=5.0             # HTML parser for bs4
pyyaml>=6.0           # YAML frontmatter
surrealdb>=1.0.0      # SurrealDB Python SDK
Pillow>=10.0          # Image processing
```

## Configuration

```
SURREAL_URL    = ws://localhost:8000
SURREAL_NS     = qmemory
SURREAL_DB     = main
SURREAL_USER   = root
SURREAL_PASS   = root
GOOGLE_API_KEY = (from env)
VOYAGE_API_KEY = (from env)
```

## CLI Usage

```bash
# Process all books
python scripts/ingest_books.py "/Users/qusaiabushanap/Downloads/Apple Books"

# Process first 5 only (test run)
python scripts/ingest_books.py "/Users/qusaiabushanap/Downloads/Apple Books" --limit 5

# Skip OCR, re-ingest from existing .md files
python scripts/ingest_books.py "/Users/qusaiabushanap/Downloads/Apple Books" --skip-ocr

# Dry run (show what would be processed, no API calls)
python scripts/ingest_books.py "/Users/qusaiabushanap/Downloads/Apple Books" --dry-run
```
