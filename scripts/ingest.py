#!/usr/bin/env python3
"""Build Ask Madison's static civic-data snapshot from public City sources."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from lxml import html

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "asks.json"
PLANNING_CURRENT = "https://www.cityofmadison.com/dpced/planning/development/current-development-proposals/"
PLANNING_PAST = "https://www.cityofmadison.com/dpced/planning/development/past-development-proposals/"
LEGISTAR_API = "https://webapi.legistar.com/v1/madison"
PARCEL_API = "https://maps.cityofmadison.com/arcgis/rest/services/Public/Property_Lookup/MapServer/9/query"
TRANSFORMATION_VERSION = "rules-1.0"
ARCHIVE_YEARS = range(2015, datetime.now().year + 1)
USER_AGENT = "AskMadison/1.0 (independent civic data project; public sources only)"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch(url: str, *, retries: int = 2) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == retries:
                raise
            print(f"retrying {url}: {exc}", file=sys.stderr)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("unreachable")


def fetch_json(url: str):
    return json.loads(fetch(url).decode("utf-8"))


def clean(value: str | None) -> str:
    if not value:
        return ""
    value = re.sub(r"\s+", " ", value).strip()
    value = re.sub(r"\s*-{4,}\s*STATUS:.*$", "", value, flags=re.I)
    return value.strip(" -")


def iso_date(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return datetime.strptime(value.rstrip("Z"), fmt).date().isoformat()
        except ValueError:
            continue
    return value[:10] if re.match(r"\d{4}-\d{2}-\d{2}", value) else None


def slug_id(source_url: str) -> str:
    query = urllib.parse.parse_qs(urllib.parse.urlparse(source_url).query)
    record = query.get("record", [""])[0]
    if record:
        return record.lower()
    return "madison-" + hashlib.sha1(source_url.encode()).hexdigest()[:12]


def dl_to_dict(cell) -> dict[str, str]:
    result: dict[str, str] = {}
    for dl in cell.xpath(".//dl"):
        terms = dl.xpath("./dt")
        for dt in terms:
            key = clean(dt.text_content()).rstrip(":")
            dd = dt.getnext()
            if dd is not None and dd.tag == "dd":
                result[key] = clean(dd.text_content())
    return result


def parse_planning_page(url: str, is_current: bool) -> list[dict]:
    document = html.fromstring(fetch(url))
    rows = document.xpath("//table[contains(@class,'development-proposals')]/tbody/tr")
    asks = []
    for row in rows:
        cells = row.xpath("./th|./td")
        if len(cells) < 4:
            continue
        link = cells[0].xpath(".//address/a")
        if not link:
            continue
        address = clean(link[0].text_content())
        href = urllib.parse.urljoin(url, link[0].get("href"))
        submitted = iso_date(clean(cells[1].text_content()))
        description_nodes = cells[2].xpath("./p[1]")
        raw_description = clean(description_nodes[0].text_content() if description_nodes else "")
        details = dl_to_dict(cells[2])
        meetings = dl_to_dict(cells[3])
        legistar_links = []
        for anchor in cells[2].xpath(".//a[contains(@href,'legistar.com')]"):
            file_number = clean(anchor.text_content())
            if file_number and file_number.upper() != "TBD":
                legistar_links.append({"file": file_number, "url": anchor.get("href")})
        asks.append({
            "id": slug_id(href),
            "source_type": "planning_current" if is_current else "planning_archive",
            "source_id": slug_id(href),
            "source_url": href,
            "address": address,
            "submitted_at": submitted,
            "raw_title": address,
            "raw_description": raw_description,
            "application_type": details.get("Request/Application Type") or "City review",
            "status": details.get("Status", "Under review"),
            "legistar_links": legistar_links,
            "legistar_file_number": legistar_links[0]["file"] if legistar_links else None,
            "meetings": meetings,
            "is_current": is_current,
            "raw_source_text": clean(row.text_content()),
        })
    return asks


def category_for(description: str, application: str) -> str:
    text = f"{description} {application}".lower()
    if re.search(r"rezone|zoning|property lines?|certified survey map|\bcsm\b", text):
        return "change"
    if re.search(r"street|traffic|sidewalk|crossing|signal|bike|infrastructure", text):
        return "fix"
    if re.search(r"outdoor (eating|seating)|amplified|event|restaurant|bar|tavern|home occupation|parking facility", text):
        return "use"
    if re.search(r"construct|building|dwelling|apartments?|homes?|school|addition|subdivision", text):
        return "build"
    return "change"


def count_units(text: str) -> int | None:
    revised = re.search(r"(?:revised|reduced|changed)\s+(?:from\s+[\d,]+\s+)?to\s+([\d,]+)\s+(?:dwelling|apartment|residential)?\s*units?", text, flags=re.I)
    if revised:
        return int(revised.group(1).replace(",", ""))
    matches = re.findall(r"(?<![\d,])(\d{1,4})(?:-unit|\s+(?:dwelling|apartment|residential)\s+units?|\s+units?)", text, flags=re.I)
    return sum(int(value) for value in matches) if matches else None


def plain_language(description: str, application: str, address: str) -> tuple[str, str, int]:
    original = clean(description).rstrip(".")
    lower = original.lower()
    units = count_units(original)
    stories_match = re.search(r"(?:construct|building|new)?\s*(?:an?\s+)?(?:up to\s+)?(\w+|\d+)[- ]story", lower)
    lots_match = re.search(r"(?:creating?|re-divide|divide|split).*?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:residential\s+)?lots?", lower)

    if "amplified sound" in lower:
        headline = "Someone wants amplified music outside here."
    elif "outdoor eating area" in lower or "outdoor seating" in lower:
        headline = "Someone wants to add outdoor seating here."
    elif "new public school" in lower and "replace" in lower:
        headline = "Someone wants to replace a public school here."
    elif units and re.search(r"construct|development|building|dwelling", lower):
        storefront = bool(re.search(r"commercial|retail|mixed-use", lower))
        story = stories_match.group(1) if stories_match else None
        story_text = f"a {story}-story building with " if story else ""
        headline = f"Someone wants to build {story_text}{units} homes"
        if storefront:
            headline += " and commercial space"
        headline += " here."
    elif "demol" in lower and re.search(r"construct|build", lower):
        headline = "Someone wants to tear down buildings and build something new here."
    elif "demol" in lower:
        headline = "Someone wants to demolish a building here."
    elif lots_match or re.search(r"create .* lots?|combine .* lots?|certified survey map", lower):
        number = lots_match.group(1) if lots_match else None
        headline = f"Someone wants to split this property into {number} lots." if number else "Someone wants to change the property lines here."
    elif "rezone" in lower or "zoning" in lower:
        headline = "Someone wants to change the zoning here."
    elif lower.startswith("convert") and re.search(r"two-family dwelling|two-unit", lower):
        headline = "Someone wants to turn a commercial building into two homes here."
    elif lower.startswith("convert"):
        object_text = re.sub(r"^convert\s+", "", original, flags=re.I)
        headline = f"Someone wants to convert {object_text[0].lower() + object_text[1:]}."
    elif re.search(r"construct|addition|building", lower):
        headline = "Someone wants to build or expand something here."
    elif lower.startswith("revised "):
        headline = "Someone wants to revise the property plan here."
    elif lower.startswith(("allow ", "approve ", "amend ", "revise ", "relocate ", "expand ")):
        verb_phrase = original[0].lower() + original[1:]
        headline = f"Someone wants Madison to {verb_phrase}."
    else:
        headline = f"Someone wants to {original[0].lower() + original[1:]} here." if original else "Someone is asking Madison to change something here."

    headline = re.sub(r"\s+", " ", headline)
    if len(headline) > 135:
        headline = headline[:132].rsplit(" ", 1)[0] + "…"
    application_plain = application.lower().replace("certified survey map", "property-line review")
    summary = f"The applicant is asking the City to approve {application_plain}. The public record describes the proposal as: {original}."
    scale_score = units or 0
    if "school" in lower:
        scale_score += 90
    if "mixed-use" in lower:
        scale_score += 30
    return headline, summary, scale_score


def centroid(geometry: dict) -> tuple[float, float] | tuple[None, None]:
    if not geometry:
        return None, None
    coordinates = geometry.get("coordinates", [])
    if geometry.get("type") == "Polygon" and coordinates:
        points = coordinates[0]
    elif geometry.get("type") == "MultiPolygon" and coordinates and coordinates[0]:
        points = coordinates[0][0]
    else:
        return None, None
    if not points:
        return None, None
    return sum(point[1] for point in points) / len(points), sum(point[0] for point in points) / len(points)


def parcel_for(address: str) -> dict:
    safe_address = address.upper().replace("'", "''")
    params = urllib.parse.urlencode({
        "where": f"upper(Address) = '{safe_address}'",
        "outFields": "Parcel,Address,PropertyUse,AreaName",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    })
    data = fetch_json(f"{PARCEL_API}?{params}")
    features = data.get("features", [])
    if not features:
        return {}
    feature = features[0]
    latitude, longitude = centroid(feature.get("geometry"))
    props = feature.get("properties", {})
    return {
        "latitude": latitude,
        "longitude": longitude,
        "parcel_id": props.get("Parcel"),
        "property_use": props.get("PropertyUse"),
        "neighborhood": props.get("AreaName"),
    }


def legistar_for(file_number: str, source_url: str) -> dict:
    query = urllib.parse.urlencode({"$filter": f"MatterFile eq '{file_number}'"})
    matters = fetch_json(f"{LEGISTAR_API}/Matters?{query}")
    if not matters:
        return {}
    matter = matters[0]
    matter_id = matter["MatterId"]
    histories = fetch_json(f"{LEGISTAR_API}/Matters/{matter_id}/Histories")
    attachments = fetch_json(f"{LEGISTAR_API}/Matters/{matter_id}/Attachments")
    events = []
    for history in histories:
        action_date = iso_date(history.get("MatterHistoryActionDate"))
        if not action_date:
            continue
        events.append({
            "event_type": (history.get("MatterHistoryActionName") or "action").lower().replace(" ", "_"),
            "event_date": action_date,
            "title": history.get("MatterHistoryActionName") or "City action",
            "description": clean(history.get("MatterHistoryActionText")),
            "source_url": source_url,
            "source_id": str(history.get("MatterHistoryId") or ""),
        })
    public_attachments = []
    for item in attachments:
        if item.get("MatterAttachmentShowOnInternetPage") is False:
            continue
        public_attachments.append({
            "title": clean(item.get("MatterAttachmentName")) or "Attachment",
            "url": source_url,
            "type": "public document",
            "source": "Legistar",
            "source_id": str(item.get("MatterAttachmentId") or ""),
        })
    return {
        "legistar_id": matter_id,
        "legistar_file_number": matter.get("MatterFile") or file_number,
        "status": matter.get("MatterStatusName") or None,
        "responsible_body": matter.get("MatterBodyName") or None,
        "last_source_update": matter.get("MatterLastModifiedUtc") or None,
        "matter_title": clean(matter.get("MatterTitle")),
        "events": events,
        "attachments": public_attachments,
    }


def planning_events(ask: dict) -> list[dict]:
    events = []
    if ask.get("submitted_at"):
        events.append({
            "event_type": "submitted",
            "event_date": ask["submitted_at"],
            "title": "Application submitted",
            "description": ask.get("application_type", "City review"),
            "source_url": ask["source_url"],
            "source_id": f"{ask['id']}-submitted",
        })
    for body, date in ask.get("meetings", {}).items():
        event_date = iso_date(date)
        if event_date:
            events.append({
                "event_type": "public_hearing",
                "event_date": event_date,
                "title": body,
                "description": "Listed meeting or review date",
                "source_url": ask["source_url"],
                "source_id": f"{ask['id']}-{body}-{event_date}",
            })
    return events


def dedupe_events(events: list[dict]) -> list[dict]:
    seen = set()
    result = []
    for event in events:
        key = (event.get("event_date"), event.get("title"), event.get("description"))
        if key in seen:
            continue
        seen.add(key)
        result.append(event)
    return result


def read_previous() -> dict[str, dict]:
    if not OUT.exists():
        return {}
    try:
        data = json.loads(OUT.read_text())
        return {ask["id"]: ask for ask in data.get("asks", [])}
    except (json.JSONDecodeError, KeyError):
        return {}


def merge_record(ask: dict, previous: dict | None, checked_at: str) -> dict:
    headline, summary, scale_score = plain_language(ask["raw_description"], ask["application_type"], ask["address"])
    ask["plain_language_headline"] = headline
    ask["plain_language_summary"] = summary
    ask["category"] = category_for(ask["raw_description"], ask["application_type"])
    ask["scale_score"] = scale_score
    ask["transformation_version"] = TRANSFORMATION_VERSION
    ask["last_checked_at"] = checked_at
    raw_snapshot = {
        "description": ask["raw_description"],
        "status": ask["status"],
        "meetings": ask.get("meetings", {}),
        "attachments": [a.get("source_id") for a in ask.get("attachments", [])],
    }
    ask["source_snapshot_hash"] = hashlib.sha256(json.dumps(raw_snapshot, sort_keys=True).encode()).hexdigest()
    ask["created_at"] = previous.get("created_at") if previous else checked_at
    ask["updated_at"] = previous.get("updated_at") if previous and previous.get("source_snapshot_hash") == ask["source_snapshot_hash"] else checked_at
    ask["change_type"] = None
    events = planning_events(ask) + ask.get("events", [])
    if previous and previous.get("source_snapshot_hash") != ask["source_snapshot_hash"]:
        changes = []
        if previous.get("status") != ask.get("status"):
            changes.append(f"Status changed from {previous.get('status')} to {ask.get('status')}")
        if previous.get("raw_description") != ask.get("raw_description"):
            changes.append("The proposal description changed")
        if len(previous.get("attachments", [])) != len(ask.get("attachments", [])):
            changes.append("The document list changed")
        if changes:
            ask["change_type"] = "changed"
            events.append({
                "event_type": "changed",
                "event_date": checked_at[:10],
                "title": "The public record changed",
                "description": ". ".join(changes) + ".",
                "source_url": ask["source_url"],
                "source_id": f"{ask['id']}-change-{checked_at[:10]}",
            })
    if previous:
        events += [event for event in previous.get("events", []) if event.get("event_type") == "changed"]
    ask["events"] = dedupe_events(events)

    today = datetime.now(timezone.utc).date().isoformat()
    upcoming = []
    for body, date in ask.get("meetings", {}).items():
        event_date = iso_date(date)
        if event_date and event_date >= today:
            upcoming.append((event_date, body))
    if upcoming:
        ask["next_event_at"], ask["next_event_name"] = sorted(upcoming)[0]
    else:
        ask["next_event_at"] = None
        ask["next_event_name"] = None
    ask.pop("meetings", None)
    ask.pop("legistar_links", None)
    return ask


def enrich_current(ask: dict, prior: dict | None) -> dict:
    """Add parcel and Legistar context without making either source mandatory."""
    if prior and prior.get("latitude") and prior.get("parcel_id"):
        ask.update({key: prior.get(key) for key in ("latitude", "longitude", "parcel_id", "property_use", "neighborhood")})
    else:
        try:
            ask.update(parcel_for(ask["address"]))
        except Exception as exc:
            print(f"parcel match skipped for {ask['address']}: {exc}", file=sys.stderr)
    if ask.get("legistar_file_number"):
        legistar_url = ask.get("legistar_links", [{}])[0].get("url") or ask["source_url"]
        try:
            enrichment = legistar_for(ask["legistar_file_number"], legistar_url)
            ask.update({key: value for key, value in enrichment.items() if value is not None})
        except Exception as exc:
            print(f"legistar skipped for {ask['legistar_file_number']}: {exc}", file=sys.stderr)
    return ask


def main() -> None:
    checked_at = now_iso()
    previous = read_previous()
    all_asks: dict[str, dict] = {}

    print("reading current development proposals")
    current = parse_planning_page(PLANNING_CURRENT, True)
    for ask in current:
        all_asks[ask["id"]] = ask

    for year in ARCHIVE_YEARS:
        print(f"reading archive {year}")
        url = f"{PLANNING_PAST}?{urllib.parse.urlencode({'year': year})}"
        try:
            archived = parse_planning_page(url, False)
        except Exception as exc:
            print(f"archive {year} skipped: {exc}", file=sys.stderr)
            continue
        for ask in archived:
            all_asks.setdefault(ask["id"], ask)

    print(f"found {len(all_asks)} unique planning records")
    current_ids = [ask_id for ask_id, ask in all_asks.items() if ask["is_current"]]
    print(f"enriching {len(current_ids)} current records")
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(enrich_current, all_asks[ask_id], previous.get(ask_id)): ask_id for ask_id in current_ids}
        for future in as_completed(futures):
            ask_id = futures[future]
            try:
                all_asks[ask_id] = future.result()
            except Exception as exc:
                print(f"enrichment skipped for {ask_id}: {exc}", file=sys.stderr)

    for index, ask in enumerate(list(all_asks.values())):
        prior = previous.get(ask["id"])
        if not ask["is_current"] and prior:
            for key in ("latitude", "longitude", "parcel_id", "property_use", "neighborhood", "attachments", "responsible_body", "last_source_update", "legistar_id"):
                if prior.get(key) and not ask.get(key):
                    ask[key] = prior[key]
        all_asks[ask["id"]] = merge_record(ask, prior, checked_at)
        if index and index % 100 == 0:
            print(f"normalized {index}/{len(all_asks)}")

    asks = sorted(all_asks.values(), key=lambda item: (item.get("submitted_at") or "", item["id"]), reverse=True)
    current_asks = [ask for ask in asks if ask["is_current"]]
    archive_asks = [ask for ask in asks if not ask["is_current"]]
    archive_files = []
    for year in sorted({(ask.get("submitted_at") or "unknown")[:4] for ask in archive_asks}, reverse=True):
        filename = f"archive-{year}.json"
        archive_files.append(filename)
        records = [ask for ask in archive_asks if (ask.get("submitted_at") or "unknown")[:4] == year]
        (OUT.parent / filename).write_text(json.dumps({"year": year, "asks": records}, ensure_ascii=False, separators=(",", ":")) + "\n")
    payload = {
        "meta": {
            "generated_at": checked_at,
            "archive_start_year": min(ARCHIVE_YEARS),
            "record_count": len(asks),
            "current_count": len(current_asks),
            "archive_files": archive_files,
            "sources": [PLANNING_CURRENT, PLANNING_PAST, LEGISTAR_API, PARCEL_API],
            "transformation_version": TRANSFORMATION_VERSION,
        },
        "asks": current_asks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"wrote {len(asks)} records to {OUT}")


if __name__ == "__main__":
    main()
