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

        # Propagate size up to root
        ancestor = root
        ancestor["total_size"] += size
        ancestor["file_count"] += 1
        for p in dir_parts:
            ancestor = ancestor["children"][p]

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
    """Generate a styled HTML document."""
    now = datetime.now(timezone.utc).strftime("%A, %d %B %Y · %H:%M UTC")
    total_files = tree["file_count"]
    total_size = format_size(tree["total_size"])

    tree_html = render_tree_html(tree)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>OKN Media Archive — Bucket Map</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#0f2137;color:#e2e8f0;min-height:100vh;padding:40px 24px}}
.container{{max-width:800px;margin:0 auto}}
.header{{text-align:center;margin-bottom:40px}}
.header h1{{font-size:28px;font-weight:700;color:white;margin-bottom:4px}}
.header h1 span{{color:#c4953a}}
.divider{{width:50px;height:2px;background:linear-gradient(90deg,transparent,#c4953a,transparent);margin:14px auto}}
.stats{{display:flex;justify-content:center;gap:24px;margin-top:16px}}
.stat{{text-align:center}}
.stat-value{{font-size:22px;font-weight:700;color:#c4953a}}
.stat-label{{font-size:11px;color:#7a8ba3;text-transform:uppercase;letter-spacing:1px;margin-top:2px}}
.date{{font-size:12px;color:#506580;margin-top:16px}}
.tree{{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:28px 24px;margin-top:32px}}
.tree-title{{font-size:13px;color:#506580;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:16px;font-weight:600}}
.folder{{margin:0;padding:0}}
.folder-item{{list-style:none;padding:4px 0}}
.folder-row{{display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-radius:6px;transition:background 0.15s}}
.folder-row:hover{{background:rgba(255,255,255,0.04)}}
.folder-icon{{flex-shrink:0;font-size:15px}}
.folder-name{{font-weight:600;color:#e2e8f0;font-size:14px}}
.folder-desc{{color:#506580;font-size:12px;margin-left:4px}}
.folder-desc .count{{color:#7a8ba3}}
.folder-desc .type-badge{{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;margin-right:2px}}
.type-image{{background:rgba(99,179,237,0.12);color:#63b3ed}}
.type-video{{background:rgba(237,100,166,0.12);color:#ed64a6}}
.type-audio{{background:rgba(154,130,237,0.12);color:#9a82ed}}
.type-document{{background:rgba(72,187,120,0.12);color:#48bb78}}
.type-design{{background:rgba(237,179,64,0.12);color:#edb340}}
.type-project{{background:rgba(237,137,54,0.12);color:#ed8936}}
.type-archive{{background:rgba(160,160,160,0.1);color:#a0a0a0}}
.type-other{{background:rgba(160,160,160,0.08);color:#888}}
.folder-size{{color:#3d5068;font-size:11px;margin-left:auto;flex-shrink:0;padding-left:12px}}
.children{{padding-left:20px;border-left:1px solid rgba(255,255,255,0.05);margin-left:11px}}
.footer{{text-align:center;margin-top:32px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.05);font-size:11px;color:#3d5068}}
.footer a{{color:#506580;text-decoration:none}}
.empty-note{{color:#3d5068;font-size:13px;font-style:italic;padding:20px;text-align:center}}
@media(max-width:600px){{body{{padding:20px 12px}}.tree{{padding:16px 12px}}.children{{padding-left:14px;margin-left:8px}}}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>\u2626 <span>OKN</span> Media Archive</h1>
    <div class="divider"></div>
    <div class="stats">
      <div class="stat">
        <div class="stat-value">{total_files}</div>
        <div class="stat-label">Files</div>
      </div>
      <div class="stat">
        <div class="stat-value">{total_size}</div>
        <div class="stat-label">Total Size</div>
      </div>
      <div class="stat">
        <div class="stat-value">{len(tree['children'])}</div>
        <div class="stat-label">Top Folders</div>
      </div>
    </div>
    <div class="date">{now}</div>
  </div>

  <div class="tree">
    <div class="tree-title">Directory Structure</div>
    {tree_html if tree['children'] else '<div class="empty-note">Bucket is empty — upload media via Cyberduck or rclone.</div>'}
  </div>

  <div class="footer">
    Auto-generated daily by <a href="https://github.com/CyberSystema/oknstudio">OKN Studio</a> · Do not edit manually
  </div>
</div>
</body>
</html>"""


def render_tree_html(node, depth=0):
    """Recursively render the tree as nested HTML lists."""
    if not node["children"]:
        return ""

    items = []
    for name in sorted(node["children"].keys()):
        child = node["children"][name]
        desc = describe_contents_html(child["files"])
        size_str = format_size(child["total_size"]) if child["total_size"] > 0 else ""
        children_html = render_tree_html(child, depth + 1)

        has_children = bool(child["children"])
        icon = "\U0001F4C2" if has_children else "\U0001F4C1"

        detail = ""
        if child["files"] and not has_children:
            detail = f'<span class="folder-desc">— {desc}</span>'
        elif child["files"] and has_children:
            detail = f'<span class="folder-desc">— also: {desc}</span>'

        size_html = f'<span class="folder-size">{size_str}</span>' if size_str else ""

        items.append(
            f'<li class="folder-item">'
            f'<div class="folder-row">'
            f'<span class="folder-icon">{icon}</span>'
            f'<span class="folder-name">{html_escape(name)}/</span>'
            f'{detail}{size_html}'
            f'</div>'
            f'{f"<div class=children>{children_html}</div>" if children_html else ""}'
            f'</li>'
        )

    joined = "\n".join(items)
    return f'<ul class="folder">{joined}</ul>'


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
