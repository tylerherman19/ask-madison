# Ask Madison

Ask Madison watches public City of Madison records and translates them into plain English. It is an independent project and is not affiliated with the City of Madison.

## What the first version watches

- Current and past development proposals from Madison Planning
- Legistar matter status, history, and public attachment metadata
- City parcel data for map coordinates and parcel context

The generated snapshot lives in `data/asks.json`. Every item preserves its public source URL, raw description, retrieval time, snapshot hash, and transformation version.

## Local preview

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Refresh data

```bash
python -m pip install -r requirements.txt
python scripts/ingest.py
```

GitHub Actions refreshes the public-data snapshot every four hours. When a source record changes, the ingestion script adds a timeline event instead of creating a duplicate project.

## Privacy and provenance

The interface describes the requested change and the place, not ordinary residents. It does not publish contact details or infer public sentiment. Generated wording is rule-based, and the original City record is always linked.
