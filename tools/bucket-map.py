#!/usr/bin/env python3
"""
OKN Media Archive — Bucket Map Generator
==========================================
Generates a directory-tree summary of the B2 bucket with content
descriptions (not individual files), then uploads it to Google Drive.

Runs daily via GitHub Actions. Uses rclone for both B2 listing and Drive upload.

Requirements:
  - rclone configured with remotes: b2-okn, gdrive (or gdrive-shared)
  - Python 3.9+

Usage:
  python3 bucket-map.py
  python3 bucket-map.py --dry-run          # print map, don't upload
  python3 bucket-map.py --drive-folder "OKN Shared/Media Archive"
"""

import subprocess
import json
import sys
import os
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path

# ══════════════════════════════════════
# CONFIG
# ══════════════════════════════════════

B2_REMOTE = os.environ.get("B2_REMOTE", "b2-okn")
B2_BUCKET = os.environ.get("B2_BUCKET", "okn-media-archive")
GDRIVE_REMOTE = os.environ.get("GDRIVE_REMOTE_NAME", "gdrive")
GDRIVE_FOLDER = os.environ.get("GDRIVE_FOLDER", "OKN Media Archive")
MAP_FILENAME = "bucket-map.html"
LOCAL_DIR = Path.home() / ".okn" / "bucket-map"

# File type categories
CATEGORIES = {
    "image":    {"jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "heif",
                 "tiff", "tif", "bmp", "raw", "cr2", "arw", "nef", "dng"},
    "video":    {"mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v", "mts", "mxf"},
    "audio":    {"mp3", "wav", "aac", "flac", "ogg", "m4a", "wma", "aiff", "aif"},
    "document": {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md",
                 "csv", "rtf", "odt", "ods", "odp"},
    "design":   {"psd", "ai", "fig", "sketch", "xd", "eps", "indd", "afdesign",
                 "afphoto", "afpub"},
    "archive":  {"zip", "rar", "7z", "tar", "gz", "bz2", "xz", "dmg", "iso"},
    "project":  {"prproj", "drp", "fcpxml", "aep", "blend"},   # editing projects
}

def categorize(filename):
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    for cat, exts in CATEGORIES.items():
        if ext in exts:
            return cat, ext.upper()
    return "other", ext.upper() if ext else "?"


# ══════════════════════════════════════
# B2 LISTING (single rclone call)
# ══════════════════════════════════════

def list_bucket():
    """Fetch full recursive file listing from B2 as JSON. One API burst."""
    cmd = [
        "rclone", "lsjson", "-R",
        "--fast-list",
        "--no-modtime",         # skip extra HEAD calls — cheaper
        "--no-mimetype",
        f"{B2_REMOTE}:{B2_BUCKET}",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        print(f"ERROR: rclone lsjson failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout)


# ══════════════════════════════════════
# BUILD TREE
# ══════════════════════════════════════

def build_tree(entries):
    """
    Build a nested dict tree from the flat file listing.
    Each directory node holds:
      - children: {name: node}
      - files: defaultdict(list) of category → [ext, ...]
      - total_size: int
      - file_count: int
    """
    root = {"children": {}, "files": defaultdict(list), "total_size": 0, "file_count": 0}

    for entry in entries:
        if entry.get("IsDir"):
            # Ensure directory exists in tree
            _ensure_dir(root, entry["Path"])
            continue

        path = entry["Path"]
        size = entry.get("Size", 0)
        parts = path.split("/")
        filename = parts[-1]
        dir_parts = parts[:-1]

        # Navigate to parent dir
        node = root
        for p in dir_parts:
            if p not in node["children"]:
                node["children"][p] = {
                    "children": {}, "files": defaultdict(list),
                    "total_size": 0, "file_count": 0
                }
            node = node["children"][p]

        # Categorize file
        cat, ext = categorize(filename)
        node["files"][cat].append(ext)
        node["total_size"] += size
        node["file_count"] += 1

        # Propagate size up through root and all intermediate ancestors.
        # The direct parent (node) is already updated above; skip it by
        # iterating only dir_parts[:-1] (all but the last segment).
        if dir_parts:
            ancestor = root
            ancestor["total_size"] += size
            ancestor["file_count"] += 1
            for p in dir_parts[:-1]:
                ancestor = ancestor["children"][p]
                ancestor["total_size"] += size
                ancestor["file_count"] += 1

    return root

def _ensure_dir(root, path):
    parts = path.rstrip("/").split("/")
    node = root
    for p in parts:
        if p not in node["children"]:
            node["children"][p] = {
                "children": {}, "files": defaultdict(list),
                "total_size": 0, "file_count": 0
            }
        node = node["children"][p]


# ══════════════════════════════════════
# FORMAT OUTPUT
# ══════════════════════════════════════

def format_size(b):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f} {unit}" if unit != "B" else f"{b} B"
        b /= 1024
    return f"{b:.1f} PB"

def describe_contents(files_dict):
    """Generate a short description like '12 image files (JPG, PNG), 3 video files (MP4)'."""
    if not files_dict:
        return "empty"
    parts = []
    for cat in ("image", "video", "audio", "document", "design", "project", "archive", "other"):
        exts = files_dict.get(cat, [])
        if not exts:
            continue
        count = len(exts)
        unique_exts = sorted(set(exts))
        # Friendly category names
        label = {
            "image": "image", "video": "video", "audio": "audio",
            "document": "document", "design": "design", "project": "project",
            "archive": "archive", "other": "",
        }.get(cat, "")
        ext_str = ", ".join(unique_exts[:4])
        if len(unique_exts) > 4:
            ext_str += "…"
        noun = f"{label} file" if label else "file"
        if count != 1:
            noun += "s"
        parts.append(f"{count} {noun} ({ext_str})")
    return ", ".join(parts)



def generate_map(tree):
    """Generate a styled HTML document in the OKN Studio / Signal Studio aesthetic."""
    now = datetime.now(timezone.utc).strftime("%a %d %b %Y · %H:%M UTC")
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    total_files = tree["file_count"]
    total_size = format_size(tree["total_size"])
    top_folders = len(tree['children'])
    tree_html = render_tree_html(tree)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Bucket Map — OKN Media Archive</title>
<meta name="theme-color" content="#0a0f14">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
:root{{
  --bg:#0a0f14;--bg-2:#0e141b;--bg-3:#121821;--bg-4:#1a2230;
  --signal:#5eead4;--signal-bright:#a7f3d0;--signal-dim:rgba(94,234,212,0.12);
  --info:#60a5fa;--warn:#fbbf24;--danger:#f87171;--purple:#a78bfa;
  --text:#e8edf2;--text-dim:rgba(232,237,242,0.55);
  --text-faint:rgba(232,237,242,0.32);--text-ghost:rgba(232,237,242,0.18);
  --line:rgba(255,255,255,0.06);--line-2:rgba(255,255,255,0.1);
  --line-signal:rgba(94,234,212,0.25);
  --surface:rgba(255,255,255,0.025);--surface-2:rgba(255,255,255,0.05);
}}
html{{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}}
body{{font-family:'IBM Plex Sans',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:56px 32px;line-height:1.5}}
body::before{{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,0.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.012) 1px,transparent 1px);background-size:48px 48px;pointer-events:none;z-index:0;mask-image:radial-gradient(ellipse at center,black 30%,transparent 85%)}}
body::after{{content:'';position:fixed;top:-300px;right:-300px;width:800px;height:800px;background:radial-gradient(circle,rgba(94,234,212,0.05) 0%,transparent 60%);pointer-events:none;z-index:0}}

.wrap{{position:relative;z-index:1;max-width:1000px;margin:0 auto}}

/* Header */
.hdr{{display:flex;align-items:center;justify-content:space-between;padding-bottom:20px;margin-bottom:32px;border-bottom:1px solid var(--line);font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim)}}
.brand{{display:flex;align-items:center;gap:10px;color:var(--text)}}
.brand svg{{width:20px;height:20px}}
.brand .slash{{color:var(--text-ghost)}}
.brand .studio{{color:var(--signal)}}
.hdr-right{{display:flex;align-items:center;gap:14px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-faint)}}
.hdr-right .live{{color:var(--signal);display:flex;align-items:center;gap:8px}}
.hdr-right .live .dot{{width:6px;height:6px;border-radius:50%;background:var(--signal);box-shadow:0 0 8px var(--signal)}}

/* Title */
.title-block{{margin-bottom:48px}}
.kicker{{display:inline-flex;align-items:center;gap:10px;padding:5px 12px;border:1px solid var(--line-signal);background:var(--signal-dim);border-radius:3px;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--signal);margin-bottom:20px}}
.kicker .dot{{width:5px;height:5px;border-radius:50%;background:var(--signal);box-shadow:0 0 6px var(--signal)}}
h1{{font-family:'Sora',sans-serif;font-size:clamp(36px,5vw,56px);font-weight:400;letter-spacing:-0.03em;line-height:1;color:var(--text);margin-bottom:16px}}
h1 .accent{{color:var(--signal);font-weight:500}}
.date{{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-faint);letter-spacing:0.08em;display:flex;align-items:center;gap:10px}}
.date::before{{content:'';width:24px;height:1px;background:var(--signal)}}

/* Stats grid */
.stats{{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-bottom:40px}}
.stat{{padding:28px 24px;background:var(--bg-2);position:relative}}
.stat::before{{content:'';position:absolute;top:0;left:0;width:18px;height:18px;border-top:1px solid var(--signal);border-left:1px solid var(--signal);opacity:0.4}}
.stat-label{{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:0.2em;color:var(--text-faint);text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:8px}}
.stat-label .idx{{color:var(--signal)}}
.stat-value{{font-family:'Sora',sans-serif;font-size:40px;font-weight:400;color:var(--text);line-height:1;letter-spacing:-0.03em}}
.stat-value .unit{{color:var(--signal);font-size:0.3em;font-family:'IBM Plex Mono',monospace;font-weight:500;letter-spacing:0.16em;margin-left:6px;text-transform:uppercase;vertical-align:super}}

/* Tree panel */
.tree-panel{{background:var(--bg-2);border:1px solid var(--line);border-radius:6px;overflow:hidden;position:relative}}
.tree-panel::before{{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--signal),transparent)}}
.tree-head{{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--line);background:var(--bg-3);font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:0.15em;text-transform:uppercase}}
.tree-head-left{{color:var(--signal);display:flex;align-items:center;gap:10px}}
.tree-head-left::before{{content:'■';font-size:10px}}
.tree-head-right{{color:var(--text-faint)}}
.tree-body{{padding:24px 28px}}

/* Folder list */
.folder-list{{list-style:none;padding:0;margin:0}}
.folder-item{{padding:2px 0}}
.folder-row{{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:3px;transition:background 0.15s}}
.folder-row:hover{{background:var(--surface-2)}}
.folder-icon{{flex-shrink:0;width:14px;height:14px;display:flex;align-items:center;justify-content:center;color:var(--signal);font-family:'IBM Plex Mono',monospace;font-size:8px;line-height:1}}
.folder-icon-branch{{color:var(--signal)}}
.folder-icon-leaf{{color:var(--text-faint)}}
.folder-name{{font-family:'IBM Plex Sans',sans-serif;font-size:14px;font-weight:500;color:var(--text);letter-spacing:-0.005em}}
.folder-name-slash{{color:var(--text-ghost);font-weight:400}}
.folder-desc{{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-faint);margin-left:8px;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;letter-spacing:0.02em}}
.folder-desc .also{{color:var(--text-ghost);text-transform:uppercase;letter-spacing:0.12em;font-size:9px;margin-right:4px}}
.folder-size{{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--signal);margin-left:auto;flex-shrink:0;padding-left:12px;letter-spacing:0.04em;opacity:0.85}}
.children{{padding-left:28px;margin-left:7px;border-left:1px dashed var(--line)}}

/* Type badges */
.type-badge{{display:inline-flex;align-items:center;padding:2px 7px;border-radius:2px;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;border:1px solid transparent}}
.type-image{{background:rgba(96,165,250,0.1);color:var(--info);border-color:rgba(96,165,250,0.2)}}
.type-video{{background:rgba(248,113,113,0.08);color:var(--danger);border-color:rgba(248,113,113,0.2)}}
.type-audio{{background:rgba(167,139,250,0.08);color:var(--purple);border-color:rgba(167,139,250,0.2)}}
.type-document{{background:rgba(94,234,212,0.08);color:var(--signal);border-color:rgba(94,234,212,0.2)}}
.type-design{{background:rgba(251,191,36,0.08);color:var(--warn);border-color:rgba(251,191,36,0.25)}}
.type-project{{background:rgba(251,146,60,0.08);color:#fb923c;border-color:rgba(251,146,60,0.25)}}
.type-archive{{background:rgba(160,160,160,0.08);color:#999;border-color:rgba(160,160,160,0.15)}}
.type-other{{background:rgba(160,160,160,0.05);color:#888;border-color:rgba(160,160,160,0.1)}}
.count{{color:var(--text-dim);letter-spacing:0.04em}}

.empty-note{{text-align:center;padding:60px 20px}}
.empty-note-mark{{font-family:'IBM Plex Mono',monospace;font-size:48px;color:var(--signal);opacity:0.3;line-height:1;margin-bottom:20px;letter-spacing:-0.04em}}
.empty-note h3{{font-family:'Sora',sans-serif;font-size:22px;font-weight:400;color:var(--text);letter-spacing:-0.015em;margin-bottom:8px}}
.empty-note p{{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-faint);letter-spacing:0.1em;text-transform:uppercase}}

/* Colophon */
.colophon{{margin-top:40px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:0.14em;color:var(--text-faint);text-transform:uppercase;flex-wrap:wrap;gap:12px}}
.colophon a{{color:var(--signal);text-decoration:none}}
.colophon a:hover{{color:var(--signal-bright)}}

@media(max-width:700px){{
  body{{padding:24px 16px}}
  .stats{{grid-template-columns:1fr}}
  .tree-body{{padding:16px}}
  .children{{padding-left:18px;margin-left:3px}}
  .folder-row{{flex-wrap:wrap}}
  .folder-size{{margin-left:22px;padding-left:0;width:100%;margin-top:2px}}
  .colophon{{flex-direction:column;text-align:center}}
  h1{{font-size:32px}}
}}
</style>
</head>
<body>
<div class="wrap">

  <div class="hdr">
    <div class="brand">
      <svg viewBox="0 0 32 32" fill="none" stroke="#5eead4" stroke-width="1.5">
        <line x1="16" y1="4" x2="16" y2="12"/><line x1="16" y1="20" x2="16" y2="28"/>
        <line x1="4" y1="16" x2="12" y2="16"/><line x1="20" y1="16" x2="28" y2="16"/>
        <circle cx="16" cy="4" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="16" cy="28" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="4" cy="16" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="28" cy="16" r="2" fill="#5eead4" stroke="none"/>
        <circle cx="16" cy="16" r="3" fill="#5eead4" stroke="none"/>
      </svg>
      <span>OKN<span class="slash">/</span><span class="studio">Studio</span></span>
    </div>
    <div class="hdr-right">
      <span class="live"><span class="dot"></span>SNAPSHOT {now_iso}</span>
    </div>
  </div>

  <div class="title-block">
    <div class="kicker"><span class="dot"></span>Bucket Map · Auto-generated</div>
    <h1>Media <span class="accent">Archive</span></h1>
    <div class="date">{now}</div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-label"><span class="idx">01</span>Files</div>
      <div class="stat-value">{total_files}<span class="unit">total</span></div>
    </div>
    <div class="stat">
      <div class="stat-label"><span class="idx">02</span>Volume</div>
      <div class="stat-value">{total_size}</div>
    </div>
    <div class="stat">
      <div class="stat-label"><span class="idx">03</span>Root Folders</div>
      <div class="stat-value">{top_folders}<span class="unit">top</span></div>
    </div>
  </div>

  <div class="tree-panel">
    <div class="tree-head">
      <span class="tree-head-left">Directory Tree</span>
      <span class="tree-head-right">Bucket · {B2_BUCKET}</span>
    </div>
    <div class="tree-body">
      {tree_html if tree['children'] else '<div class="empty-note"><div class="empty-note-mark">∅</div><h3>Empty bucket</h3><p>Upload media via Cyberduck or rclone</p></div>'}
    </div>
  </div>

  <div class="colophon">
    <span>Auto-generated daily · OKN Studio</span>
    <span>built by <a href="https://cybersystema.com" target="_blank">CyberSystema</a></span>
  </div>

</div>
</body>
</html>"""


def render_tree_html(node, depth=0):
    """Recursively render the tree as nested HTML lists (Signal Studio style)."""
    if not node["children"]:
        return ""

    items = []
    for name in sorted(node["children"].keys()):
        child = node["children"][name]
        desc = describe_contents_html(child["files"])
        size_str = format_size(child["total_size"]) if child["total_size"] > 0 else ""
        children_html = render_tree_html(child, depth + 1)

        has_children = bool(child["children"])
        # Network-node glyph: filled circle for branch (has subfolders), hollow for leaf
        if has_children:
            icon = '<span class="folder-icon folder-icon-branch">●</span>'
        else:
            icon = '<span class="folder-icon folder-icon-leaf">○</span>'

        detail = ""
        if child["files"] and not has_children:
            detail = f'<span class="folder-desc">{desc}</span>'
        elif child["files"] and has_children:
            detail = f'<span class="folder-desc"><span class="also">also</span>{desc}</span>'

        size_html = f'<span class="folder-size">{size_str}</span>' if size_str else ""

        items.append(
            f'<li class="folder-item">'
            f'<div class="folder-row">'
            f'{icon}'
            f'<span class="folder-name">{html_escape(name)}<span class="folder-name-slash">/</span></span>'
            f'{detail}{size_html}'
            f'</div>'
            f'{f"<div class=children>{children_html}</div>" if children_html else ""}'
            f'</li>'
        )

    joined = "\n".join(items)
    return f'<ul class="folder-list">{joined}</ul>'


def describe_contents_html(files_dict):
    """Generate HTML badges for content types."""
    if not files_dict:
        return "empty"
    parts = []
    for cat in ("image", "video", "audio", "document", "design", "project", "archive", "other"):
        exts = files_dict.get(cat, [])
        if not exts:
            continue
        count = len(exts)
        unique_exts = sorted(set(exts))
        ext_str = ", ".join(unique_exts[:3])
        if len(unique_exts) > 3:
            ext_str += "\u2026"
        label = cat if cat != "other" else "file"
        noun = label + ("s" if count != 1 else "")
        parts.append(
            f'<span class="type-badge type-{cat}">{cat}</span>'
            f'<span class="count">{count} {noun} ({ext_str})</span>'
        )
    return " &nbsp;".join(parts)


def html_escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ══════════════════════════════════════
# UPLOAD TO GOOGLE DRIVE
# ══════════════════════════════════════

def upload_to_drive(local_path, drive_folder):
    """Upload the map file to the specified Google Drive folder."""
    dest = f"{GDRIVE_REMOTE}:{drive_folder}"
    cmd = [
        "rclone", "copy",
        str(local_path),
        dest,
        "--include", MAP_FILENAME,
    ]
    # rclone copy needs the parent directory, not the file itself
    cmd_dir = [
        "rclone", "copyto",
        str(local_path),
        f"{dest}/{MAP_FILENAME}",
    ]
    result = subprocess.run(cmd_dir, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        print(f"ERROR: Drive upload failed:\n{result.stderr}", file=sys.stderr)
        return False
    return True


# ══════════════════════════════════════
# MAIN
# ══════════════════════════════════════

def main():
    dry_run = "--dry-run" in sys.argv

    # Override drive folder from CLI
    drive_folder = GDRIVE_FOLDER
    for i, arg in enumerate(sys.argv):
        if arg == "--drive-folder" and i + 1 < len(sys.argv):
            drive_folder = sys.argv[i + 1]

    # Override remotes from CLI
    global GDRIVE_REMOTE
    for i, arg in enumerate(sys.argv):
        if arg == "--gdrive-remote" and i + 1 < len(sys.argv):
            GDRIVE_REMOTE = sys.argv[i + 1]

    print(f"📂 Listing bucket: {B2_REMOTE}:{B2_BUCKET}")
    entries = list_bucket()
    print(f"   Found {len(entries)} entries")

    print("🌳 Building tree...")
    tree = build_tree(entries)

    print("📝 Generating map...")
    map_content = generate_map(tree)

    if dry_run:
        print("\n" + map_content)
        print("\n✅ Dry run complete (not uploaded)")
        return

    # Save locally
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    local_file = LOCAL_DIR / MAP_FILENAME
    local_file.write_text(map_content, encoding="utf-8")
    print(f"💾 Saved to {local_file}")

    # Upload to Google Drive
    print(f"☁️  Uploading to {GDRIVE_REMOTE}:{drive_folder}/{MAP_FILENAME}")
    success = upload_to_drive(local_file, drive_folder)
    if success:
        print("✅ Done — bucket map uploaded to Google Drive")
    else:
        print("❌ Upload failed", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
