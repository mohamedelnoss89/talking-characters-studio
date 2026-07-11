#!/usr/bin/env python3
"""Surgically remove handleGenerateAI and handleDownload from page.tsx"""
from pathlib import Path

p = Path("/home/z/my-project/src/app/page.tsx")
lines = p.read_text(encoding="utf-8").splitlines(keepends=True)

# Find start: "  // === توليد الفيديو ==="
start_idx = None
for i, line in enumerate(lines):
    if "توليد الفيديو" in line and line.strip().startswith("//"):
        start_idx = i
        break

if start_idx is None:
    raise SystemExit("Could not find start marker")

# Find end: the line right before "  // تنزيل صورة الشخصية المولّدة بالـ AI"
end_idx = None
for i in range(start_idx + 1, len(lines)):
    if "تنزيل صورة الشخصية المولّدة" in lines[i] and lines[i].strip().startswith("//"):
        end_idx = i  # we keep this line; delete [start_idx, end_idx)
        break

if end_idx is None:
    raise SystemExit("Could not find end marker")

print(f"Deleting lines {start_idx+1}..{end_idx} (0-indexed: [{start_idx}:{end_idx}])")
print(f"First line to delete: {lines[start_idx].rstrip()!r}")
print(f"Last  line to delete: {lines[end_idx-1].rstrip()!r}")
print(f"Line after (kept):    {lines[end_idx].rstrip()!r}")

replacement = [
    "  // === توليد الفيديو تم إلغاؤه ===\n",
    "  // محرّك Wav2Lip لتحريك الشفاه تم إزالته من التطبيق.\n",
    "  // الميزات المتبقية: توليد الشخصيات بالـ AI، تعديل الصور بالـ AI، ومعاينة TTS.\n",
    "\n",
]

new_lines = lines[:start_idx] + replacement + lines[end_idx:]
p.write_text("".join(new_lines), encoding="utf-8")
print(f"Done. New file has {len(new_lines)} lines (was {len(lines)}).")
